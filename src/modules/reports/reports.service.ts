import { AppDataSource } from "../../config/database.js";
import { Locale } from "../../entities/enums.js";
import { Job } from "../../entities/job.entity.js";
import { decryptRows } from "../../lib/field-encryption.js";
import { dayRange } from "../../lib/listing.js";
import type { CellValue, Sheet } from "../../lib/spreadsheet.js";
import { filteredAuditLogs, type AuditFilters } from "../audit/audit.routes.js";
import { getDashboard, type DateRange } from "../dashboard/dashboard.service.js";
import { sortByName } from "../employees/employees.service.js";
import { adminJobStatus, pickTranslation } from "../jobs/jobs.service.js";

export const REPORT_TYPES = ["overview", "applications", "interviews", "jobs", "messages", "bookings", "employees", "overtime", "audit"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

// Messages and call bookings are admin-only, like their admin pages.
export const ADMIN_ONLY_REPORTS = new Set<ReportType>(["messages", "bookings", "audit"]);

// Exports are for spreadsheets, not bulk extraction; ranges past this are cut off.
export const MAX_REPORT_ROWS = 50_000;

/** "no_show" -> "No show" */
const humanize = (value: string | null | undefined) =>
    value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ") : "";

type Range = { start: Date; end: Date };

async function applicationsSheet({ start, end }: Range, statuses?: string[]): Promise<Sheet> {
    const rows: Record<string, CellValue>[] = await AppDataSource.query(
        `SELECT a."createdAt", a."firstName", a."lastName", a.email, a.phone, a.city, a.country,
                a."currentEmployer", a."currentPosition", a."jobCode", a."jobTitle", a.status, a.locale,
                (SELECT count(*)::int FROM interviews i WHERE i.application_id = a.id AND i.status <> 'cancelled') AS interviews
         FROM job_applications a
         WHERE a."createdAt" >= $1 AND a."createdAt" < $2 ${statuses ? `AND a.status::text = ANY($3)` : ""}
         ORDER BY a."createdAt" DESC LIMIT ${MAX_REPORT_ROWS}`,
        statuses ? [start, end, statuses] : [start, end],
    );
    decryptRows(rows, ["firstName", "lastName", "email", "phone", "city", "currentEmployer", "currentPosition"]);
    return {
        name: "Applications",
        columns: [
            { header: "Applied at", type: "datetime", width: 18 },
            { header: "First name", width: 16 },
            { header: "Last name", width: 18 },
            { header: "Email", width: 30 },
            { header: "Phone", width: 18 },
            { header: "City", width: 16 },
            { header: "Country", width: 10 },
            { header: "Current employer", width: 24 },
            { header: "Current position", width: 24 },
            { header: "Job code", width: 16 },
            { header: "Vacancy", width: 28 },
            { header: "Status", width: 14 },
            { header: "Language", width: 10 },
            { header: "Interviews", type: "number", width: 12 },
        ],
        rows: rows.map((row) => [
            row.createdAt as Date, row.firstName, row.lastName, row.email, row.phone, row.city, row.country,
            row.currentEmployer, row.currentPosition, row.jobCode, row.jobTitle, humanize(row.status as string),
            String(row.locale).toUpperCase(), row.interviews,
        ]),
    };
}

async function interviewsSheet({ start, end }: Range, statuses?: string[]): Promise<Sheet> {
    const rows: Record<string, CellValue>[] = await AppDataSource.query(
        `SELECT i."startsAt", i.title, i."durationMinutes", i.status, i."meetingUrl", i.notes,
                a."firstName", a."lastName", a.email, a."jobCode", a."jobTitle",
                jsonb_array_length(i.attachments)::int AS files
         FROM interviews i JOIN job_applications a ON a.id = i.application_id
         WHERE i."startsAt" >= $1 AND i."startsAt" < $2 ${statuses ? `AND i.status::text = ANY($3)` : ""}
         ORDER BY i."startsAt" ASC LIMIT ${MAX_REPORT_ROWS}`,
        statuses ? [start, end, statuses] : [start, end],
    );
    decryptRows(rows, ["firstName", "lastName", "email", "notes"]);
    return {
        name: "Interviews",
        columns: [
            { header: "Starts at", type: "datetime", width: 18 },
            { header: "Interview", width: 24 },
            { header: "Candidate", width: 24 },
            { header: "Email", width: 30 },
            { header: "Job code", width: 16 },
            { header: "Vacancy", width: 28 },
            { header: "Duration (min)", type: "number", width: 14 },
            { header: "Status", width: 12 },
            { header: "Meeting link", width: 36 },
            { header: "Files", type: "number", width: 8 },
            { header: "Notes", width: 40 },
        ],
        rows: rows.map((row) => [
            row.startsAt as Date, row.title, `${row.firstName} ${row.lastName}`, row.email, row.jobCode, row.jobTitle, row.durationMinutes,
            humanize(row.status as string), row.meetingUrl, row.files, row.notes,
        ]),
    };
}

async function jobsSheet({ start, end }: Range, statuses?: string[]): Promise<Sheet> {
    const [jobs, counts] = await Promise.all([
        AppDataSource.getRepository(Job).find({ relations: { translations: true }, order: { createdAt: "DESC" } }),
        AppDataSource.query(
            `SELECT "jobCode" AS code, count(*)::int AS total,
                    count(*) FILTER (WHERE "createdAt" >= $1 AND "createdAt" < $2)::int AS in_range
             FROM job_applications GROUP BY 1`,
            [start, end],
        ) as Promise<{ code: string; total: number; in_range: number }[]>,
    ]);
    const byCode = new Map(counts.map((row) => [row.code, row]));
    const rows = jobs
        .map((job) => ({ job, status: adminJobStatus(job) }))
        .filter(({ status }) => !statuses || statuses.includes(status));

    return {
        name: "Vacancies",
        columns: [
            { header: "Job code", width: 16 },
            { header: "Title (EN)", width: 28 },
            { header: "Title (KA)", width: 28 },
            { header: "Category", width: 12 },
            { header: "Location", width: 12 },
            { header: "Employment type", width: 16 },
            { header: "Status", width: 12 },
            { header: "Published at", type: "datetime", width: 18 },
            { header: "Scheduled for", type: "datetime", width: 18 },
            { header: "Deadline", width: 12 },
            { header: "Applications in period", type: "number", width: 14 },
            { header: "Applications total", type: "number", width: 14 },
        ],
        rows: rows.map(({ job, status }) => [
            job.code,
            pickTranslation(job, Locale.EN).title,
            job.translations.find((translation) => translation.locale === Locale.KA)?.title ?? "",
            humanize(job.category),
            humanize(job.location),
            humanize(job.employmentType),
            humanize(status),
            job.publishedAt,
            job.publishAt,
            job.applicationDeadline,
            byCode.get(job.code)?.in_range ?? 0,
            byCode.get(job.code)?.total ?? 0,
        ]),
    };
}

async function messagesSheet({ start, end }: Range, statuses?: string[]): Promise<Sheet> {
    const rows: Record<string, CellValue>[] = await AppDataSource.query(
        `SELECT "createdAt", name, email, phone, company, service, message, status, locale FROM contact_messages
         WHERE "createdAt" >= $1 AND "createdAt" < $2 ${statuses ? `AND status::text = ANY($3)` : ""}
         ORDER BY "createdAt" DESC LIMIT ${MAX_REPORT_ROWS}`,
        statuses ? [start, end, statuses] : [start, end],
    );
    decryptRows(rows, ["name", "email", "phone", "company", "message"]);
    return {
        name: "Messages",
        columns: [
            { header: "Received at", type: "datetime", width: 18 },
            { header: "Name", width: 22 },
            { header: "Email", width: 30 },
            { header: "Phone", width: 18 },
            { header: "Company", width: 22 },
            { header: "Service", width: 12 },
            { header: "Message", width: 60 },
            { header: "Status", width: 12 },
            { header: "Language", width: 10 },
        ],
        rows: rows.map((row) => [
            row.createdAt as Date, row.name, row.email, row.phone, row.company,
            row.service === "ui_ux" ? "UI/UX" : humanize(row.service as string), row.message,
            humanize(row.status as string), String(row.locale).toUpperCase(),
        ]),
    };
}

async function bookingsSheet({ start, end }: Range, statuses?: string[]): Promise<Sheet> {
    const rows: Record<string, CellValue>[] = await AppDataSource.query(
        `SELECT "startsAt", "createdAt", name, email, phone, service, notes, status, timezone FROM call_bookings
         WHERE "startsAt" >= $1 AND "startsAt" < $2 ${statuses ? `AND status::text = ANY($3)` : ""}
         ORDER BY "startsAt" ASC LIMIT ${MAX_REPORT_ROWS}`,
        statuses ? [start, end, statuses] : [start, end],
    );
    decryptRows(rows, ["name", "email", "phone", "notes"]);
    return {
        name: "Call bookings",
        columns: [
            { header: "Call time", type: "datetime", width: 18 },
            { header: "Requested at", type: "datetime", width: 18 },
            { header: "Name", width: 22 },
            { header: "Email", width: 30 },
            { header: "Phone", width: 18 },
            { header: "Service", width: 12 },
            { header: "Status", width: 12 },
            { header: "Visitor timezone", width: 18 },
            { header: "Notes", width: 40 },
        ],
        rows: rows.map((row) => [
            row.startsAt as Date, row.createdAt as Date, row.name, row.email, row.phone,
            row.service === "ui_ux" ? "UI/UX" : humanize(row.service as string), humanize(row.status as string),
            row.timezone, row.notes,
        ]),
    };
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
const blockMinutes = (block: { start: string; end: string }) =>
    Number(block.end.slice(0, 2)) * 60 + Number(block.end.slice(3)) - (Number(block.start.slice(0, 2)) * 60 + Number(block.start.slice(3)));

async function employeesSheet({ start, end }: Range, statuses?: string[]): Promise<Sheet> {
    type Row = Record<string, CellValue> & { id: string; firstName: string; lastName: string; schedule: { weekday: number; start: string; end: string }[] };
    const rows: Row[] = await AppDataSource.query(
        `SELECT e.id, e."firstName", e."lastName", e.email, e.phone, e.position, e.department, e."startDate"::text AS "startDate", e.status, e."jobCode",
                e.application_id IS NOT NULL AS hired_via_application, e.schedule,
                coalesce((SELECT sum(extract(epoch FROM coalesce(o."endedAt", now()) - o."startedAt")) / 60
                          FROM overtime_entries o
                          WHERE o.employee_id = e.id AND o.status <> 'cancelled' AND o."startedAt" >= $1 AND o."startedAt" < $2), 0)::float AS overtime_minutes
         FROM employees e ${statuses ? `WHERE e.status::text = ANY($3)` : ""}
         ORDER BY e."createdAt" LIMIT ${MAX_REPORT_ROWS}`,
        statuses ? [start, end, statuses] : [start, end],
    );
    sortByName(decryptRows(rows, ["firstName", "lastName", "email", "phone"]));
    return {
        name: "Employees",
        columns: [
            { header: "First name", width: 16 },
            { header: "Last name", width: 18 },
            { header: "Email", width: 30 },
            { header: "Phone", width: 18 },
            { header: "Position", width: 26 },
            { header: "Department", width: 18 },
            { header: "Start date", width: 12 },
            { header: "Status", width: 10 },
            { header: "Hired for (job code)", width: 18 },
            { header: "Weekly hours", type: "number", width: 12 },
            { header: "Working schedule", width: 60 },
            { header: "Overtime in period (h)", type: "number", width: 16 },
        ],
        rows: rows.map((row) => [
            row.firstName, row.lastName, row.email, row.phone, row.position, row.department, row.startDate,
            humanize(row.status as string), row.hired_via_application ? row.jobCode : "Added manually",
            hours(row.schedule.reduce((sum, block) => sum + blockMinutes(block), 0)),
            row.schedule.map((block) => `${WEEKDAYS[block.weekday - 1]} ${block.start}–${block.end}`).join("; "),
            hours(Number(row.overtime_minutes)),
        ]),
    };
}

async function overtimeSheet({ start, end }: Range, statuses?: string[]): Promise<Sheet> {
    const rows: Record<string, CellValue>[] = await AppDataSource.query(
        `SELECT o."startedAt", o."endedAt", o."plannedEndAt", o.reason, o.status,
                e."firstName", e."lastName", e.position,
                s."displayName" AS started_by, x."displayName" AS ended_by,
                CASE WHEN o.status = 'cancelled' THEN 0
                     ELSE extract(epoch FROM coalesce(o."endedAt", now()) - o."startedAt") / 60 END::float AS minutes
         FROM overtime_entries o
         JOIN employees e ON e.id = o.employee_id
         LEFT JOIN admin_users s ON s.id = o.started_by_id
         LEFT JOIN admin_users x ON x.id = o.ended_by_id
         WHERE o."startedAt" >= $1 AND o."startedAt" < $2 ${statuses ? `AND o.status::text = ANY($3)` : ""}
         ORDER BY o."startedAt" DESC LIMIT ${MAX_REPORT_ROWS}`,
        statuses ? [start, end, statuses] : [start, end],
    );
    decryptRows(rows, ["firstName", "lastName"]);
    return {
        name: "Overtime",
        columns: [
            { header: "Started", type: "datetime", width: 18 },
            { header: "Ended", type: "datetime", width: 18 },
            { header: "Planned end", type: "datetime", width: 18 },
            { header: "Hours", type: "number", width: 8 },
            { header: "Employee", width: 24 },
            { header: "Position", width: 24 },
            { header: "Reason", width: 40 },
            { header: "Status", width: 12 },
            { header: "Started by", width: 18 },
            { header: "Ended by", width: 18 },
        ],
        rows: rows.map((row) => [
            row.startedAt as Date, row.endedAt as Date | null, row.plannedEndAt as Date | null, hours(Number(row.minutes)),
            `${row.firstName} ${row.lastName}`, row.position, row.reason, row.status === "active" ? "In progress" : humanize(row.status as string),
            row.started_by, row.endedAt && !row.ended_by && row.status === "completed" ? "Automatic (planned end)" : row.ended_by,
        ]),
    };
}

const percent = (ratio: number | null) => (ratio === null ? null : Math.round(ratio * 1000) / 10);

const change = (value: number | null, previous: number | null) =>
    value === null || previous === null || previous === 0 ? null : (value - previous) / previous;

const groupSheet = (name: string, label: string, rows: { key: string | null; count: number }[], format: (key: string) => string = humanize): Sheet => {
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    return {
        name,
        columns: [{ header: label, width: 24 }, { header: "Count", type: "number", width: 10 }, { header: "Share", type: "percent", width: 10 }],
        rows: rows.map((row) => [row.key === null ? "Not specified" : format(row.key), row.count, total ? row.count / total : null]),
    };
};

/** The dashboard as sheets: headline figures with the previous period, the timeline, and each breakdown. */
async function overviewSheets(range: DateRange, includeInbox: boolean): Promise<Sheet[]> {
    const data = await getDashboard(range, { includeInbox });
    const labels: Record<string, string> = { applications: "Applications", interviews: "Interviews", messages: "Messages", bookings: "Call bookings" };

    const summaryRows: CellValue[][] = [
        ...data.series.map((key) => {
            const { value, previous } = data.totals[key]!;
            return [labels[key], value, previous, change(value, previous)];
        }),
        ["Applications with an interview (%)", percent(data.kpis.interviewRate.value), percent(data.kpis.interviewRate.previous), null],
        ["Hired (applied in period)", data.kpis.hired, null, null],
        ["Median days to first interview", data.kpis.medianDaysToInterview === null ? null : Math.round(data.kpis.medianDaysToInterview * 10) / 10, null, null],
        ["Open vacancies (now)", data.kpis.openVacancies, null, null],
        ["Scheduled vacancies (now)", data.kpis.scheduledVacancies, null, null],
        ["Interviews in the next 7 days", data.kpis.upcomingInterviews, null, null],
    ];

    const sheets: Sheet[] = [
        {
            name: "Summary",
            columns: [
                { header: `Metric (${data.range.from} to ${data.range.to}, ${data.range.timezone})`, width: 44 },
                { header: "Value", type: "number", width: 12 },
                { header: `Previous (${data.previousRange.from} to ${data.previousRange.to})`, type: "number", width: 30 },
                { header: "Change", type: "percent", width: 10 },
            ],
            rows: summaryRows,
        },
        {
            name: "Timeline",
            columns: [
                { header: `${humanize(data.range.granularity)} starting`, type: "date", width: 16 },
                ...data.series.map((key) => ({ header: labels[key]!, type: "number" as const, width: 14 })),
            ],
            rows: data.timeline.map((point) => [
                new Date(`${point.bucket}T12:00:00Z`),
                ...data.series.map((key) => (point as Record<string, number | string>)[key] as number),
            ]),
        },
        groupSheet("Application pipeline", "Status", data.pipeline),
        {
            name: "Top vacancies",
            columns: [{ header: "Job code", width: 16 }, { header: "Vacancy", width: 32 }, { header: "Applications", type: "number", width: 14 }],
            rows: data.topVacancies.map((row) => [row.code, row.title, row.count]),
        },
        groupSheet("Countries", "Country", data.countries, (key: string) => (key === "other" ? "Other" : key)),
        groupSheet("Interviews by status", "Status", data.interviewStatuses),
        groupSheet("Vacancies by status", "Status", data.jobStatuses),
    ];
    if (data.messageServices) {
        sheets.push(groupSheet("Messages by service", "Service", data.messageServices, (key) => (key === "ui_ux" ? "UI/UX" : humanize(key))));
    }
    if (data.bookingStatuses) sheets.push(groupSheet("Call bookings by status", "Status", data.bookingStatuses));
    return sheets;
}

/** The audit log with the same filters as its admin page. */
async function auditSheet(range: DateRange, filters: AuditFilters): Promise<Sheet> {
    const rows = await filteredAuditLogs({ ...filters, from: range.from, to: range.to })
        .orderBy("log.createdAt", "DESC")
        .take(MAX_REPORT_ROWS)
        .getMany();
    return {
        name: "Audit log",
        columns: [
            { header: "Time", type: "datetime", width: 18 },
            { header: "Category", width: 10 },
            { header: "Action", width: 30 },
            { header: "Outcome", width: 10 },
            { header: "Actor type", width: 10 },
            { header: "User id", width: 38 },
            { header: "User email", width: 28 },
            { header: "Role", width: 10 },
            { header: "Entity type", width: 16 },
            { header: "Entity id", width: 38 },
            { header: "Summary", width: 50 },
            { header: "Method", width: 8 },
            { header: "Endpoint", width: 40 },
            { header: "Status", type: "number", width: 8 },
            { header: "Duration (ms)", type: "number", width: 12 },
            { header: "Request id", width: 38 },
            { header: "Details", width: 60 },
        ],
        rows: rows.map((row) => [
            row.createdAt, row.category, row.action, row.outcome, row.actorType, row.actorId, row.actorEmail, row.actorRole,
            row.entityType, row.entityId, row.summary, row.method, row.route ?? row.path, row.statusCode, row.durationMs, row.requestId,
            Object.keys(row.data).length ? JSON.stringify(row.data) : null,
        ]),
    };
}

export async function buildReport(
    type: ReportType,
    range: DateRange,
    options: { includeInbox: boolean; statuses?: string[]; auditFilters?: AuditFilters },
) {
    if (type === "overview") return overviewSheets(range, options.includeInbox);
    if (type === "audit") return [await auditSheet(range, options.auditFilters ?? {})];
    const bounds = dayRange(range.from, range.to) as Range;
    const builders = {
        applications: applicationsSheet,
        interviews: interviewsSheet,
        jobs: jobsSheet,
        messages: messagesSheet,
        bookings: bookingsSheet,
        employees: employeesSheet,
        overtime: overtimeSheet,
    };
    return [await builders[type](bounds, options.statuses)];
}

/** One CSV holds one table, so the overview flattens its sheets into "section, item, value" rows. */
export function flattenSheets(sheets: Sheet[]): Sheet {
    if (sheets.length === 1) return sheets[0]!;
    return {
        name: "Overview",
        columns: [{ header: "Section" }, { header: "Item" }, { header: "Value", type: "number" }, { header: "Previous", type: "number" }, { header: "Change", type: "percent" }],
        rows: sheets.flatMap((sheet) =>
            sheet.rows.map((row) => {
                const [item, ...values] = row;
                const label = item instanceof Date ? item.toISOString().slice(0, 10) : item;
                if (sheet.name === "Timeline") {
                    return sheet.columns.slice(1).map((column, index) => [sheet.name, `${label} · ${column.header}`, values[index], null, null]);
                }
                if (sheet.name === "Top vacancies") return [[sheet.name, `${row[0]} · ${row[1]}`, row[2], null, null]];
                if (sheet.name === "Summary") return [[sheet.name, label, values[0], values[1], values[2]]];
                return [[sheet.name, label, values[0], null, null]];
            }).flat() as CellValue[][],
        ),
    };
}
