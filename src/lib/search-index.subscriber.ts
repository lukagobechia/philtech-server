import { EventSubscriber, type EntitySubscriberInterface, type InsertEvent, type ObjectLiteral, type UpdateEvent } from "typeorm";
import { CallBooking } from "../entities/call-booking.entity.js";
import { ContactMessage } from "../entities/contact-message.entity.js";
import { Employee } from "../entities/employee.entity.js";
import { JobApplication } from "../entities/job-application.entity.js";
import { lookupHash, searchIndexTerms } from "./field-encryption.js";

type Indexed = {
    // Searchable by word prefix (names, emails).
    prefixed: string[];
    // Searchable by whole word (long text).
    whole?: string[];
    // Hash column -> encrypted field it is computed from, for exact lookups.
    lookups?: Record<string, string>;
};

/** Entities with encrypted fields that admins search; each has a `searchIndex` column. */
const INDEXED = new Map<unknown, Indexed>([
    [JobApplication, { prefixed: ["firstName", "lastName", "email"] }],
    [ContactMessage, { prefixed: ["name", "email", "company"], whole: ["message"] }],
    [CallBooking, { prefixed: ["name", "email"], whole: ["notes"] }],
    [Employee, { prefixed: ["firstName", "lastName", "email"], lookups: { emailHash: "email" } }],
]);

/** Recomputes the blind index whenever the plaintext it is built from is written. */
// The decorator is required: TypeORM ignores subscriber classes without it.
@EventSubscriber()
export class SearchIndexSubscriber implements EntitySubscriberInterface {
    beforeInsert(event: InsertEvent<ObjectLiteral>) {
        if (event.entity) applyIndex(event.metadata.target, event.entity, event.entity, false);
    }

    beforeUpdate(event: UpdateEvent<ObjectLiteral>) {
        if (event.entity) applyIndex(event.metadata.target, event.entity, { ...event.databaseEntity, ...event.entity }, true);
    }
}

function applyIndex(target: unknown, changes: ObjectLiteral, row: ObjectLiteral, isUpdate: boolean) {
    const config = INDEXED.get(target);
    if (!config) return;
    const lookups = Object.entries(config.lookups ?? {});
    const fields = [...config.prefixed, ...(config.whole ?? []), ...lookups.map(([, field]) => field)];
    if (isUpdate) {
        if (!fields.some((field) => field in changes)) return;
        // repository.update() only sees the changed columns, not enough to rebuild the index.
        const missing = fields.filter((field) => row[field] === undefined);
        if (missing.length) throw new Error(`Updating searchable fields needs the whole row (use save); missing: ${missing.join(", ")}`);
    }
    changes.searchIndex = searchIndexTerms(
        config.prefixed.map((field) => row[field]),
        (config.whole ?? []).map((field) => row[field]),
    );
    for (const [column, field] of lookups) changes[column] = lookupHash(row[field]);
}
