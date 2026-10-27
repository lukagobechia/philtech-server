import { z } from "zod";
import { Brackets, In, LessThanOrEqual, type EntityManager } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { EmployeeEvent, EmployeeEventType } from "../../entities/employee-event.entity.js";
import { Employee, EmployeeStatus, type ScheduleBlock } from "../../entities/employee.entity.js";
import type { JobApplication } from "../../entities/job-application.entity.js";
import { OvertimeEntry, OvertimeStatus } from "../../entities/overtime-entry.entity.js";
import { HttpError } from "../../lib/http-error.js";
import { dayRange, likePattern } from "../../lib/listing.js";
import { paginated, toSkipTake, type Pagination } from "../../lib/pagination.js";
import { schemas } from "../../lib/schemas.js";
import { addDays, isoWeekday, zonedDate, zonedParts, zonedTimeToUtc } from "../../lib/timezone.js";
import { auditedJob, recordAudit } from "../audit/audit.service.js";
import { companyDate } from "../jobs/jobs.service.js";

// ---- Validation ----

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use HH:MM");
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

/** Weekly blocks; same-day only (end after start), no overlaps within a day. */
export const scheduleSchema = z
    .array(z.object({ weekday: z.number().int().min(1).max(7), start: time, end: time }))
    .max(50)
    .superRefine((blocks, ctx) => {
        blocks.forEach((block, index) => {
            if (minutes(block.end) <= minutes(block.start)) {
                ctx.addIssue({ code: "custom", path: [index, "end"], message: "End must be after start" });
            }
        });
        for (let weekday = 1; weekday <= 7; weekday++) {
            const day = blocks.filter((block) => block.weekday === weekday).sort((a, b) => minutes(a.start) - minutes(b.start));
            for (let i = 1; i < day.length; i++) {
                if (minutes(day[i]!.start) < minutes(day[i - 1]!.end)) {
                    ctx.addIssue({ code: "custom", path: [], message: `Working hours overlap on weekday ${weekday}` });
                }
            }
        }
    })
    .transform((blocks) => [...blocks].sort((a, b) => a.weekday - b.weekday || minutes(a.start) - minutes(b.start)));

const employeeFields = {
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: schemas.email,
    phone: z.union([z.literal(""), schemas.phone]).nullish().transform((value) => value || null),
    position: z.string().trim().min(1).max(160),
    department: z.string().trim().max(120).nullish().transform((value) => value || null),
    startDate: z.iso.date(),
    notes: z.string().trim().max(5000).nullish().transform((value) => value || null),
    schedule: scheduleSchema,
};

export const createEmployeeBody = z.object({
    ...employeeFields,
    startDate: employeeFields.startDate.optional(),
    schedule: employeeFields.schedule.default([]),
});

export const updateEmployeeBody = z
    .object({ ...employeeFields, status: z.enum(EmployeeStatus) })
    .partial()
    .refine((value) => Object.keys(value).length > 0, "Nothing to update");

const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const startOvertimeBody = z
    .object({
        reason: z.string().trim().min(1, "Say why the overtime is needed").max(500),
        // Defaults to now; earlier times register overtime that already started.
        startedAt: instant.optional(),
        // Ends the overtime automatically at this time.
        plannedEndAt: instant.nullish(),
        // Registers overtime that already happened, start to end.
        endedAt: instant.nullish(),
    })
    .refine((v) => !(v.plannedEndAt && v.endedAt), { message: "Give a planned end or an end, not both", path: ["plannedEndAt"] });

export const updateOvertimeBody = z
    .object({ reason: z.string().trim().min(1).max(500), startedAt: instant, endedAt: instant, plannedEndAt: instant.nullable() })
    .partial()
    .refine((value) => Object.keys(value).length > 0, "Nothing to update");

export const endOvertimeBody = z.object({ endedAt: instant.optional() });

// ---- Presence ----

export type Presence =
    | { state: "overtime"; since: string; until: string | null; overtimeId: string }
    | { state: "working"; until: string }
    | { state: "off"; nextShiftAt: string | null };

const CLOCK_SKEW_MS = 60_000;

/** Where an employee is right now: on overtime, inside a scheduled block, or off until the next one. */
export function presenceOf(employee: Pick<Employee, "schedule">, overtime: OvertimeEntry | undefined, now = new Date()): Presence {
    if (overtime) {
        return { state: "overtime", since: overtime.startedAt.toISOString(), until: overtime.plannedEndAt?.toISOString() ?? null, overtimeId: overtime.id };
    }
    const tz = env.COMPANY_TIMEZONE;
    const today = zonedDate(now, tz);
    const parts = zonedParts(now, tz);
    const nowMinutes = parts.hour * 60 + parts.minute;
    const weekday = isoWeekday(today);

    const current = employee.schedule.find(
        (block) => block.weekday === weekday && minutes(block.start) <= nowMinutes && nowMinutes < minutes(block.end),
    );
    if (current) return { state: "working", until: zonedTimeToUtc(today, current.end, tz).toISOString() };

    for (let offset = 0; offset < 8; offset++) {
        const date = addDays(today, offset);
        const next = employee.schedule
            .filter((block) => block.weekday === isoWeekday(date) && (offset > 0 || minutes(block.start) > nowMinutes))
            .sort((a, b) => minutes(a.start) - minutes(b.start))[0];
        if (next) return { state: "off", nextShiftAt: zonedTimeToUtc(date, next.start, tz).toISOString() };
    }
    return { state: "off", nextShiftAt: null };
}

// ---- Helpers ----

const employees = () => AppDataSource.getRepository(Employee);
const overtimeEntries = () => AppDataSource.getRepository(OvertimeEntry);

async function logEvent(manager: EntityManager, employeeId: string, type: EmployeeEventType, actorId: string | null, data: Record<string, unknown> = {}) {
    // JSON round trip: dates become ISO strings, undefined values are dropped.
    await manager.getRepository(EmployeeEvent).insert({ employeeId, type, actorId, data: JSON.parse(JSON.stringify(data)) as never });
    const entityType = type.startsWith("overtime_") ? "overtime" : "employee";
    await recordAudit(
        {
            action: entityType === "overtime" ? `overtime.${type.slice("overtime_".length)}` : `employee.${type}`,
            entityType,
            entityId: entityType === "overtime" ? String(data.overtimeId ?? employeeId) : employeeId,
            summary: entityType === "overtime" ? `Overtime ${type.slice("overtime_".length)}` : `Employee ${type.replace(/_/g, " ")}`,
            data: { employeeId, ...data },
        },
        manager,
    );
}

async function employeeOrThrow(manager: EntityManager, id: string): Promise<Employee> {
    const employee = await manager.getRepository(Employee).findOneBy({ id });
    if (!employee) throw HttpError.notFound("Employee not found");
    return employee;
}

async function activeOvertimeFor(employeeIds: string[]): Promise<Map<string, OvertimeEntry>> {
    if (!employeeIds.length) return new Map();
    const rows = await overtimeEntries().findBy({ employeeId: In(employeeIds), status: OvertimeStatus.ACTIVE });
    return new Map(rows.map((row) => [row.employeeId, row]));
}

async function assertEmailFree(manager: EntityManager, email: string, exceptId?: string) {
    const existing = await manager.getRepository(Employee).findOne({ where: { email }, select: { id: true } });
    if (existing && existing.id !== exceptId) throw HttpError.conflict("EMAIL_TAKEN", "An employee with this email already exists");
}

const durationMinutes = (entry: Pick<OvertimeEntry, "startedAt" | "endedAt" | "status">, now = new Date()) =>
    entry.status === OvertimeStatus.CANCELLED ? 0 : Math.max(0, Math.round(((entry.endedAt ?? now).getTime() - entry.startedAt.getTime()) / 60_000));

const withPresence = (employee: Employee, overtime: Map<string, OvertimeEntry>, now = new Date()) => ({
    ...employee,
    presence: employee.status === EmployeeStatus.ACTIVE ? presenceOf(employee, overtime.get(employee.id), now) : null,
});

// ---- Employees ----

export type EmployeeListQuery = Pagination & {
    q?: string;
    status?: EmployeeStatus;
    department?: string;
    applicationId?: string;
    sort: "name" | "newest" | "startDate";
};

export async function listEmployees(query: EmployeeListQuery) {
    const qb = employees().createQueryBuilder("e");
    if (query.status) qb.andWhere("e.status = :status", { status: query.status });
    if (query.department) qb.andWhere("e.department = :department", { department: query.department });
    if (query.applicationId) qb.andWhere("e.applicationId = :applicationId", { applicationId: query.applicationId });
    if (query.q) {
        qb.andWhere(
            new Brackets((inner) =>
                ["firstName", "lastName", "email", "position", "department", "jobCode"].forEach((column, index) =>
                    index ? inner.orWhere(`e.${column} ILIKE :like`) : inner.where(`e.${column} ILIKE :like`),
                ),
            ),
            { like: likePattern(query.q) },
        );
    }
    if (query.sort === "name") qb.orderBy("e.lastName", "ASC").addOrderBy("e.firstName", "ASC");
    else if (query.sort === "startDate") qb.orderBy("e.startDate", "DESC");
    else qb.orderBy("e.createdAt", "DESC");
    qb.addOrderBy("e.id", "ASC");

    const { skip, take } = toSkipTake(query);
    const [items, total] = await qb.skip(skip).take(take).getManyAndCount();
    const overtime = await activeOvertimeFor(items.map((item) => item.id));
    return paginated(items.map((item) => withPresence(item, overtime)), total, query);
}

export async function getEmployee(id: string) {
    const employee = await employeeOrThrow(AppDataSource.manager, id);
    return withPresence(employee, await activeOvertimeFor([id]));
}

export async function createEmployee(input: z.infer<typeof createEmployeeBody>, actorId: string) {
    return AppDataSource.transaction(async (manager) => {
        await assertEmailFree(manager, input.email);
        const employee = await manager.getRepository(Employee).save({ ...input, startDate: input.startDate ?? companyDate() });
        await logEvent(manager, employee.id, EmployeeEventType.CREATED, actorId, { position: employee.position });
        if (employee.schedule.length) await logEvent(manager, employee.id, EmployeeEventType.SCHEDULE_UPDATED, actorId, { schedule: employee.schedule });
        return employee;
    });
}

/**
 * Called when an application is set to hired: adds the candidate to the employees list.
 * An existing employee with the same email (e.g. added by hand earlier) is linked instead of duplicated.
 */
export async function hireFromApplication(manager: EntityManager, application: JobApplication, actorId: string | null): Promise<Employee> {
    const repository = manager.getRepository(Employee);
    const linked = await repository.findOneBy({ applicationId: application.id });
    if (linked) {
        if (linked.status === EmployeeStatus.INACTIVE) {
            await repository.update(linked.id, { status: EmployeeStatus.ACTIVE });
            await logEvent(manager, linked.id, EmployeeEventType.REACTIVATED, actorId, { applicationId: application.id });
        }
        return linked;
    }

    const byEmail = await repository.findOneBy({ email: application.email });
    const employee = byEmail
        ? await repository.save({ ...byEmail, applicationId: byEmail.applicationId ?? application.id, jobCode: byEmail.jobCode ?? application.jobCode, status: EmployeeStatus.ACTIVE })
        : await repository.save({
              firstName: application.firstName,
              lastName: application.lastName,
              email: application.email,
              phone: application.phone,
              position: application.jobTitle,
              startDate: companyDate(),
              applicationId: application.id,
              jobCode: application.jobCode,
          });
    await logEvent(manager, employee.id, EmployeeEventType.HIRED, actorId, {
        applicationId: application.id,
        jobCode: application.jobCode,
        position: application.jobTitle,
    });
    return employee;
}

export async function updateEmployee(id: string, input: z.infer<typeof updateEmployeeBody>, actorId: string) {
    return AppDataSource.transaction(async (manager) => {
        const existing = await employeeOrThrow(manager, id);
        if (input.email && input.email !== existing.email) await assertEmailFree(manager, input.email, id);
        await manager.getRepository(Employee).update(id, input);

        const { schedule, status, ...fields } = input;
        const changed = Object.keys(fields).filter((key) => fields[key as keyof typeof fields] !== existing[key as keyof Employee]);
        if (changed.length) {
            await logEvent(manager, id, EmployeeEventType.UPDATED, actorId, {
                changes: Object.fromEntries(changed.map((key) => [key, { from: existing[key as keyof Employee], to: fields[key as keyof typeof fields] }])),
            });
        }
        if (schedule && JSON.stringify(schedule) !== JSON.stringify(existing.schedule)) {
            await logEvent(manager, id, EmployeeEventType.SCHEDULE_UPDATED, actorId, { from: existing.schedule, schedule });
        }
        if (status && status !== existing.status) {
            if (status === EmployeeStatus.INACTIVE) {
                // Leaving staff can't stay on the clock.
                const active = await manager.getRepository(OvertimeEntry).findOneBy({ employeeId: id, status: OvertimeStatus.ACTIVE });
                if (active) await finishOvertime(manager, active, new Date(), actorId, { reason: "deactivated" });
            }
            await logEvent(manager, id, status === EmployeeStatus.INACTIVE ? EmployeeEventType.DEACTIVATED : EmployeeEventType.REACTIVATED, actorId);
        }
        return manager.getRepository(Employee).findOneByOrFail({ id });
    }).then(async (employee) => withPresence(employee, await activeOvertimeFor([id])));
}

/** Everyone active, with who is working, on overtime or off right now. */
export async function employeeBoard(now = new Date()) {
    const active = await employees().find({ where: { status: EmployeeStatus.ACTIVE }, order: { lastName: "ASC", firstName: "ASC" } });
    const overtime = await activeOvertimeFor(active.map((employee) => employee.id));
    const items = active.map((employee) => withPresence(employee, overtime, now));
    const count = (state: Presence["state"]) => items.filter((item) => item.presence?.state === state).length;
    return {
        now: now.toISOString(),
        timezone: env.COMPANY_TIMEZONE,
        counts: { overtime: count("overtime"), working: count("working"), off: count("off"), total: items.length },
        items,
    };
}

export async function listEmployeeEvents(employeeId: string, query: Pagination) {
    await employeeOrThrow(AppDataSource.manager, employeeId);
    const { skip, take } = toSkipTake(query);
    const [items, total] = await AppDataSource.getRepository(EmployeeEvent).findAndCount({
        where: { employeeId },
        relations: { actor: true },
        order: { createdAt: "DESC" },
        skip,
        take,
    });
    return paginated(
        items.map(({ actor, ...event }) => ({ ...event, actor: actor ? { id: actor.id, displayName: actor.displayName } : null })),
        total,
        query,
    );
}

// ---- Overtime ----

/** Ends an active entry; false if it was no longer active (e.g. ended by hand at the same moment). */
async function finishOvertime(manager: EntityManager, entry: OvertimeEntry, endedAt: Date, actorId: string | null, extra: Record<string, unknown> = {}) {
    const result = await manager
        .getRepository(OvertimeEntry)
        .update({ id: entry.id, status: OvertimeStatus.ACTIVE }, { status: OvertimeStatus.COMPLETED, endedAt, endedById: actorId });
    if (!result.affected) return false;
    await logEvent(manager, entry.employeeId, EmployeeEventType.OVERTIME_ENDED, actorId, {
        overtimeId: entry.id,
        startedAt: entry.startedAt,
        endedAt,
        minutes: durationMinutes({ ...entry, endedAt, status: OvertimeStatus.COMPLETED }),
        ...extra,
    });
    return true;
}

function assertTimes(startedAt: Date, end: Date | null | undefined, now = new Date()) {
    if (startedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) throw HttpError.badRequest("Overtime can't start in the future", { startedAt: ["Must not be in the future"] });
    if (end && end <= startedAt) throw HttpError.badRequest("The end must be after the start", { endedAt: ["Must be after the start"] });
}

export async function startOvertime(employeeId: string, input: z.infer<typeof startOvertimeBody>, actorId: string) {
    const now = new Date();
    const startedAt = input.startedAt ?? now;
    assertTimes(startedAt, input.endedAt ?? input.plannedEndAt);
    if (input.endedAt && input.endedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
        throw HttpError.badRequest("A finished overtime can't end in the future; use a planned end instead", { endedAt: ["Must not be in the future"] });
    }

    return AppDataSource.transaction(async (manager) => {
        const employee = await employeeOrThrow(manager, employeeId);
        if (employee.status !== EmployeeStatus.ACTIVE) throw HttpError.conflict("EMPLOYEE_INACTIVE", "The employee is not active");
        const finished = Boolean(input.endedAt);
        if (!finished && (await manager.getRepository(OvertimeEntry).existsBy({ employeeId, status: OvertimeStatus.ACTIVE }))) {
            throw HttpError.conflict("OVERTIME_ACTIVE", "This employee is already on overtime");
        }

        const entry = await manager.getRepository(OvertimeEntry).save({
            employeeId,
            reason: input.reason,
            startedAt,
            plannedEndAt: input.plannedEndAt ?? null,
            endedAt: input.endedAt ?? null,
            status: finished ? OvertimeStatus.COMPLETED : OvertimeStatus.ACTIVE,
            startedById: actorId,
            endedById: finished ? actorId : null,
        });
        await logEvent(manager, employeeId, EmployeeEventType.OVERTIME_STARTED, actorId, {
            overtimeId: entry.id,
            reason: entry.reason,
            startedAt: entry.startedAt,
            plannedEndAt: entry.plannedEndAt,
            ...(finished ? { endedAt: entry.endedAt, minutes: durationMinutes(entry), registeredAfterwards: true } : {}),
        });
        return entry;
    });
}

async function overtimeOrThrow(manager: EntityManager, id: string): Promise<OvertimeEntry> {
    const entry = await manager.getRepository(OvertimeEntry).findOneBy({ id });
    if (!entry) throw HttpError.notFound("Overtime entry not found");
    return entry;
}

export async function endOvertime(id: string, input: z.infer<typeof endOvertimeBody>, actorId: string) {
    return AppDataSource.transaction(async (manager) => {
        const entry = await overtimeOrThrow(manager, id);
        if (entry.status !== OvertimeStatus.ACTIVE) throw HttpError.conflict("OVERTIME_NOT_ACTIVE", "This overtime has already ended");
        const endedAt = input.endedAt ?? new Date();
        assertTimes(entry.startedAt, endedAt);
        if (!(await finishOvertime(manager, entry, endedAt, actorId))) {
            throw HttpError.conflict("OVERTIME_NOT_ACTIVE", "This overtime has already ended");
        }
        return manager.getRepository(OvertimeEntry).findOneByOrFail({ id });
    });
}

/** Corrections are allowed, and logged with the values before and after. */
export async function updateOvertime(id: string, input: z.infer<typeof updateOvertimeBody>, actorId: string) {
    return AppDataSource.transaction(async (manager) => {
        const entry = await overtimeOrThrow(manager, id);
        if (entry.status === OvertimeStatus.CANCELLED) throw HttpError.conflict("OVERTIME_CANCELLED", "Cancelled overtime can't be changed");
        if (input.endedAt && entry.status === OvertimeStatus.ACTIVE) {
            throw HttpError.badRequest("End the overtime to set its end time", { endedAt: ["Use End overtime"] });
        }
        const next = { ...entry, ...input };
        assertTimes(next.startedAt, next.endedAt ?? next.plannedEndAt);

        await manager.getRepository(OvertimeEntry).update(id, input);
        const changes = Object.fromEntries(
            Object.entries(input).map(([key, value]) => [key, { from: entry[key as keyof OvertimeEntry], to: value }]),
        );
        await logEvent(manager, entry.employeeId, EmployeeEventType.OVERTIME_UPDATED, actorId, { overtimeId: id, changes });
        return manager.getRepository(OvertimeEntry).findOneByOrFail({ id });
    });
}

export async function cancelOvertime(id: string, actorId: string) {
    return AppDataSource.transaction(async (manager) => {
        const entry = await overtimeOrThrow(manager, id);
        if (entry.status === OvertimeStatus.CANCELLED) return entry;
        await manager.getRepository(OvertimeEntry).update(id, { status: OvertimeStatus.CANCELLED, endedAt: entry.endedAt ?? new Date(), endedById: actorId });
        await logEvent(manager, entry.employeeId, EmployeeEventType.OVERTIME_CANCELLED, actorId, {
            overtimeId: id,
            startedAt: entry.startedAt,
            reason: entry.reason,
        });
        return manager.getRepository(OvertimeEntry).findOneByOrFail({ id });
    });
}

export type OvertimeListQuery = Pagination & { employeeId?: string; status?: OvertimeStatus[]; from?: string; to?: string };

/** The overtime log: entries that started in the range, with durations and totals. */
export async function listOvertime(query: OvertimeListQuery, now = new Date()) {
    const qb = overtimeEntries()
        .createQueryBuilder("o")
        .innerJoinAndSelect("o.employee", "employee")
        .leftJoinAndSelect("o.startedBy", "startedBy")
        .leftJoinAndSelect("o.endedBy", "endedBy")
        .orderBy("o.startedAt", "DESC")
        .addOrderBy("o.id", "ASC");
    if (query.employeeId) qb.andWhere("o.employeeId = :employeeId", { employeeId: query.employeeId });
    if (query.status) qb.andWhere("o.status IN (:...status)", { status: query.status });
    const { start, end } = dayRange(query.from, query.to);
    if (start) qb.andWhere("o.startedAt >= :start", { start });
    if (end) qb.andWhere("o.startedAt < :end", { end });

    // Totals cover every matching entry, not just this page.
    const all = await qb.clone().select(["o.startedAt", "o.endedAt", "o.status"]).getMany();
    const totalMinutes = all.reduce((sum, entry) => sum + durationMinutes(entry, now), 0);

    const { skip, take } = toSkipTake(query);
    const [items, total] = await qb.skip(skip).take(take).getManyAndCount();
    const person = (user: { id: string; displayName: string } | null) => (user ? { id: user.id, displayName: user.displayName } : null);
    return {
        ...paginated(
            items.map(({ employee, startedBy, endedBy, ...entry }) => ({
                ...entry,
                durationMinutes: durationMinutes(entry, now),
                employee: { id: employee.id, name: `${employee.firstName} ${employee.lastName}`, position: employee.position },
                startedBy: person(startedBy),
                endedBy: person(endedBy),
            })),
            total,
            query,
        ),
        totals: { entries: total, minutes: totalMinutes },
    };
}

/** Ends overtime whose planned end has passed; runs on the scheduler. */
export async function runOvertimeSchedule(now = new Date()): Promise<number> {
    const due = await overtimeEntries().findBy({ status: OvertimeStatus.ACTIVE, plannedEndAt: LessThanOrEqual(now) });
    let ended = 0;
    for (const entry of due) {
        if (await AppDataSource.transaction((manager) => finishOvertime(manager, entry, entry.plannedEndAt!, null, { automatic: true }))) ended++;
    }
    if (ended) logger.info({ ended }, "Planned overtime ended");
    return ended;
}

export function startOvertimeScheduler(intervalMs = 30_000): () => void {
    const run = () =>
        auditedJob("overtime_schedule", async () => {
            const ended = await runOvertimeSchedule();
            return { didWork: ended > 0, summary: `Ended ${ended} planned overtime entries`, data: { ended } };
        });
    void run();
    const timer = setInterval(run, intervalMs);
    return () => clearInterval(timer);
}

export type { ScheduleBlock };
