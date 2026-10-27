import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppDataSource } from "../../config/database.js";
import { env } from "../../config/env.js";
import { BookingSettings, type AvailabilityRule, type DateOverride } from "../../entities/booking-settings.entity.js";
import { addDays, isoWeekday, isValidTimeZone } from "../../lib/timezone.js";

export type { AvailabilityRule, DateOverride };

export type BookingSchedule = Pick<
    BookingSettings,
    "timezone" | "slotMinutes" | "minLeadHours" | "maxDaysAhead" | "rules" | "dateOverrides"
>;

const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

const DAY_MS = 86400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const mondayOf = (date: string) => addDays(date, 1 - isoWeekday(date));

/** Keeps times in order and drops any that would start before the previous call ends. */
function withoutOverlaps(times: string[], slotMinutes: number): string[] {
    const result: string[] = [];
    for (const time of [...new Set(times)].sort()) {
        const previous = result[result.length - 1];
        if (!previous || toMinutes(time) - toMinutes(previous) >= slotMinutes) result.push(time);
    }
    return result;
}

function ruleOccursOn(rule: AvailabilityRule, date: string): boolean {
    if (!rule.weekdays.includes(isoWeekday(date))) return false;
    if (rule.startDate && date < rule.startDate) return false;
    if (rule.endDate && date > rule.endDate) return false;
    if (rule.intervalWeeks <= 1) return true;
    // Every N weeks, counted from the week the rule starts in.
    const weeks = daysBetween(mondayOf(rule.startDate ?? date), mondayOf(date)) / 7;
    return weeks % rule.intervalWeeks === 0;
}

export type DaySchedule = { times: string[]; source: "override" | "rules" };

/** Local start times offered on `date` (YYYY-MM-DD in the schedule's timezone), before lead time and bookings. */
export function scheduleForDate(schedule: BookingSchedule, date: string): DaySchedule {
    const override = schedule.dateOverrides.find((item) => item.date === date);
    if (override) return { times: withoutOverlaps(override.times, schedule.slotMinutes), source: "override" };

    const times = schedule.rules.filter((rule) => ruleOccursOn(rule, date)).flatMap((rule) => rule.times);
    return { times: withoutOverlaps(times, schedule.slotMinutes), source: "rules" };
}

// ---- Validation ----

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");

const sortedTimes = z
    .array(time)
    .max(48)
    .transform((times) => [...new Set(times)].sort());

function checkOverlaps(times: string[], slotMinutes: number, ctx: z.RefinementCtx, path: (string | number)[]) {
    for (let i = 1; i < times.length; i++) {
        if (toMinutes(times[i]!) - toMinutes(times[i - 1]!) < slotMinutes) {
            ctx.addIssue({
                code: "custom",
                path,
                message: `${times[i - 1]} and ${times[i]} overlap with ${slotMinutes}-minute calls`,
            });
        }
    }
}

const ruleSchema = z
    .object({
        id: z.string().max(64).optional(),
        label: z
            .string()
            .trim()
            .max(60)
            .nullish()
            .transform((value) => value || null),
        weekdays: z
            .array(z.number().int().min(1).max(7))
            .min(1, "Pick at least one weekday")
            .transform((days) => [...new Set(days)].sort()),
        times: sortedTimes.refine((times) => times.length > 0, "Add at least one time"),
        startDate: z.iso.date().nullish().transform((value) => value ?? null),
        endDate: z.iso.date().nullish().transform((value) => value ?? null),
        intervalWeeks: z.number().int().min(1).max(8).default(1),
    })
    .refine((rule) => !rule.startDate || !rule.endDate || rule.startDate <= rule.endDate, {
        message: "End date must be on or after the start date",
        path: ["endDate"],
    })
    .refine((rule) => rule.intervalWeeks === 1 || rule.startDate, {
        message: "Repeating every few weeks needs a start date",
        path: ["startDate"],
    })
    .transform((rule): AvailabilityRule => ({ ...rule, id: rule.id || randomUUID() }));

const overrideSchema = z.object({
    date: z.iso.date(),
    times: sortedTimes,
});

export const bookingScheduleBody = z
    .object({
        timezone: z.string().max(64).refine(isValidTimeZone, "Unknown timezone"),
        slotMinutes: z.number().int().min(5).max(480),
        minLeadHours: z.number().int().min(0).max(24 * 30),
        maxDaysAhead: z.number().int().min(1).max(365),
        rules: z.array(ruleSchema).max(50),
        dateOverrides: z
            .array(overrideSchema)
            .max(366)
            .refine((items) => new Set(items.map((item) => item.date)).size === items.length, "Each date can only be set once")
            .transform((items) => [...items].sort((a, b) => a.date.localeCompare(b.date))),
    })
    .superRefine((value, ctx) => {
        // A call must end before the next one in the same rule or date starts.
        value.rules.forEach((rule, i) => checkOverlaps(rule.times, value.slotMinutes, ctx, ["rules", i, "times"]));
        value.dateOverrides.forEach((item, i) => checkOverlaps(item.times, value.slotMinutes, ctx, ["dateOverrides", i, "times"]));
    });

// ---- Storage ----

/** The schedule from env, used until an admin saves one. */
function defaultSchedule(): BookingSchedule {
    return {
        timezone: env.BOOKING_TIMEZONE,
        slotMinutes: env.BOOKING_SLOT_MINUTES,
        minLeadHours: env.BOOKING_MIN_LEAD_HOURS,
        maxDaysAhead: env.BOOKING_MAX_DAYS_AHEAD,
        rules: [
            {
                id: "default",
                label: null,
                weekdays: [...env.BOOKING_WEEKDAYS].sort(),
                times: [...env.BOOKING_SLOTS].sort(),
                startDate: null,
                endDate: null,
                intervalWeeks: 1,
            },
        ],
        dateOverrides: [],
    };
}

const repository = () => AppDataSource.getRepository(BookingSettings);

export async function getBookingSchedule(): Promise<BookingSchedule> {
    const [row] = await repository().find({ order: { createdAt: "ASC" }, take: 1 });
    if (!row) return defaultSchedule();
    const { timezone, slotMinutes, minLeadHours, maxDaysAhead, rules, dateOverrides } = row;
    return { timezone, slotMinutes, minLeadHours, maxDaysAhead, rules, dateOverrides };
}

export async function saveBookingSchedule(schedule: BookingSchedule): Promise<BookingSchedule> {
    const [row] = await repository().find({ order: { createdAt: "ASC" }, take: 1 });
    if (row) await repository().update(row.id, schedule as never);
    else await repository().insert(schedule as never);
    return getBookingSchedule();
}
