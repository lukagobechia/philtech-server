import { LessThan } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { EmailOutbox, EmailOutboxStatus } from "../../entities/email-outbox.entity.js";
import { JobApplication } from "../../entities/job-application.entity.js";
import { getStorage } from "../../lib/storage.js";
import { purgeExpiredSessions } from "../auth/sessions.js";
import { AuditLog } from "../../entities/audit-log.entity.js";
import { auditedJob } from "../audit/audit.service.js";
import { deleteInterviewFiles } from "../interviews/interviews.service.js";

const DAY_MS = 86400_000;

/** Deletes personal data past its retention period: old applications (with CVs), expired sessions, sent emails, old audit entries. */
export async function runRetention(now = new Date()) {
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - env.RETENTION_MONTHS);

    const repository = AppDataSource.getRepository(JobApplication);
    const expired = await repository.find({ where: { createdAt: LessThan(cutoff) }, select: { id: true, resumeKey: true }, take: 500 });
    await deleteInterviewFiles(expired.map((application) => application.id));
    for (const application of expired) {
        await getStorage().delete(application.resumeKey);
        await repository.delete(application.id);
    }

    const sessions = await purgeExpiredSessions();
    // Email payloads contain personal data, so sent ones are kept only briefly.
    const emails = await AppDataSource.getRepository(EmailOutbox).delete({
        status: EmailOutboxStatus.SENT,
        sentAt: LessThan(new Date(now.getTime() - 30 * DAY_MS)),
    });

    // Audit entries have their own, longer retention.
    const auditLogs = await AppDataSource.getRepository(AuditLog).delete({
        createdAt: LessThan(new Date(now.getTime() - env.AUDIT_RETENTION_DAYS * DAY_MS)),
    });

    const result = { applications: expired.length, applicationIds: expired.map((application) => application.id), sessions, emails: emails.affected ?? 0, auditLogs: auditLogs.affected ?? 0 };
    logger.info(result, "Retention run finished");
    return result;
}

export function startRetentionJob(intervalMs = DAY_MS): () => void {
    // Runs once a day, so every run is recorded, including ones that deleted nothing.
    const run = () =>
        auditedJob("retention", async () => {
            const result = await runRetention();
            return { summary: `Deleted ${result.applications} applications, ${result.sessions} sessions, ${result.emails} emails, ${result.auditLogs} audit entries`, data: result };
        });
    const initial = setTimeout(run, 60_000);
    const timer = setInterval(run, intervalMs);
    return () => {
        clearTimeout(initial);
        clearInterval(timer);
    };
}
