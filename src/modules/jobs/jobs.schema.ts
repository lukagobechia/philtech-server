import { z } from "zod";
import { Locale } from "../../entities/enums.js";
import { JobCategory, JobEmploymentType, JobLocation } from "../../entities/job.entity.js";
import { enumList, searchQuery } from "../../lib/listing.js";
import { paginationQuery } from "../../lib/pagination.js";
import { schemas } from "../../lib/schemas.js";

export const listJobsQuery = paginationQuery.extend({
    lang: schemas.locale,
    q: z.string().trim().max(100).optional(),
    category: z.enum(JobCategory).optional(),
    location: z.enum(JobLocation).optional(),
});

export const jobSlugParams = z.object({ slug: z.string().trim().min(1).max(120) });
export const langQuery = z.object({ lang: schemas.locale });

const listItem = z.string().trim().min(1).max(1000);

const translationInput = z.object({
    locale: z.enum(Locale),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(20_000),
    activities: z.array(listItem).max(50).default([]),
    importantPoints: z.array(listItem).max(50).default([]),
    requirements: z.array(listItem).max(50).default([]),
});

const translations = z
    .array(translationInput)
    .min(1)
    .refine((items) => new Set(items.map((item) => item.locale)).size === items.length, "Duplicate locale")
    .refine((items) => items.some((item) => item.locale === Locale.EN), "An English translation is required");

const jobFields = {
    slug: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be kebab-case")
        .max(120),
    category: z.enum(JobCategory),
    location: z.enum(JobLocation),
    employmentType: z.enum(JobEmploymentType),
    applicationDeadline: z.iso.date().nullable().default(null),
};

export const jobCode = z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(32)
    .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, "Use letters, digits and dashes, e.g. IT-2026-007");

const publishAt = z.iso
    .datetime({ offset: true })
    .nullable()
    .transform((value) => (value ? new Date(value) : null));

export const createJobBody = z.object({
    ...jobFields,
    // Posts the job automatically at this time; mutually exclusive with isPublished.
    publishAt: publishAt.default(null),
    // Generated from the category when left empty. Fixed once the job is created.
    code: z.union([z.literal(""), jobCode]).nullish().transform((value) => value || null),
    isPublished: z.boolean().default(false),
    translations,
}).refine((value) => !(value.isPublished && value.publishAt), {
    message: "Publish now or schedule a time, not both",
    path: ["publishAt"],
});

export const updateJobBody = z
    .object({
        ...jobFields,
        applicationDeadline: z.iso.date().nullable(),
        publishAt,
        translations,
    })
    .partial()
    .refine((value) => Object.keys(value).length > 0, "Nothing to update");

export enum AdminJobStatus {
    PUBLISHED = "published",
    SCHEDULED = "scheduled",
    DRAFT = "draft",
    EXPIRED = "expired",
    ARCHIVED = "archived",
}

export const adminJobFilters = z.object({
    archived: z.enum(["true", "false", "all"]).default("false"),
    // Title (any language), code or slug.
    q: searchQuery,
    status: enumList(AdminJobStatus).optional(),
    category: enumList(JobCategory).optional(),
    location: enumList(JobLocation).optional(),
    employmentType: enumList(JobEmploymentType).optional(),
});

export const ADMIN_JOB_SORTS = ["newest", "oldest", "title", "deadline", "publishAt"] as const;

export const adminListJobsQuery = adminJobFilters.extend({
    ...paginationQuery.shape,
    sort: z.enum(ADMIN_JOB_SORTS).default("newest"),
});

export const adminJobsSummaryQuery = adminJobFilters.extend({
    groupBy: z.enum(["status", "category", "location", "employmentType"]).default("status"),
});

export type AdminJobFilters = z.infer<typeof adminJobFilters>;

export type CreateJobInput = z.infer<typeof createJobBody>;
export type UpdateJobInput = z.infer<typeof updateJobBody>;
