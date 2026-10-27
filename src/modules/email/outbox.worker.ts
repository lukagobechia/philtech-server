import type { DataSource } from "typeorm";
import { logger } from "../../config/logger.js";
import { AuditOutcome } from "../../entities/audit-log.entity.js";
import { EmailOutboxStatus, type EmailOutbox } from "../../entities/email-outbox.entity.js";
import { decryptJson } from "../../lib/field-encryption.js";
import { getMailer, type MailAttachment } from "../../lib/mailer.js";
import { getStorage } from "../../lib/storage.js";
import { auditedJob, recordAudit } from "../audit/audit.service.js";
import { templates } from "./templates.js";

const MAX_ATTEMPTS = 8;

type StoredAttachment = { key: string; fileName: string; mimeType: string };

/** Loads files referenced by the payload from storage. Files deleted since queueing are skipped. */
async function loadAttachments(payload: Record<string, unknown>): Promise<MailAttachment[]> {
    const stored = Array.isArray(payload.attachments) ? (payload.attachments as StoredAttachment[]) : [];
    const loaded: MailAttachment[] = [];
    for (const file of stored) {
        try {
            loaded.push({ filename: file.fileName, content: await getStorage().get(file.key), contentType: file.mimeType });
        } catch (error) {
            logger.warn({ err: error, key: file.key }, "Email attachment missing, sending without it");
        }
    }
    return loaded;
}
const BATCH_SIZE = 10;
const LEASE_MINUTES = 5;

/**
 * Claims due emails by pushing their next attempt into the future (a lease), so several
 * API instances can run the worker without sending duplicates, then sends them.
 */
export async function processOutboxBatch(dataSource: DataSource): Promise<number> {
    const claimed: EmailOutbox[] = await dataSource.query(
        `UPDATE email_outbox SET "nextAttemptAt" = now() + interval '${LEASE_MINUTES} minutes', attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM email_outbox
           WHERE status = $1 AND "nextAttemptAt" <= now()
           ORDER BY "nextAttemptAt"
           LIMIT ${BATCH_SIZE}
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [EmailOutboxStatus.PENDING],
    ).then(([rows]: [(Omit<EmailOutbox, "to" | "payload"> & { to: string; payload: string })[]]) =>
        // Raw rows skip the column transformers, so recipients and payload are still encrypted here.
        rows.map((row) => ({ ...row, to: decryptJson<string[]>(row.to), payload: decryptJson<Record<string, unknown>>(row.payload) })),
    );

    for (const email of claimed) {
        try {
            const render = templates[email.template];
            if (!render) throw new Error(`Unknown email template "${email.template}"`);

            const attachments = await loadAttachments(email.payload);
            await getMailer().send({ to: email.to, ...render(email.payload), ...(attachments.length ? { attachments } : {}) });
            await dataSource.query(
                `UPDATE email_outbox SET status = $2, "sentAt" = now(), "lastError" = NULL, "updatedAt" = now() WHERE id = $1`,
                [email.id, EmailOutboxStatus.SENT],
            );
            await recordAudit({ action: "email.sent", entityType: "email", entityId: email.id, summary: `Sent ${email.template} email`, data: { template: email.template, to: email.to, attempt: email.attempts, attachments: attachments.length } });
        } catch (error) {
            const failed = email.attempts >= MAX_ATTEMPTS;
            const backoffSeconds = Math.min(2 ** email.attempts * 30, 6 * 3600);
            logger.warn({ err: error, emailId: email.id, attempts: email.attempts }, "Email send failed");
            await dataSource.query(
                `UPDATE email_outbox SET status = $2, "lastError" = $3, "nextAttemptAt" = now() + make_interval(secs => $4), "updatedAt" = now() WHERE id = $1`,
                [email.id, failed ? EmailOutboxStatus.FAILED : EmailOutboxStatus.PENDING, String(error).slice(0, 2000), backoffSeconds],
            );
            await recordAudit({
                action: failed ? "email.failed" : "email.retry_scheduled",
                outcome: AuditOutcome.FAILURE,
                entityType: "email",
                entityId: email.id,
                summary: `${failed ? "Gave up on" : "Will retry"} ${email.template} email: ${String(error).slice(0, 200)}`,
                data: { template: email.template, to: email.to, attempt: email.attempts, error: String(error) },
            });
        }
    }

    return claimed.length;
}

export function startOutboxWorker(dataSource: DataSource, intervalMs = 10_000): () => Promise<void> {
    let stopped = false;
    let running: Promise<unknown> = Promise.resolve();

    const tick = async () => {
        if (stopped) return;
        running = auditedJob("email_outbox", async () => {
            const processed = await processOutboxBatch(dataSource);
            return { didWork: processed > 0, summary: `Processed ${processed} emails`, data: { processed } };
        });
        await running;
        if (!stopped) timer = setTimeout(tick, intervalMs);
    };

    let timer = setTimeout(tick, 1000);

    return async () => {
        stopped = true;
        clearTimeout(timer);
        await running;
    };
}
