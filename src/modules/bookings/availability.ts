import { Between, In } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { ACTIVE_BOOKING_STATUSES, CallBooking } from "../../entities/call-booking.entity.js";
import { addDays, zonedDate, zonedTimeToUtc } from "../../lib/timezone.js";
import { scheduleForDate, type BookingSchedule } from "./settings.js";

export type DayAvailability = { date: string; slots: string[] };

export const MAX_RANGE_DAYS = 62;

/** Every scheduled slot between two calendar dates (inclusive, in the schedule's timezone), ignoring existing bookings. */
function candidateSlots(schedule: BookingSchedule, from: string, to: string, now: Date): Map<string, Date[]> {
    const earliest = now.getTime() + schedule.minLeadHours * 3600_000;
    const latest = now.getTime() + schedule.maxDaysAhead * 86400_000;
    const days = new Map<string, Date[]>();

    for (let date = from; date <= to; date = addDays(date, 1)) {
        const slots = scheduleForDate(schedule, date)
            .times.map((time) => zonedTimeToUtc(date, time, schedule.timezone))
            .filter((slot) => slot.getTime() >= earliest && slot.getTime() <= latest);
        if (slots.length) days.set(date, slots);
    }
    return days;
}

export async function getAvailability(
    schedule: BookingSchedule,
    from: string,
    to: string,
    now = new Date(),
): Promise<DayAvailability[]> {
    const candidates = candidateSlots(schedule, from, to, now);
    const all = [...candidates.values()].flat();
    if (!all.length) return [];

    const taken = await AppDataSource.getRepository(CallBooking).find({
        select: { startsAt: true },
        where: {
            status: In(ACTIVE_BOOKING_STATUSES),
            startsAt: Between(all[0]!, all[all.length - 1]!),
        },
    });
    const takenTimes = new Set(taken.map((booking) => booking.startsAt.getTime()));

    return [...candidates.entries()]
        .map(([date, slots]) => ({
            date,
            slots: slots.filter((slot) => !takenTimes.has(slot.getTime())).map((slot) => slot.toISOString()),
        }))
        .filter((day) => day.slots.length > 0);
}

/** True when `startsAt` is one of the scheduled, bookable slot times (ignores whether it is taken). */
export function isBookableSlot(schedule: BookingSchedule, startsAt: Date, now = new Date()): boolean {
    const date = zonedDate(startsAt, schedule.timezone);
    return (candidateSlots(schedule, date, date, now).get(date) ?? []).some(
        (slot) => slot.getTime() === startsAt.getTime(),
    );
}
