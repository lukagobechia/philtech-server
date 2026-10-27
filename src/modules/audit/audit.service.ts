import express, { type Request, type RequestHandler } from "express";
import type { EntityManager } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AuditCategory, AuditLog, AuditOutcome } from "../../entities/audit-log.entity.js";
import { hashIp } from "../../lib/crypto.js";
import { currentAuditContext, runAsSystem, runInRequestContext } from "./audit.context.js";

export type AuditEvent = {
    // "<entity>.<verb>", e.g. "job.published".
    action: string;
    entityType?: string;
    entityId?: string | null;
    summary?: string;
    data?: Record<string, unknown>;
    outcome?: AuditOutcome;
    category?: AuditCategory;
};

const SECRET_KEY = /pass(word)?|token|secret|cookie|authorization|session/i;
const MAX_STRING = 2000;

/** JSON-safe copy with secrets redacted and long values cut, so audit rows stay small and harmless. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return value ?? null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    if (typeof value !== "object") return value;
    if (depth > 5) return "[nested]";
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForAudit(item, depth + 1));
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : sanitizeForAudit(item, depth + 1)]),
    );
}

function toRow(event: AuditEvent): Partial<AuditLog> {
    const context = currentAuditContext();
    return {
        category: event.category ?? (context.job ? AuditCategory.JOB : AuditCategory.EVENT),
        action: event.action.slice(0, 100),
        outcome: event.outcome ?? AuditOutcome.SUCCESS,
        actorType: context.actor.type,
        actorId: context.actor.id,
        actorEmail: context.actor.email,
        actorRole: context.actor.role,
        entityType: event.entityType ?? null,
        entityId: event.entityId ? String(event.entityId).slice(0, 64) : null,
        summary: event.summary?.slice(0, 500) ?? null,
        data: sanitizeForAudit({ ...(context.job ? { job: context.job } : {}), ...event.data }) as Record<string, unknown>,
        requestId: context.requestId,
        ipHash: context.ipHash,
        userAgent: context.userAgent,
    };
}

/**
 * Records who did what. With a transaction manager the entry commits or rolls back with the change itself;
 * without one it is written on its own and a failure is logged, never thrown at the caller.
 */
export async function recordAudit(event: AuditEvent, manager?: EntityManager): Promise<void> {
    if (manager) {
        await manager.getRepository(AuditLog).insert(toRow(event) as never);
        return;
    }
    try {
        await AppDataSource.getRepository(AuditLog).insert(toRow(event) as never);
    } catch (error) {
        logger.error({ err: error, action: event.action }, "Failed to write audit log");
    }
}

export type JobResult = { summary?: string; data?: Record<string, unknown>; didWork?: boolean } | void;

/**
 * Runs a background job as the system and records the run: always on failure, and on success when it did
 * something (or always with AUDIT_IDLE_JOB_RUNS), so a 30-second scheduler doesn't fill the log with no-ops.
 */
export async function auditedJob(job: string, fn: () => Promise<JobResult>): Promise<void> {
    await runAsSystem(job, async () => {
        const started = performance.now();
        try {
            const result = (await fn()) ?? {};
            if (result.didWork === false && !env.AUDIT_IDLE_JOB_RUNS) return;
            await recordAudit({
                category: AuditCategory.JOB,
                action: `job.${job}`,
                summary: result.summary,
                data: { ...result.data, durationMs: Math.round(performance.now() - started) },
            });
        } catch (error) {
            logger.error({ err: error, job }, "Job failed");
            await recordAudit({
                category: AuditCategory.JOB,
                action: `job.${job}`,
                outcome: AuditOutcome.FAILURE,
                summary: error instanceof Error ? error.message : String(error),
                data: { durationMs: Math.round(performance.now() - started) },
            });
        }
    });
}

const MATCHED_ROUTE = Symbol("auditRoute");

/**
 * Remembers the full route pattern (e.g. /api/v1/admin/jobs/:id) at the moment Express hands a request to a
 * route. By the time the response finishes, an error may have unwound the routers and reset req.baseUrl.
 */
type Dispatch = (this: { path: string }, req: Request, ...rest: unknown[]) => unknown;
// Express exports Route at runtime but its type definitions don't declare it.
const routePrototype = (express as unknown as { Route: { prototype: { dispatch: Dispatch } } }).Route.prototype;
const dispatch = routePrototype.dispatch;
routePrototype.dispatch = function (req, ...rest) {
    (req as Request & { [MATCHED_ROUTE]?: string })[MATCHED_ROUTE] = `${req.baseUrl}${this.path === "/" ? "" : this.path}` || "/";
    return dispatch.call(this, req, ...rest);
};

// Probes hit these every few seconds and carry no user action.
const SKIPPED_PATHS = /^\/health\//;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Describes the body without storing visitors' personal data: admins' input is kept (secrets redacted), public input only by field name. */
function describeBody(body: unknown, isAdmin: boolean) {
    if (!body || typeof body !== "object" || !Object.keys(body).length) return undefined;
    return isAdmin ? sanitizeForAudit(body) : { fields: Object.keys(body as object) };
}

/**
 * One audit row per API request, written after the response finishes: endpoint (route pattern and path),
 * actor, status, duration and the input. Also sets up the context that domain events read the actor from.
 */
export const auditRequests: RequestHandler = (req, res, next) => {
    if (SKIPPED_PATHS.test(req.path)) return next();
    const started = performance.now();
    const requestId = String(req.id ?? res.getHeader("X-Request-Id") ?? "") || null;

    runInRequestContext({ requestId, ipHash: hashIp(req.ip), userAgent: req.get("user-agent")?.slice(0, 300) ?? null }, () => {
        const context = currentAuditContext();
        res.on("finish", () => {
            const isAdmin = context.actor.type === "admin";
            const files = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
            const entityId = typeof req.params?.id === "string" && UUID.test(req.params.id) ? req.params.id : null;
            const row: Partial<AuditLog> = {
                category: AuditCategory.REQUEST,
                action: "http.request",
                outcome: res.statusCode < 400 ? AuditOutcome.SUCCESS : AuditOutcome.FAILURE,
                actorType: context.actor.type,
                actorId: context.actor.id,
                actorEmail: context.actor.email,
                actorRole: context.actor.role,
                entityId,
                method: req.method,
                route: (req as Request & { [MATCHED_ROUTE]?: string })[MATCHED_ROUTE] ?? null,
                path: req.originalUrl.split("?")[0]!.slice(0, 1000),
                statusCode: res.statusCode,
                durationMs: Math.round(performance.now() - started),
                requestId,
                ipHash: context.ipHash,
                userAgent: context.userAgent,
                summary: `${req.method} ${req.originalUrl.split("?")[0]} → ${res.statusCode}`.slice(0, 500),
                data: sanitizeForAudit({
                    query: Object.keys(req.query ?? {}).length ? req.query : undefined,
                    body: req.method === "GET" ? undefined : describeBody(req.body, isAdmin),
                    files: files.length ? files.map((file) => ({ name: file.originalname, size: file.size })) : undefined,
                }) as Record<string, unknown>,
            };
            AppDataSource.getRepository(AuditLog)
                .insert(row as never)
                .catch((error) => logger.error({ err: error, path: row.path }, "Failed to write request audit log"));
        });
        next();
    });
};
