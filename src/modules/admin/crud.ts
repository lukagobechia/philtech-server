import { Router } from "express";
import { z } from "zod";
import type { EntityManager, EntityTarget, ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { HttpError } from "../../lib/http-error.js";
import { dateRangeQuery, dayRange, enumList, grouped, likePattern, searchQuery, type GroupCount } from "../../lib/listing.js";
import { paginated, paginationQuery, toSkipTake } from "../../lib/pagination.js";
import { schemas } from "../../lib/schemas.js";
import { recordAudit } from "../audit/audit.service.js";

type SortDirection = "ASC" | "DESC";

type Options<E extends ObjectLiteral> = {
    entity: EntityTarget<E>;
    // Entity name in the audit log, e.g. "application" -> "application.status_changed".
    auditEntity: string;
    statusEnum: Record<string, string>;
    searchColumns: string[];
    // Extra equality filters allowed on the list query, e.g. { jobId: schemas.uuid }.
    filters?: Record<string, z.ZodType>;
    // Column that "?from=&to=" (days in the company timezone) apply to. Defaults to createdAt.
    dateColumn?: string;
    // Named sort orders for "?sort="; the first one is the default.
    sorts?: Record<string, [column: string, direction: SortDirection]>;
    // Columns that "GET /summary?groupBy=" may count by, besides status.
    groupBy?: string[];
    // Serializes a row before it is returned (e.g. to hide storage keys).
    serialize?: (row: E) => unknown;
    // Runs in the same transaction as a status update, e.g. to queue a notification email.
    onStatusChange?: (manager: EntityManager, row: E, previousStatus: string, actorId: string | null) => Promise<void>;
};

const idParams = z.object({ id: schemas.uuid });

const DEFAULT_SORTS: Record<string, [string, SortDirection]> = {
    newest: ["createdAt", "DESC"],
    oldest: ["createdAt", "ASC"],
};

/** List / summary / get / status-update endpoints shared by the admin inbox resources. */
export function adminCrudRouter<E extends ObjectLiteral>(options: Options<E>): Router {
    const router = Router();
    const repository = () => AppDataSource.getRepository(options.entity);
    // Hashed IPs are for abuse investigation in the database only, never returned.
    const serialize = options.serialize ?? (({ ipHash: _ipHash, ...row }: E) => row);
    const sorts = options.sorts ?? DEFAULT_SORTS;
    const sortKeys = Object.keys(sorts) as [string, ...string[]];
    const dateColumn = options.dateColumn ?? "createdAt";
    const groupColumns = ["status", ...(options.groupBy ?? [])] as [string, ...string[]];

    const filterQuery = z.object({
        // One status or several, comma-separated.
        status: enumList(options.statusEnum).optional(),
        q: searchQuery,
        ...dateRangeQuery,
        ...Object.fromEntries(Object.entries(options.filters ?? {}).map(([key, schema]) => [key, schema.optional()])),
    });
    type Filters = z.infer<typeof filterQuery> & Record<string, unknown>;

    /** Applies the filters; `except` leaves one out so a summary counts every value of its own column. */
    const filtered = ({ status, q, from, to, ...equal }: Filters, except?: string): SelectQueryBuilder<E> => {
        const qb = repository().createQueryBuilder("row");
        if (status && except !== "status") qb.andWhere("row.status IN (:...status)", { status });
        for (const [key, value] of Object.entries(equal)) {
            if (value !== undefined && key !== except) qb.andWhere(`row.${key} = :${key}`, { [key]: value });
        }
        if (q) {
            qb.andWhere(`(${options.searchColumns.map((column) => `row.${column} ILIKE :like`).join(" OR ")})`, { like: likePattern(q) });
        }
        const { start, end } = dayRange(from, to);
        if (start) qb.andWhere(`row.${dateColumn} >= :start`, { start });
        if (end) qb.andWhere(`row.${dateColumn} < :end`, { end });
        return qb;
    };

    const listQuery = filterQuery.extend({ ...paginationQuery.shape, sort: z.enum(sortKeys).default(sortKeys[0]) });

    router.get("/", async (req, res) => {
        const { page, limit, sort, ...filters } = listQuery.parse(req.query) as z.infer<typeof listQuery> & Filters;
        const [column, direction] = sorts[sort]!;
        const qb = filtered(filters).orderBy(`row.${column}`, direction).addOrderBy("row.id", direction);

        const { skip, take } = toSkipTake({ page, limit });
        const [items, total] = await qb.skip(skip).take(take).getManyAndCount();
        res.json(paginated(items.map(serialize), total, { page, limit }));
    });

    const summaryQuery = filterQuery.extend({ groupBy: z.enum(groupColumns).default("status") });

    // Registered before "/:id" so "summary" isn't read as an id.
    router.get("/summary", async (req, res) => {
        const { groupBy, ...filters } = summaryQuery.parse(req.query) as z.infer<typeof summaryQuery> & Filters;
        const groups = await filtered(filters, groupBy)
            .select(`row.${groupBy}`, "key")
            .addSelect("count(*)::int", "count")
            .groupBy(`row.${groupBy}`)
            .getRawMany<GroupCount>();
        res.json(grouped(groupBy, groups));
    });

    router.get("/:id", async (req, res) => {
        const row = await repository().findOneBy({ id: idParams.parse(req.params).id } as never);
        if (!row) throw HttpError.notFound();
        res.json(serialize(row));
    });

    const updateBody = z.object({ status: z.enum(options.statusEnum) });

    router.patch("/:id", async (req, res) => {
        const { id } = idParams.parse(req.params);
        const { status } = updateBody.parse(req.body);

        const updated = await AppDataSource.transaction(async (manager) => {
            const transactional = manager.getRepository(options.entity);
            const existing = await transactional.findOneBy({ id } as never);
            if (!existing) throw HttpError.notFound();

            await transactional.update(id, { status } as never);
            const row = (await transactional.findOneBy({ id } as never))!;
            await options.onStatusChange?.(manager, row, existing.status, req.admin?.id ?? null);
            if (existing.status !== status) {
                await recordAudit(
                    {
                        action: `${options.auditEntity}.status_changed`,
                        entityType: options.auditEntity,
                        entityId: id,
                        summary: `Status ${existing.status} → ${status}`,
                        data: { from: existing.status, to: status },
                    },
                    manager,
                );
            }
            return row;
        });

        res.json(serialize(updated));
    });

    return router;
}
