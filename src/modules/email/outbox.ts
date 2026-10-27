import type { EntityManager } from "typeorm";
import type { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity.js";
import { env } from "../../config/env.js";
import { EmailOutbox } from "../../entities/email-outbox.entity.js";

type Enqueue = { to: string[]; template: string; payload: Record<string, unknown> };

/** Queues emails inside the caller's transaction so they are sent only if the submission commits. */
export async function enqueueEmails(manager: EntityManager, emails: Enqueue[]): Promise<void> {
    const rows = emails.filter((email) => email.to.length > 0);
    if (rows.length) {
        await manager.getRepository(EmailOutbox).insert(rows as QueryDeepPartialEntity<EmailOutbox>[]);
    }
}

/** Internal team notification plus a confirmation to the submitter. */
export function notificationPair(kind: "contact" | "booking" | "application", submitterEmail: string, payload: Record<string, unknown>): Enqueue[] {
    return [
        { to: env.NOTIFY_EMAIL_TO, template: `${kind}_internal`, payload },
        { to: [submitterEmail], template: `${kind}_confirmation`, payload },
    ];
}
