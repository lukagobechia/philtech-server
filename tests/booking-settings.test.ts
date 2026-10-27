import { describe, expect, it } from "vitest";
import { AppDataSource } from "../src/config/database.js";
import { processOutboxBatch } from "../src/modules/email/outbox.worker.js";
import { addDays, isoWeekday, zonedDate } from "../src/lib/timezone.js";
import { sentMails } from "./fakes.js";
import { api, loginAs } from "./helpers.js";

const everyDay = [1, 2, 3, 4, 5, 6, 7];

const rule = (overrides: Record<string, unknown> = {}) => ({
    weekdays: everyDay,
    times: ["10:00"],
    startDate: null,
    endDate: null,
    intervalWeeks: 1,
    ...overrides,
});

const schedule = (overrides: Record<string, unknown> = {}) => ({
    timezone: "Asia/Tbilisi",
    slotMinutes: 30,
    minLeadHours: 0,
    maxDaysAhead: 60,
    rules: [rule()],
    dateOverrides: [],
    ...overrides,
});

const tbilisiToday = () => zonedDate(new Date(), "Asia/Tbilisi");

const allSlots = async () => {
    const res = await api().get("/api/v1/bookings/availability").expect(200);
    return res.body.days.flatMap((day: { slots: string[] }) => day.slots) as string[];
};

describe("booking schedule", () => {
    it("falls back to the env schedule until an admin saves one", async () => {
        const agent = await loginAs();
        const res = await agent.get("/api/v1/admin/booking-settings").expect(200);
        expect(res.body.timezone).toBe("Asia/Tbilisi");
        expect(res.body.rules).toEqual([
            expect.objectContaining({ weekdays: everyDay, times: ["17:30", "18:30", "19:30", "20:30", "21:30"], intervalWeeks: 1 }),
        ]);
        expect(res.body.dateOverrides).toEqual([]);
    });

    it("drives public availability from the saved rules", async () => {
        const agent = await loginAs();
        const tomorrow = addDays(tbilisiToday(), 1);
        const dayAfter = addDays(tomorrow, 1);

        const saved = await agent
            .put("/api/v1/admin/booking-settings")
            .send(schedule({ rules: [rule({ weekdays: [isoWeekday(dayAfter)], times: ["11:00", "09:00"] })], maxDaysAhead: 30 }))
            .expect(200);
        expect(saved.body.rules[0].id).toMatch(/^[0-9a-f-]{36}$/);

        const res = await api().get(`/api/v1/bookings/availability?from=${tomorrow}&to=${dayAfter}`).expect(200);
        expect(res.body.slotMinutes).toBe(30);
        expect(res.body.bookableUntil).toBe(addDays(tbilisiToday(), 30));
        // Only the configured weekday, sorted, Tbilisi time (UTC+4).
        expect(res.body.days).toEqual([
            { date: dayAfter, slots: [`${dayAfter}T05:00:00.000Z`, `${dayAfter}T07:00:00.000Z`] },
        ]);
    });

    it("repeats every N weeks and respects start and end dates", async () => {
        const agent = await loginAs();
        const start = addDays(tbilisiToday(), 1);
        const weekday = isoWeekday(start);

        await agent
            .put("/api/v1/admin/booking-settings")
            .send(schedule({ rules: [rule({ weekdays: [weekday], startDate: start, endDate: addDays(start, 35), intervalWeeks: 2 })] }))
            .expect(200);

        const res = await api().get(`/api/v1/bookings/availability?from=${tbilisiToday()}&to=${addDays(start, 50)}`).expect(200);
        // Weeks 0, 2 and 4 from the start date; week 6 is past the end date.
        expect(res.body.days.map((day: { date: string }) => day.date)).toEqual([start, addDays(start, 14), addDays(start, 28)]);
    });

    it("combines several rules and drops slots that would overlap", async () => {
        const agent = await loginAs();
        const day = addDays(tbilisiToday(), 2);
        await agent
            .put("/api/v1/admin/booking-settings")
            .send(schedule({ slotMinutes: 60, rules: [rule({ times: ["10:00", "12:00"] }), rule({ times: ["10:30", "14:00"] })] }))
            .expect(200);

        const res = await api().get(`/api/v1/bookings/availability?from=${day}&to=${day}`).expect(200);
        // 10:30 would overlap the 60-minute 10:00 call from the first rule.
        expect(res.body.days[0].slots.map((slot: string) => slot.slice(11, 16))).toEqual(["06:00", "08:00", "10:00"]);
    });

    it("lets specific dates replace the recurring times or block the day", async () => {
        const agent = await loginAs();
        const custom = addDays(tbilisiToday(), 2);
        const blocked = addDays(tbilisiToday(), 3);
        // A date outside every rule can still be opened with its own times.
        const extra = addDays(tbilisiToday(), 4);

        await agent
            .put("/api/v1/admin/booking-settings")
            .send(
                schedule({
                    rules: [rule({ weekdays: everyDay.filter((d) => d !== isoWeekday(extra)) })],
                    dateOverrides: [
                        { date: extra, times: ["15:00"] },
                        { date: custom, times: ["13:00", "09:00"] },
                        { date: blocked, times: [] },
                    ],
                }),
            )
            .expect(200);

        const res = await api().get(`/api/v1/bookings/availability?from=${custom}&to=${extra}`).expect(200);
        expect(res.body.days.map((d: { date: string; slots: string[] }) => [d.date, d.slots.map((s) => s.slice(11, 16))])).toEqual([
            [custom, ["05:00", "09:00"]],
            [extra, ["11:00"]],
        ]);

        const slot = `${blocked}T06:00:00.000Z`;
        const booking = await api().post("/api/v1/bookings").send({ name: "Ann", email: "ann@example.com", startsAt: slot }).expect(409);
        expect(booking.body.error.code).toBe("SLOT_UNAVAILABLE");
    });

    it("previews an unsaved schedule without changing the live one", async () => {
        const agent = await loginAs();
        const day = addDays(tbilisiToday(), 1);
        const res = await agent
            .post("/api/v1/admin/booking-settings/preview")
            .send({
                schedule: schedule({ rules: [rule({ times: ["08:00"] })], dateOverrides: [{ date: day, times: [] }] }),
                from: day,
                to: addDays(day, 1),
            })
            .expect(200);
        expect(res.body.days).toEqual([
            { date: day, times: [], source: "override" },
            { date: addDays(day, 1), times: ["08:00"], source: "rules" },
        ]);

        const live = await agent.get("/api/v1/admin/booking-settings").expect(200);
        expect(live.body.rules[0].times).toEqual(["17:30", "18:30", "19:30", "20:30", "21:30"]);
    });

    it("validates overlaps, date ranges, intervals and timezones", async () => {
        const agent = await loginAs();
        const put = (body: Record<string, unknown>) => agent.put("/api/v1/admin/booking-settings").send(schedule(body));

        const overlap = await put({ slotMinutes: 60, rules: [rule({ times: ["10:00", "10:30"] })] }).expect(400);
        expect(overlap.body.error.details.rules).toBeDefined();

        await put({ dateOverrides: [{ date: "2030-01-01", times: ["10:00", "10:15"] }] }).expect(400);
        await put({ dateOverrides: [{ date: "2030-01-01", times: [] }, { date: "2030-01-01", times: ["10:00"] }] }).expect(400);
        await put({ rules: [rule({ startDate: "2030-02-01", endDate: "2030-01-01" })] }).expect(400);
        await put({ rules: [rule({ intervalWeeks: 2 })] }).expect(400);
        await put({ rules: [rule({ weekdays: [] })] }).expect(400);
        await put({ timezone: "Mars/Olympus" }).expect(400);
    });

    it("is editable only by admins", async () => {
        const recruiter = await loginAs("recruiter" as never);
        await recruiter.put("/api/v1/admin/booking-settings").send(schedule()).expect(403);
    });
});

describe("booking status emails", () => {
    it("emails the customer when a booking is confirmed or cancelled, once per change", async () => {
        const slot = (await allSlots())[0]!;
        const created = await api()
            .post("/api/v1/bookings")
            .send({ name: "Ann", email: "ann@example.com", startsAt: slot, locale: "ka", timezone: "Europe/Berlin" })
            .expect(201);
        await processOutboxBatch(AppDataSource);
        sentMails.length = 0;

        const agent = await loginAs();
        await agent.patch(`/api/v1/admin/bookings/${created.body.id}`).send({ status: "confirmed" }).expect(200);
        await agent.patch(`/api/v1/admin/bookings/${created.body.id}`).send({ status: "confirmed" }).expect(200);
        await processOutboxBatch(AppDataSource);
        expect(sentMails).toHaveLength(1);
        expect(sentMails[0]).toMatchObject({ to: ["ann@example.com"], subject: "თქვენი ზარი დადასტურებულია" });

        await agent.patch(`/api/v1/admin/bookings/${created.body.id}`).send({ status: "cancelled" }).expect(200);
        await processOutboxBatch(AppDataSource);
        expect(sentMails.map((mail) => mail.subject)).toContain("თქვენი ზარი გაუქმდა");

        // Cancelling frees the slot again.
        expect(await allSlots()).toContain(slot);
    });

    it("sends confirmation and team emails right after a booking", async () => {
        const slot = (await allSlots())[0]!;
        await api().post("/api/v1/bookings").send({ name: "Bob", email: "bob@example.com", startsAt: slot }).expect(201);
        await processOutboxBatch(AppDataSource);
        expect(sentMails.map((mail) => mail.to[0]).sort()).toEqual(["bob@example.com", "team@example.com"]);
        expect(sentMails.find((mail) => mail.to[0] === "team@example.com")!.text).toContain("Duration: 60 min");
    });
});
