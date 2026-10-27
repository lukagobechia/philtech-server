import { Router } from "express";
import { Between } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../../config/database.js";
import { AdminRole } from "../../entities/admin-user.entity.js";
import { CallBooking, CallBookingStatus } from "../../entities/call-booking.entity.js";
import { InterviewStatus } from "../../entities/interview.entity.js";
import { enumList } from "../../lib/listing.js";
import { MAX_RANGE_DAYS } from "../bookings/availability.js";
import { getBookingSchedule } from "../bookings/settings.js";
import { interviewsInRange } from "../interviews/interviews.service.js";

const rangeQuery = z
    .object({
        from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
        to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
        kind: enumList({ booking: "booking", interview: "interview" }).optional(),
        // Statuses of either kind, e.g. "requested,confirmed,scheduled".
        status: enumList({ ...CallBookingStatus, ...InterviewStatus }).optional(),
    })
    .refine(({ from, to }) => from < to && to.getTime() - from.getTime() <= MAX_RANGE_DAYS * 86400_000, {
        message: `Range must be ascending and at most ${MAX_RANGE_DAYS} days`,
        path: ["to"],
    });

const plusMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000).toISOString();

/** One feed for the admin calendar: call bookings (admins only) and interviews (all staff). */
export const calendarRouter = Router();

calendarRouter.get("/", async (req, res) => {
    const { from, to, kind, status } = rangeQuery.parse(req.query);
    const canSeeBookings = req.admin!.role === AdminRole.ADMIN;
    const wants = (value: "booking" | "interview") => !kind || kind.includes(value);
    const statuses = status ? new Set<string>(status) : null;

    const [schedule, bookings, interviews] = await Promise.all([
        getBookingSchedule(),
        canSeeBookings && wants("booking")
            ? AppDataSource.getRepository(CallBooking).find({ where: { startsAt: Between(from, to) }, order: { startsAt: "ASC" }, take: 1000 })
            : Promise.resolve([]),
        wants("interview") ? interviewsInRange(from, to) : Promise.resolve([]),
    ]);
    const keep = (event: { status: string }) => !statuses || statuses.has(event.status);

    const events = [
        ...bookings.map(({ ipHash: _ipHash, ...booking }) => ({
            kind: "booking" as const,
            id: booking.id,
            startsAt: booking.startsAt.toISOString(),
            endsAt: plusMinutes(booking.startsAt, schedule.slotMinutes),
            status: booking.status,
            booking,
        })),
        ...interviews.map((interview) => ({
            kind: "interview" as const,
            id: interview.id,
            startsAt: interview.startsAt.toISOString(),
            endsAt: plusMinutes(interview.startsAt, interview.durationMinutes),
            status: interview.status,
            interview,
        })),
    ]
        .filter(keep)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

    res.json({ kinds: canSeeBookings ? ["booking", "interview"] : ["interview"], events });
});
