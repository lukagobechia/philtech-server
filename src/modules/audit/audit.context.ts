import { AsyncLocalStorage } from "node:async_hooks";
import { AuditActorType } from "../../entities/audit-log.entity.js";

export type AuditActor = { type: AuditActorType; id: string | null; email: string | null; role: string | null };

export type AuditContext = {
    actor: AuditActor;
    requestId: string | null;
    ipHash: string | null;
    userAgent: string | null;
    // Name of the background job, for system actions.
    job?: string;
};

const storage = new AsyncLocalStorage<AuditContext>();

export const SYSTEM_ACTOR: AuditActor = { type: AuditActorType.SYSTEM, id: null, email: null, role: null };
const PUBLIC_ACTOR: AuditActor = { type: AuditActorType.PUBLIC, id: null, email: null, role: null };

export const currentAuditContext = (): AuditContext =>
    storage.getStore() ?? { actor: SYSTEM_ACTOR, requestId: null, ipHash: null, userAgent: null };

/** Runs a request handler chain with its own context; the actor becomes the admin once signed in. */
export function runInRequestContext<T>(context: Omit<AuditContext, "actor">, fn: () => T): T {
    return storage.run({ ...context, actor: { ...PUBLIC_ACTOR } }, fn);
}

/** Marks the current request as performed by this admin (called after the session is verified). */
export function setAuditActor(actor: { id: string; email: string; role: string }) {
    const context = storage.getStore();
    if (context) context.actor = { type: AuditActorType.ADMIN, ...actor };
}

/** Runs background work as the system, so everything it records names the job. */
export function runAsSystem<T>(job: string, fn: () => T): T {
    return storage.run({ actor: SYSTEM_ACTOR, requestId: null, ipHash: null, userAgent: null, job }, fn);
}
