import { Router } from "express";
import { QueryFailedError } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../../config/database.js";
import { CallBooking, CallBookingStatus } from "../../entities/call-booking.entity.js";
import { AdminRole } from "../../entities/admin-user.entity.js";
import { ContactService } from "../../entities/contact-message.entity.js";
import { hashIp } from "../../lib/crypto.js";
import { HttpError } from "../../lib/http-error.js";
import { schemas } from "../../lib/schemas.js";
import { acceptSubmission } from "../../lib/submission.js";
import { addDays, isValidTimeZone, zonedDate } from "../../lib/timezone.js";
import { submissionLimiter } from "../../middleware/rate-limit.js";
import { requireRole } from "../../middleware/require-admin.js";
import { adminCrudRouter } from "../admin/crud.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueEmails, notificationPair } from "../email/outbox.js";
import { getAvailability, isBookableSlot, MAX_RANGE_DAYS } from "./availability.js";
import { bookingScheduleBody, getBookingSchedule, saveBookingSchedule, scheduleForDate } from "./settings.js";

const availabilityQuery = z
    .object({
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
    })
    .refine(({ from, to }) => !from || !to || (from <= to && to <= addDays(from, MAX_RANGE_DAYS)), {
        message: `Range must be ascending and at most ${MAX_RANGE_DAYS} days`,
        path: ["to"],
    });

const createBookingBody = z.object({
    name: schemas.name,
    email: schemas.email,
    phone: schemas.phone.optional().or(z.literal("").transform(() => undefined)),
    startsAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    timezone: z.string().max(64).refine(isValidTimeZone, "Unknown timezone").optional(),
    service: z.enum(ContactService).optional(),
    notes: schemas.optionalTrimmed(2000),
    locale: schemas.locale,
    website: schemas.honeypot,
});

const isUniqueViolation = (error: unknown) =>
    error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === "23505";

export const publicBookingsRouter = Router();

publicBookingsRouter.get("/availability", async (req, res) => {
    const query = availabilityQuery.parse(req.query);
    const schedule = await getBookingSchedule();
    const from = query.from ?? zonedDate(new Date(), schedule.timezone);
    const to = query.to ?? addDays(from, 30);
    res.set("Cache-Control", "no-store");
    res.json({
        timezone: schedule.timezone,
        slotMinutes: schedule.slotMinutes,
        // Last date (in the schedule's timezone) inside the admin's booking window.
        bookableUntil: zonedDate(new Date(Date.now() + schedule.maxDaysAhead * 86400_000), schedule.timezone),
        days: await getAvailability(schedule, from, to),
    });
});

publicBookingsRouter.post("/", submissionLimiter(), async (req, res) => {
    if (!(await acceptSubmission(req, res, req.body ?? {}))) return;
    const { website: _honeypot, ...input } = createBookingBody.parse(req.body);

    const schedule = await getBookingSchedule();
    // The admin may have changed the schedule since the visitor loaded the calendar.
    if (!isBookableSlot(schedule, input.startsAt)) {
        throw HttpError.conflict("SLOT_UNAVAILABLE", "Selected time is not an available slot");
    }

    try {
        const booking = await AppDataSource.transaction(async (manager) => {
            const saved = await manager.getRepository(CallBooking).save({
                ...input,
                timezone: input.timezone ?? schedule.timezone,
                phone: input.phone ?? null,
                service: input.service ?? null,
                ipHash: hashIp(req.ip),
            });
            await enqueueEmails(
                manager,
                notificationPair("booking", saved.email, {
                    ...input,
                    timezone: saved.timezone,
                    businessTimezone: schedule.timezone,
                    slotMinutes: schedule.slotMinutes,
                    startsAt: saved.startsAt.toISOString(),
                    id: saved.id,
                }),
            );
            await recordAudit(
                { action: "booking.requested", entityType: "booking", entityId: saved.id, summary: `Call requested for ${saved.startsAt.toISOString()}`, data: { startsAt: saved.startsAt, service: saved.service } },
                manager,
            );
            return saved;
        });
        res.status(201).json({ id: booking.id, startsAt: booking.startsAt.toISOString() });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw HttpError.conflict("SLOT_TAKEN", "This time slot has just been booked");
        }
        throw error;
    }
});

// Customers hear back when their request is confirmed or cancelled.
const NOTIFY_ON_STATUS = new Set<string>([CallBookingStatus.CONFIRMED, CallBookingStatus.CANCELLED]);

export const adminBookingsRouter = adminCrudRouter({
    entity: CallBooking,
    auditEntity: "booking",
    statusEnum: CallBookingStatus,
    searchColumns: [],
    filters: { service: z.enum(ContactService) },
    groupBy: ["service"],
    // "?from=&to=" select calls by their time, not by when they were requested.
    dateColumn: "startsAt",
    sorts: {
        newest: ["createdAt", "DESC"],
        soonest: ["startsAt", "ASC"],
        latest: ["startsAt", "DESC"],
    },
    onStatusChange: async (manager, booking, previousStatus) => {
        if (!NOTIFY_ON_STATUS.has(booking.status) || booking.status === previousStatus) return;
        await enqueueEmails(manager, [
            {
                to: [booking.email],
                template: "booking_status",
                payload: {
                    status: booking.status,
                    name: booking.name,
                    startsAt: booking.startsAt.toISOString(),
                    timezone: booking.timezone,
                    locale: booking.locale,
                },
            },
        ]);
    },
});

export const adminBookingSettingsRouter = Router();

adminBookingSettingsRouter.get("/", async (_req, res) => {
    res.json(await getBookingSchedule());
});

adminBookingSettingsRouter.put("/", requireRole(AdminRole.ADMIN), async (req, res) => {
    const before = await getBookingSchedule();
    const saved = await saveBookingSchedule(bookingScheduleBody.parse(req.body));
    await recordAudit({ action: "booking_settings.updated", entityType: "booking_settings", summary: "Booking availability changed", data: { from: before, to: saved } });
    res.json(saved);
});

const previewBody = z
    .object({
        schedule: bookingScheduleBody,
        from: z.iso.date(),
        to: z.iso.date(),
    })
    .refine(({ from, to }) => from <= to && to <= addDays(from, MAX_RANGE_DAYS), {
        message: `Range must be ascending and at most ${MAX_RANGE_DAYS} days`,
        path: ["to"],
    });

// Shows which local times an unsaved schedule offers per date, using the same rules as the public calendar.
adminBookingSettingsRouter.post("/preview", async (req, res) => {
    const { schedule, from, to } = previewBody.parse(req.body);
    const days = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
        days.push({ date, ...scheduleForDate(schedule, date) });
    }
    res.json({ days });
});
