import { z } from "zod";
import { AppDataSource } from "../../config/database.js";
import { env } from "../../config/env.js";
import { dayRange, type GroupCount } from "../../lib/listing.js";
import { addDays, isoWeekday } from "../../lib/timezone.js";
import { companyDate, summarizeAdminJobs } from "../jobs/jobs.service.js";

export const MAX_RANGE_DAYS = 731;
export type Granularity = "day" | "week" | "month";

const dayDiff = (from: string, to: string) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000);

/** `from`/`to` are whole days in the company timezone; the default is the last 30 days. */
export const dateRangeQuery = z
    .object({
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        granularity: z.enum(["day", "week", "month"]).optional(),
    })
    .transform(({ from, to, granularity }) => {
        const end = to ?? companyDate();
        return { from: from ?? addDays(end, -29), to: end, granularity };
    })
    .refine(({ from, to }) => from <= to && dayDiff(from, to) < MAX_RANGE_DAYS, {
        message: `Use an ascending range of at most ${MAX_RANGE_DAYS} days`,
        path: ["from"],
    });

export type DateRange = z.infer<typeof dateRangeQuery>;

/** Days for short ranges, weeks up to about half a year, months beyond. */
export function pickGranularity(from: string, to: string): Granularity {
    const days = dayDiff(from, to) + 1;
    return days <= 45 ? "day" : days <= 200 ? "week" : "month";
}

/** Bucket a YYYY-MM-DD date falls into; matches Postgres date_trunc (weeks start on Monday). */
export function bucketOf(date: string, granularity: Granularity): string {
    if (granularity === "day") return date;
    if (granularity === "week") return addDays(date, 1 - isoWeekday(date));
    return `${date.slice(0, 7)}-01`;
}

export function bucketsBetween(from: string, to: string, granularity: Granularity): string[] {
    const buckets = new Set<string>();
    for (let date = from; date <= to; date = addDays(date, 1)) buckets.add(bucketOf(date, granularity));
    return [...buckets];
}

type Table = "job_applications" | "contact_messages" | "call_bookings" | "interviews";

async function count(table: Table, column: string, start: Date, end: Date, extra = ""): Promise<number> {
    const [row] = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE "${column}" >= $1 AND "${column}" < $2 ${extra}`,
        [start, end],
    );
    return row.n;
}

async function perBucket(table: Table, column: string, start: Date, end: Date, granularity: Granularity) {
    const rows: { bucket: string; n: number }[] = await AppDataSource.query(
        `SELECT to_char(date_trunc($3, "${column}" AT TIME ZONE $4), 'YYYY-MM-DD') AS bucket, count(*)::int AS n
         FROM ${table} WHERE "${column}" >= $1 AND "${column}" < $2 GROUP BY 1`,
        [start, end, granularity, env.COMPANY_TIMEZONE],
    );
    return new Map(rows.map((row) => [row.bucket, row.n]));
}

async function groupCounts(table: Table, groupColumn: string, column: string, start: Date, end: Date): Promise<GroupCount[]> {
    return AppDataSource.query(
        `SELECT "${groupColumn}"::text AS key, count(*)::int AS count FROM ${table}
         WHERE "${column}" >= $1 AND "${column}" < $2 GROUP BY 1 ORDER BY 2 DESC, 1 ASC`,
        [start, end],
    );
}

/** Pairs a figure with the same figure for the period just before, for deltas. */
const metric = (value: number, previous: number | null) => ({ value, previous });

export async function getDashboard(range: DateRange, options: { includeInbox: boolean }) {
    const granularity = range.granularity ?? pickGranularity(range.from, range.to);
    const length = dayDiff(range.from, range.to) + 1;
    const previousRange = { from: addDays(range.from, -length), to: addDays(range.from, -1) };
    const { start, end } = dayRange(range.from, range.to) as { start: Date; end: Date };
    const previous = dayRange(previousRange.from, previousRange.to) as { start: Date; end: Date };
    const now = new Date();
    const inAWeek = new Date(now.getTime() + 7 * 86400_000);

    // Interviews count by when they take place; everything else by when it came in.
    const series: { key: "applications" | "interviews" | "messages" | "bookings"; table: Table; column: string }[] = [
        { key: "applications", table: "job_applications", column: "createdAt" },
        { key: "interviews", table: "interviews", column: "startsAt" },
        ...(options.includeInbox
            ? ([
                  { key: "messages", table: "contact_messages", column: "createdAt" },
                  { key: "bookings", table: "call_bookings", column: "createdAt" },
              ] as const)
            : []),
    ];

    const [currentTotals, previousTotals, buckets] = await Promise.all([
        Promise.all(series.map((item) => count(item.table, item.column, start, end))),
        Promise.all(series.map((item) => count(item.table, item.column, previous.start, previous.end))),
        Promise.all(series.map((item) => perBucket(item.table, item.column, start, end, granularity))),
    ]);

    const timeline = bucketsBetween(range.from, range.to, granularity).map((bucket) => ({
        bucket,
        ...Object.fromEntries(series.map((item, index) => [item.key, buckets[index]!.get(bucket) ?? 0])),
    }));

    const [pipeline, topVacancies, countries, interviewStatuses, upcoming, interviewed, previousInterviewed, timeToInterview, jobs] =
        await Promise.all([
            groupCounts("job_applications", "status", "createdAt", start, end),
            AppDataSource.query(
                `SELECT "jobCode" AS code, max("jobTitle") AS title, count(*)::int AS count FROM job_applications
                 WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1 ORDER BY 3 DESC, 1 ASC LIMIT 6`,
                [start, end],
            ) as Promise<{ code: string; title: string; count: number }[]>,
            groupCounts("job_applications", "country", "createdAt", start, end),
            groupCounts("interviews", "status", "startsAt", start, end),
            count("interviews", "startsAt", now, inAWeek, `AND status = 'scheduled'`),
            // Applications from the period that got at least one (not cancelled) interview.
            interviewedCount(start, end),
            interviewedCount(previous.start, previous.end),
            AppDataSource.query(
                `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_at - created_at)) / 86400 AS days
                 FROM (SELECT a."createdAt" AS created_at, min(i."startsAt") AS first_at
                       FROM job_applications a JOIN interviews i ON i.application_id = a.id AND i.status <> 'cancelled'
                       WHERE a."createdAt" >= $1 AND a."createdAt" < $2 GROUP BY a.id, a."createdAt") firsts`,
                [start, end],
            ) as Promise<{ days: number | null }[]>,
            summarizeAdminJobs({ archived: "false", groupBy: "status" }),
        ]);

    const totals = Object.fromEntries(series.map((item, index) => [item.key, metric(currentTotals[index]!, previousTotals[index]!)]));
    const applications = currentTotals[0]!;
    const previousApplications = previousTotals[0]!;
    const rate = (part: number, whole: number) => (whole ? part / whole : null);

    // Top five countries, the rest folded into one row.
    const topCountries = countries.slice(0, 5);
    const otherCountries = countries.slice(5).reduce((sum, row) => sum + row.count, 0);

    const [messageServices, bookingStatuses] = options.includeInbox
        ? await Promise.all([
              groupCounts("contact_messages", "service", "createdAt", start, end),
              groupCounts("call_bookings", "status", "createdAt", start, end),
          ])
        : [null, null];

    return {
        range: { ...range, granularity, timezone: env.COMPANY_TIMEZONE },
        previousRange,
        series: series.map((item) => item.key),
        totals,
        kpis: {
            openVacancies: jobs.groups.find((group) => group.key === "published")?.count ?? 0,
            scheduledVacancies: jobs.groups.find((group) => group.key === "scheduled")?.count ?? 0,
            upcomingInterviews: upcoming,
            interviewRate: { value: rate(interviewed, applications), previous: rate(previousInterviewed, previousApplications) },
            hired: pipeline.find((row) => row.key === "hired")?.count ?? 0,
            medianDaysToInterview: timeToInterview[0]?.days === null || timeToInterview[0]?.days === undefined ? null : Number(timeToInterview[0].days),
        },
        timeline,
        pipeline,
        topVacancies,
        countries: otherCountries ? [...topCountries, { key: "other", count: otherCountries }] : topCountries,
        interviewStatuses,
        jobStatuses: jobs.groups,
        messageServices,
        bookingStatuses,
    };
}

async function interviewedCount(start: Date, end: Date): Promise<number> {
    const [row] = await AppDataSource.query(
        `SELECT count(DISTINCT a.id)::int AS n FROM job_applications a
         JOIN interviews i ON i.application_id = a.id AND i.status <> 'cancelled'
         WHERE a."createdAt" >= $1 AND a."createdAt" < $2`,
        [start, end],
    );
    return row.n;
}
