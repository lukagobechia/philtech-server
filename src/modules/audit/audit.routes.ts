import { Router } from "express";
import { z } from "zod";
import { Brackets, type SelectQueryBuilder } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { env } from "../../config/env.js";
import { AuditActorType, AuditCategory, AuditLog, AuditOutcome } from "../../entities/audit-log.entity.js";
import { HttpError } from "../../lib/http-error.js";
import { dateRangeQuery, dayRange, enumList, likePattern, searchQuery } from "../../lib/listing.js";
import { paginated, paginationQuery, toSkipTake } from "../../lib/pagination.js";
import { schemas } from "../../lib/schemas.js";

const textList = z
    .string()
    .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
    .pipe(z.array(z.string().max(100)).min(1).max(50));

export const auditFilters = z.object({
    // Free text over action, summary, endpoint, actor email, entity id, request id and actor id.
    q: searchQuery,
    actorId: schemas.uuid.optional(),
    actorType: enumList(AuditActorType).optional(),
    category: enumList(AuditCategory).optional(),
    outcome: z.enum(AuditOutcome).optional(),
    // Exact actions (comma-separated), or a prefix such as "job." with actionPrefix.
    action: textList.optional(),
    actionPrefix: z.string().trim().max(100).optional(),
    entityType: textList.optional(),
    entityId: z.string().trim().max(64).optional(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    // An exact code (404) or a class (4xx).
    status: z
        .string()
        .regex(/^[1-5](\d\d|xx)$/, "Use a status code such as 404 or a class such as 4xx")
        .optional(),
    route: z.string().trim().max(300).optional(),
    requestId: z.string().trim().max(128).optional(),
    ...dateRangeQuery,
});

export type AuditFilters = z.infer<typeof auditFilters>;

/** Applies the filters; `except` leaves one out so a summary counts every value of its own column. */
export function filteredAuditLogs(filters: AuditFilters, except?: string): SelectQueryBuilder<AuditLog> {
    const qb = AppDataSource.getRepository(AuditLog).createQueryBuilder("log");
    if (filters.actorId && except !== "actorId") qb.andWhere("log.actorId = :actorId", { actorId: filters.actorId });
    if (filters.actorType && except !== "actorType") qb.andWhere("log.actorType IN (:...actorType)", { actorType: filters.actorType });
    if (filters.category && except !== "category") qb.andWhere("log.category IN (:...category)", { category: filters.category });
    if (filters.outcome && except !== "outcome") qb.andWhere("log.outcome = :outcome", { outcome: filters.outcome });
    if (filters.action && except !== "action") qb.andWhere("log.action IN (:...action)", { action: filters.action });
    if (filters.actionPrefix) qb.andWhere("log.action LIKE :actionPrefix", { actionPrefix: `${filters.actionPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%` });
    if (filters.entityType && except !== "entityType") qb.andWhere("log.entityType IN (:...entityType)", { entityType: filters.entityType });
    if (filters.entityId) qb.andWhere("log.entityId = :entityId", { entityId: filters.entityId });
    if (filters.method && except !== "method") qb.andWhere("log.method = :method", { method: filters.method });
    if (filters.route && except !== "route") qb.andWhere("log.route = :route", { route: filters.route });
    if (filters.requestId) qb.andWhere("log.requestId = :requestId", { requestId: filters.requestId });
    if (filters.status && except !== "statusCode") {
        if (filters.status.endsWith("xx")) {
            const base = Number(filters.status[0]) * 100;
            qb.andWhere("log.statusCode >= :low AND log.statusCode < :high", { low: base, high: base + 100 });
        } else {
            qb.andWhere("log.statusCode = :statusCode", { statusCode: Number(filters.status) });
        }
    }
    if (filters.q) {
        qb.andWhere(
            new Brackets((inner) =>
                inner
                    .where("log.action ILIKE :like")
                    .orWhere("log.summary ILIKE :like")
                    .orWhere("log.path ILIKE :like")
                    .orWhere("log.actorEmail ILIKE :like")
                    .orWhere("log.entityId ILIKE :like")
                    .orWhere("log.requestId ILIKE :like")
                    // Lets a pasted (or partial) user id find everything that user did.
                    .orWhere("CAST(log.actorId AS text) ILIKE :like"),
            ),
            { like: likePattern(filters.q) },
        );
    }
    const { start, end } = dayRange(filters.from, filters.to);
    if (start) qb.andWhere("log.createdAt >= :start", { start });
    if (end) qb.andWhere("log.createdAt < :end", { end });
    return qb;
}

const SORTS = {
    newest: ["log.createdAt", "DESC"],
    oldest: ["log.createdAt", "ASC"],
    slowest: ["log.durationMs", "DESC"],
} as const;

const listQuery = auditFilters.extend({ ...paginationQuery.shape, sort: z.enum(["newest", "oldest", "slowest"]).default("newest") });

// Column (or expression) per group-by option; "day" uses the company timezone.
const GROUPS: Record<string, string> = {
    action: "log.action",
    actorId: "CAST(log.actorId AS text)",
    actorType: "CAST(log.actorType AS text)",
    category: "CAST(log.category AS text)",
    outcome: "CAST(log.outcome AS text)",
    entityType: "log.entityType",
    route: "log.route",
    method: "log.method",
    statusCode: "CAST(log.statusCode AS text)",
    day: `to_char(date_trunc('day', log.createdAt AT TIME ZONE :tz), 'YYYY-MM-DD')`,
};

const summaryQuery = auditFilters.extend({
    groupBy: z.enum(Object.keys(GROUPS) as [string, ...string[]]).default("action"),
    // Groups can be many (e.g. per route); the top ones are returned.
    limit: z.coerce.number().int().min(1).max(500).default(50),
});

/** Mounted at /admin/audit-logs (admins only). Read-only: the log can't be edited through the API. */
export const auditRouter = Router();

auditRouter.get("/", async (req, res) => {
    const { page, limit, sort, ...filters } = listQuery.parse(req.query);
    const [column, direction] = SORTS[sort];
    const qb = filteredAuditLogs(filters)
        .orderBy(column, direction, sort === "slowest" ? "NULLS LAST" : undefined)
        .addOrderBy("log.id", "ASC");
    const { skip, take } = toSkipTake({ page, limit });
    const [items, total] = await qb.skip(skip).take(take).getManyAndCount();
    res.json(paginated(items, total, { page, limit }));
});

auditRouter.get("/summary", async (req, res) => {
    const { groupBy, limit, ...filters } = summaryQuery.parse(req.query);
    const qb = filteredAuditLogs(filters, groupBy)
        .select(GROUPS[groupBy]!, "key")
        .addSelect("count(*)::int", "count")
        .addSelect("count(*) FILTER (WHERE log.outcome = 'failure')::int", "failures")
        .groupBy("1")
        .setParameter("tz", env.COMPANY_TIMEZONE);
    // Grouping by user also returns their email, so ids are readable.
    if (groupBy === "actorId") qb.addSelect("max(log.actorEmail)", "label");
    if (groupBy === "day") qb.orderBy("1", "ASC");
    else qb.orderBy("count", "DESC").addOrderBy("1", "ASC");

    const groups = await qb.limit(limit).getRawMany<{ key: string | null; count: number; failures: number; label?: string | null }>();
    const total = await filteredAuditLogs(filters, groupBy).getCount();
    res.json({ groupBy, total, groups });
});

auditRouter.get("/:id", async (req, res) => {
    const { id } = z.object({ id: schemas.uuid }).parse(req.params);
    const entry = await AppDataSource.getRepository(AuditLog).findOneBy({ id });
    if (!entry) throw HttpError.notFound();
    // Other entries from the same request, e.g. the HTTP row and the changes it made.
    const related = entry.requestId
        ? await AppDataSource.getRepository(AuditLog).find({ where: { requestId: entry.requestId }, order: { createdAt: "ASC" }, take: 50 })
        : [];
    res.json({ ...entry, related: related.filter((item) => item.id !== entry.id) });
});
