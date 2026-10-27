import { Brackets, In, IsNull, LessThanOrEqual, type EntityManager } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { Locale } from "../../entities/enums.js";
import { JobApplication } from "../../entities/job-application.entity.js";
import { JobTranslation } from "../../entities/job-translation.entity.js";
import { Job, JobCategory, JobLocation } from "../../entities/job.entity.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { HttpError } from "../../lib/http-error.js";
import { zonedDate } from "../../lib/timezone.js";
import { auditedJob, recordAudit } from "../audit/audit.service.js";
import { grouped, likePattern, type GroupCount } from "../../lib/listing.js";
import { paginated, toSkipTake, type Pagination } from "../../lib/pagination.js";
import { AdminJobStatus, type ADMIN_JOB_SORTS, type AdminJobFilters, type CreateJobInput, type UpdateJobInput } from "./jobs.schema.js";

const jobs = () => AppDataSource.getRepository(Job);

/** YYYY-MM-DD of an instant in the company timezone; deadlines are whole days there. */
export function companyDate(date = new Date()): string {
    return zonedDate(date, env.COMPANY_TIMEZONE);
}

const deadlinePassed = (deadline: string | null, now = new Date()) => deadline !== null && deadline < companyDate(now);

export const isJobOpen = (job: Job): boolean =>
    job.isPublished && !job.archivedAt && !deadlinePassed(job.applicationDeadline);

export function pickTranslation(job: Job, locale: Locale): JobTranslation {
    const translation =
        job.translations.find((item) => item.locale === locale) ??
        job.translations.find((item) => item.locale === Locale.EN) ??
        job.translations[0];
    if (!translation) throw new Error(`Job ${job.id} has no translations`);
    return translation;
}

function toPublicSummary(job: Job, locale: Locale) {
    const translation = pickTranslation(job, locale);
    return {
        id: job.id,
        code: job.code,
        slug: job.slug,
        category: job.category,
        location: job.location,
        employmentType: job.employmentType,
        applicationDeadline: job.applicationDeadline,
        publishedAt: job.publishedAt,
        locale: translation.locale,
        title: translation.title,
    };
}

function toPublicDetail(job: Job, locale: Locale) {
    const translation = pickTranslation(job, locale);
    return {
        ...toPublicSummary(job, locale),
        isOpen: isJobOpen(job),
        description: translation.description,
        activities: translation.activities,
        importantPoints: translation.importantPoints,
        requirements: translation.requirements,
    };
}

function publishedOpenJobs() {
    return jobs()
        .createQueryBuilder("job")
        .where("job.isPublished = true")
        .andWhere("job.archivedAt IS NULL")
        .andWhere(
            new Brackets((qb) =>
                qb.where("job.applicationDeadline IS NULL").orWhere("job.applicationDeadline >= :today", { today: companyDate() }),
            ),
        );
}

export async function listPublicJobs(query: Pagination & {
    lang: Locale;
    q?: string;
    category?: JobCategory;
    location?: JobLocation;
}) {
    const qb = publishedOpenJobs()
        .leftJoinAndSelect("job.translations", "t", "t.locale IN (:...locales)", {
            locales: [...new Set([query.lang, Locale.EN])],
        })
        .orderBy("job.publishedAt", "DESC", "NULLS LAST")
        .addOrderBy("job.createdAt", "DESC");

    if (query.category) qb.andWhere("job.category = :category", { category: query.category });
    if (query.location) qb.andWhere("job.location = :location", { location: query.location });
    if (query.q) {
        // Match the title in any language so a Georgian visitor can search in English too.
        qb.andWhere(`EXISTS (SELECT 1 FROM job_translations s WHERE s.job_id = job.id AND s.title ILIKE :q)`, {
            q: likePattern(query.q),
        });
    }

    const { skip, take } = toSkipTake(query);
    const [items, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginated(items.map((job) => toPublicSummary(job, query.lang)), total, query);
}

/** Categories and locations among open jobs, with how many jobs each has. */
export async function getPublicJobFilters() {
    const count = (column: "category" | "location") =>
        publishedOpenJobs()
            .select(`job.${column}`, "key")
            .addSelect("count(*)::int", "count")
            .groupBy(`job.${column}`)
            .getRawMany<{ key: string; count: number }>()
            // Postgres orders enums by declaration; the site lists them alphabetically.
            .then((rows) => rows.sort((a, b) => a.key.localeCompare(b.key)));
    const [categories, locations] = await Promise.all([count("category"), count("location")]);

    return {
        categories: categories.map((row) => row.key),
        locations: locations.map((row) => row.key),
        counts: {
            category: Object.fromEntries(categories.map((row) => [row.key, row.count])),
            location: Object.fromEntries(locations.map((row) => [row.key, row.count])),
        },
    };
}

export async function findPublishedJobBySlug(slug: string): Promise<Job> {
    const job = await jobs().findOne({
        where: { slug, isPublished: true, archivedAt: IsNull() },
        relations: { translations: true },
    });
    if (!job) throw HttpError.notFound("Job not found");
    return job;
}

export async function getPublicJob(slug: string, lang: Locale) {
    return toPublicDetail(await findPublishedJobBySlug(slug), lang);
}

// ---- Admin ----

export function adminJobStatus(job: Job, now = new Date()): AdminJobStatus {
    if (job.archivedAt) return AdminJobStatus.ARCHIVED;
    if (job.publishAt) return AdminJobStatus.SCHEDULED;
    // Past the deadline the site already hides the job, even before the scheduler unpublishes it.
    if (deadlinePassed(job.applicationDeadline, now)) return AdminJobStatus.EXPIRED;
    return job.isPublished ? AdminJobStatus.PUBLISHED : AdminJobStatus.DRAFT;
}

/** The same lifecycle status as adminJobStatus, in SQL; needs a :today parameter. */
const STATUS_SQL = `(CASE
    WHEN job."archivedAt" IS NOT NULL THEN 'archived'
    WHEN job."publishAt" IS NOT NULL THEN 'scheduled'
    WHEN job."applicationDeadline" < :today THEN 'expired'
    WHEN job."isPublished" THEN 'published'
    ELSE 'draft' END)`;

const EN_TITLE_SQL = `(SELECT t.title FROM job_translations t WHERE t.job_id = job.id ORDER BY (t.locale = 'en') DESC LIMIT 1)`;

const toAdmin = (job: Job) => ({
    ...job,
    status: adminJobStatus(job),
    translations: [...job.translations].sort((a, b) => a.locale.localeCompare(b.locale)),
});

/** Admin job filters; `except` leaves one out so a summary counts every value of its own column. */
function filteredAdminJobs(filters: AdminJobFilters, except?: string) {
    const qb = jobs().createQueryBuilder("job").setParameter("today", companyDate());
    if (filters.archived !== "all") qb.andWhere(`job.archivedAt IS ${filters.archived === "true" ? "NOT " : ""}NULL`);
    if (filters.q) {
        qb.andWhere(
            new Brackets((inner) =>
                inner
                    .where("job.code ILIKE :like")
                    .orWhere("job.slug ILIKE :like")
                    .orWhere(`EXISTS (SELECT 1 FROM job_translations s WHERE s.job_id = job.id AND s.title ILIKE :like)`),
            ),
            { like: likePattern(filters.q) },
        );
    }
    if (filters.status && except !== "status") qb.andWhere(`${STATUS_SQL} IN (:...statuses)`, { statuses: filters.status });
    for (const key of ["category", "location", "employmentType"] as const) {
        const values = filters[key];
        if (values && except !== key) qb.andWhere(`job.${key} IN (:...${key})`, { [key]: values });
    }
    return qb;
}

const JOB_ORDER: Record<(typeof ADMIN_JOB_SORTS)[number], [string, "ASC" | "DESC", ("NULLS FIRST" | "NULLS LAST")?]> = {
    newest: ["job.createdAt", "DESC"],
    oldest: ["job.createdAt", "ASC"],
    title: ["sort_title", "ASC"],
    deadline: ["job.applicationDeadline", "ASC", "NULLS LAST"],
    publishAt: ["job.publishAt", "ASC", "NULLS LAST"],
};

export async function listAdminJobs(query: AdminJobFilters & Pagination & { sort: (typeof ADMIN_JOB_SORTS)[number] }) {
    const [column, direction, nulls] = JOB_ORDER[query.sort];
    const qb = filteredAdminJobs(query)
        .addSelect(EN_TITLE_SQL, "sort_title")
        .orderBy(column, direction, nulls)
        .addOrderBy("job.id", "ASC");
    const { skip, take } = toSkipTake(query);
    const [page, total] = await qb.offset(skip).limit(take).getManyAndCount();

    // Translations are loaded separately so the page query has no joins to paginate around.
    const withTranslations = page.length
        ? await jobs().find({ where: { id: In(page.map((job) => job.id)) }, relations: { translations: true } })
        : [];
    const byId = new Map(withTranslations.map((job) => [job.id, job]));
    return paginated(page.map((job) => toAdmin(byId.get(job.id)!)), total, query);
}

export async function summarizeAdminJobs(query: AdminJobFilters & { groupBy: "status" | "category" | "location" | "employmentType" }) {
    const key = query.groupBy === "status" ? STATUS_SQL : `job."${query.groupBy}"`;
    const groups = await filteredAdminJobs(query, query.groupBy)
        .select(key, "key")
        .addSelect("count(*)::int", "count")
        .groupBy("1")
        .getRawMany<GroupCount>();
    return grouped(query.groupBy, groups);
}

async function getJobOrThrow(id: string, manager: EntityManager = AppDataSource.manager): Promise<Job> {
    const job = await manager.getRepository(Job).findOne({ where: { id }, relations: { translations: true } });
    if (!job) throw HttpError.notFound("Job not found");
    return job;
}

export async function getAdminJob(id: string) {
    return toAdmin(await getJobOrThrow(id));
}

async function assertSlugFree(manager: EntityManager, slug: string, exceptId?: string) {
    const existing = await manager.getRepository(Job).findOne({ where: { slug }, select: { id: true } });
    if (existing && existing.id !== exceptId) {
        throw HttpError.conflict("SLUG_TAKEN", "A job with this slug already exists");
    }
}

const CODE_PREFIXES: Record<JobCategory, string> = {
    [JobCategory.IT]: "IT",
    [JobCategory.DIGITAL]: "DIG",
    [JobCategory.OTHER]: "GEN",
};

// Codes stay taken after a job is deleted while its applications still carry them.
async function isCodeTaken(manager: EntityManager, code: string): Promise<boolean> {
    const [row] = await manager.query(
        `SELECT EXISTS (SELECT 1 FROM jobs WHERE code = $1) OR EXISTS (SELECT 1 FROM job_applications WHERE "jobCode" = $1) AS taken`,
        [code],
    );
    return Boolean(row?.taken);
}

/** Next free code such as IT-2026-007; numbers come from a sequence and skip codes typed in by hand. */
async function generateJobCode(manager: EntityManager, category: JobCategory): Promise<string> {
    const year = new Date().getUTCFullYear();
    for (;;) {
        const [{ n }] = await manager.query(`SELECT nextval('job_code_seq') AS n`);
        const code = `${CODE_PREFIXES[category]}-${year}-${String(n).padStart(3, "0")}`;
        if (!(await isCodeTaken(manager, code))) return code;
    }
}

/** Rejects publishing (now or at `publishAt`) after the application deadline. */
function assertPublishable(deadline: string | null, publishAt: Date | null = null) {
    if (deadlinePassed(deadline)) {
        throw HttpError.conflict("DEADLINE_PASSED", "The application deadline has passed; change it before publishing");
    }
    if (publishAt && deadline && companyDate(publishAt) > deadline) {
        throw HttpError.badRequest("The posting time is after the application deadline", {
            publishAt: ["Must be on or before the deadline"],
        });
    }
}

/** A scheduled time that has already come means "publish now". */
function publicationFields(publishAt: Date | null, now = new Date()) {
    if (publishAt && publishAt <= now) return { isPublished: true, publishedAt: now, publishAt: null };
    return { publishAt };
}

export async function createJob(input: CreateJobInput) {
    if (input.isPublished || input.publishAt) assertPublishable(input.applicationDeadline, input.publishAt);
    return AppDataSource.transaction(async (manager) => {
        await assertSlugFree(manager, input.slug);
        if (input.code && (await isCodeTaken(manager, input.code))) {
            throw HttpError.conflict("CODE_TAKEN", "This job code is already in use");
        }
        const job = manager.getRepository(Job).create({
            ...input,
            code: input.code ?? (await generateJobCode(manager, input.category)),
            publishedAt: input.isPublished ? new Date() : null,
            ...publicationFields(input.publishAt),
            translations: input.translations.map((translation) => manager.getRepository(JobTranslation).create(translation)),
        });
        const saved = await manager.getRepository(Job).save(job);
        await recordAudit(
            {
                action: "job.created",
                entityType: "job",
                entityId: saved.id,
                summary: `Created vacancy ${saved.code}`,
                data: { code: saved.code, slug: saved.slug, isPublished: saved.isPublished, publishAt: saved.publishAt },
            },
            manager,
        );
        return toAdmin(await getJobOrThrow(saved.id, manager));
    });
}

export async function updateJob(id: string, input: UpdateJobInput) {
    return AppDataSource.transaction(async (manager) => {
        const job = await getJobOrThrow(id, manager);
        const { translations, publishAt, ...fields } = input;

        if (fields.slug && fields.slug !== job.slug) await assertSlugFree(manager, fields.slug, id);

        const deadline = fields.applicationDeadline === undefined ? job.applicationDeadline : fields.applicationDeadline;
        const scheduled = publishAt === undefined ? job.publishAt : publishAt;
        let publication = {};
        if (publishAt !== undefined) {
            if (publishAt && job.isPublished) {
                throw HttpError.conflict("JOB_ALREADY_PUBLISHED", "The job is already published; unpublish it to schedule a new posting time");
            }
            if (publishAt && job.archivedAt) {
                throw HttpError.conflict("JOB_ARCHIVED", "Restore the job from the archive before scheduling it");
            }
            publication = publicationFields(publishAt);
        }
        if (scheduled) assertPublishable(deadline, scheduled);

        const changes = { ...fields, ...publication };
        if (Object.keys(changes).length) await manager.getRepository(Job).update(id, changes);

        if (translations) {
            // The submitted set replaces the existing translations.
            await manager.getRepository(JobTranslation).delete({ jobId: id });
            await manager
                .getRepository(JobTranslation)
                .insert(translations.map((translation) => ({ ...translation, jobId: id })));
        }

        const changed = Object.fromEntries(
            Object.entries(changes)
                .filter(([key, value]) => String(job[key as keyof Job]) !== String(value))
                .map(([key, value]) => [key, { from: job[key as keyof Job], to: value }]),
        );
        await recordAudit(
            {
                action: "job.updated",
                entityType: "job",
                entityId: id,
                summary: `Updated vacancy ${job.code}`,
                data: { changes: changed, translationsReplaced: Boolean(translations) },
            },
            manager,
        );
        return toAdmin(await getJobOrThrow(id, manager));
    });
}

export async function setJobPublished(id: string, isPublished: boolean) {
    const job = await getJobOrThrow(id);
    if (isPublished && job.archivedAt) {
        throw HttpError.conflict("JOB_ARCHIVED", "Restore the job from the archive before publishing it");
    }
    if (isPublished) assertPublishable(job.applicationDeadline);
    await jobs().update(id, {
        isPublished,
        publishedAt: isPublished ? new Date() : job.publishedAt,
        // Publishing now or unpublishing both cancel a scheduled posting.
        publishAt: null,
    });
    await recordAudit({
        action: isPublished ? "job.published" : "job.unpublished",
        entityType: "job",
        entityId: id,
        summary: `${isPublished ? "Published" : "Unpublished"} vacancy ${job.code}`,
        data: { code: job.code, cancelledSchedule: job.publishAt },
    });
    return getAdminJob(id);
}

/** Archiving takes the job off the site; restoring brings it back as a draft. */
export async function setJobArchived(id: string, archived: boolean) {
    const job = await getJobOrThrow(id);
    await jobs().update(
        id,
        archived ? { archivedAt: job.archivedAt ?? new Date(), isPublished: false, publishAt: null } : { archivedAt: null },
    );
    await recordAudit({
        action: archived ? "job.archived" : "job.unarchived",
        entityType: "job",
        entityId: id,
        summary: `${archived ? "Archived" : "Restored"} vacancy ${job.code}`,
        data: { code: job.code },
    });
    return getAdminJob(id);
}

/** Archives every unpublished job that isn't scheduled to be posted. */
export async function archiveUnpublishedJobs(): Promise<{ archived: number }> {
    const result = await jobs()
        .createQueryBuilder()
        .update(Job)
        .set({ archivedAt: new Date() })
        .where(`"isPublished" = false AND "archivedAt" IS NULL AND "publishAt" IS NULL`)
        .returning(["id", "code"])
        .execute();
    const archived = (result.raw as { id: string; code: string }[]) ?? [];
    await recordAudit({
        action: "job.bulk_archived",
        entityType: "job",
        summary: `Archived ${archived.length} unpublished vacancies`,
        data: { codes: archived.map((job) => job.code), ids: archived.map((job) => job.id) },
    });
    return { archived: result.affected ?? archived.length };
}

/** Posts jobs whose scheduled time has come and takes down jobs whose deadline has passed. */
export async function runJobSchedule(now = new Date()) {
    const due = await jobs().find({ where: { publishAt: LessThanOrEqual(now), archivedAt: IsNull() }, select: { id: true, code: true, publishAt: true } });
    for (const job of due) {
        await jobs().update(
            { id: job.id, publishAt: job.publishAt! },
            { isPublished: true, publishedAt: job.publishAt, publishAt: null },
        );
        await recordAudit({ action: "job.auto_published", entityType: "job", entityId: job.id, summary: `Posted vacancy ${job.code} at its scheduled time`, data: { code: job.code, scheduledFor: job.publishAt } });
    }

    const expired = await jobs()
        .createQueryBuilder()
        .update(Job)
        .set({ isPublished: false })
        .where(`"isPublished" = true AND "applicationDeadline" < :today`, { today: companyDate(now) })
        .returning(["id", "code", "applicationDeadline"])
        .execute();
    for (const job of (expired.raw as { id: string; code: string; applicationDeadline: string }[]) ?? []) {
        await recordAudit({ action: "job.auto_unpublished", entityType: "job", entityId: job.id, summary: `Unpublished vacancy ${job.code} after its deadline`, data: { code: job.code, deadline: job.applicationDeadline } });
    }

    const result = { published: due.length, unpublished: expired.affected ?? 0 };
    if (result.published || result.unpublished) logger.info(result, "Job schedule applied");
    return result;
}

export function startJobScheduler(intervalMs = 30_000): () => void {
    const run = () =>
        auditedJob("vacancy_schedule", async () => {
            const result = await runJobSchedule();
            return { didWork: result.published + result.unpublished > 0, summary: `Posted ${result.published}, unpublished ${result.unpublished}`, data: result };
        });
    void run();
    const timer = setInterval(run, intervalMs);
    return () => clearInterval(timer);
}

/** Applications stay and keep the job's code and title. */
export async function deleteJob(id: string): Promise<void> {
    const job = await getJobOrThrow(id);
    await jobs().delete(id);
    await recordAudit({ action: "job.deleted", entityType: "job", entityId: id, summary: `Deleted vacancy ${job.code}`, data: { code: job.code, slug: job.slug, title: pickTranslation(job, Locale.EN).title } });
}

export type JobCodeState = "active" | "archived" | "deleted";

/** Every job code in use, including codes of deleted jobs that applications still carry. */
export async function listJobCodes() {
    const [allJobs, counts] = await Promise.all([
        jobs().find({ relations: { translations: true }, order: { createdAt: "DESC" } }),
        AppDataSource.getRepository(JobApplication)
            .createQueryBuilder("a")
            .select(`a."jobCode"`, "code")
            .addSelect(`max(a."jobTitle")`, "title")
            .addSelect("count(*)::int", "applications")
            .addSelect(`max(a."createdAt")`, "lastAppliedAt")
            .groupBy(`a."jobCode"`)
            .getRawMany<{ code: string; title: string; applications: number; lastAppliedAt: Date }>(),
    ]);
    const countsByCode = new Map(counts.map((row) => [row.code, row]));

    const fromJobs = allJobs.map((job) => ({
        code: job.code,
        title: pickTranslation(job, Locale.EN).title,
        jobId: job.id as string | null,
        state: (job.archivedAt ? "archived" : "active") as JobCodeState,
        applications: countsByCode.get(job.code)?.applications ?? 0,
    }));
    const live = new Set(allJobs.map((job) => job.code));
    const deleted = counts
        .filter((row) => !live.has(row.code))
        .sort((a, b) => new Date(b.lastAppliedAt).getTime() - new Date(a.lastAppliedAt).getTime())
        .map((row) => ({ code: row.code, title: row.title, jobId: null, state: "deleted" as JobCodeState, applications: row.applications }));

    return { items: [...fromJobs, ...deleted] };
}
