import { describe, expect, it } from "vitest";
import { AdminRole } from "../src/entities/admin-user.entity.js";
import { presenceOf, runOvertimeSchedule } from "../src/modules/employees/employees.service.js";
import { api, loginAs, PDF, seedJob } from "./helpers.js";

const weekdays = (start: string, end: string) => [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start, end }));

const newEmployee = (overrides: Record<string, unknown> = {}) => ({
    firstName: "Giorgi",
    lastName: "Beridze",
    email: "giorgi@example.com",
    position: "Support engineer",
    department: "Support",
    startDate: "2026-01-05",
    schedule: weekdays("09:00", "18:00"),
    ...overrides,
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("hiring", () => {
    it("adds a hired applicant to the employees list once, with a log entry", async () => {
        const job = await seedJob();
        const applied = await api()
            .post("/api/v1/jobs/java-developer/applications")
            .field({ firstName: "Nino", lastName: "Kapanadze", city: "Tbilisi", country: "GE", email: "nino@example.com", phone: "+995593512663", consent: "true", locale: "en" })
            .attach("resume", PDF, "cv.pdf")
            .expect(201);
        const agent = await loginAs(AdminRole.RECRUITER);

        await agent.patch(`/api/v1/admin/applications/${applied.body.id}`).send({ status: "hired" }).expect(200);
        const list = await agent.get(`/api/v1/admin/employees?applicationId=${applied.body.id}`).expect(200);
        expect(list.body.total).toBe(1);
        const employee = list.body.items[0];
        expect(employee).toMatchObject({
            firstName: "Nino",
            lastName: "Kapanadze",
            email: "nino@example.com",
            position: "Java Developer",
            jobCode: job.code,
            status: "active",
            schedule: [],
            presence: { state: "off", nextShiftAt: null },
        });

        // Setting it again (or back and forth) doesn't duplicate the employee.
        await agent.patch(`/api/v1/admin/applications/${applied.body.id}`).send({ status: "interview" }).expect(200);
        await agent.patch(`/api/v1/admin/applications/${applied.body.id}`).send({ status: "hired" }).expect(200);
        expect((await agent.get("/api/v1/admin/employees").expect(200)).body.total).toBe(1);

        const events = await agent.get(`/api/v1/admin/employees/${employee.id}/events`).expect(200);
        expect(events.body.items.map((event: { type: string }) => event.type)).toEqual(["hired"]);
        expect(events.body.items[0]).toMatchObject({ data: { applicationId: applied.body.id, jobCode: job.code }, actor: { displayName: "recruiter" } });
    });
});

describe("employees", () => {
    it("adds employees by hand, validates schedules and logs changes", async () => {
        const agent = await loginAs();
        const created = await agent.post("/api/v1/admin/employees").send(newEmployee()).expect(201);
        expect(created.body.schedule).toHaveLength(5);

        const duplicate = await agent.post("/api/v1/admin/employees").send(newEmployee()).expect(409);
        expect(duplicate.body.error.code).toBe("EMAIL_TAKEN");
        await agent.post("/api/v1/admin/employees").send(newEmployee({ email: "x@example.com", schedule: [{ weekday: 1, start: "18:00", end: "09:00" }] })).expect(400);
        await agent
            .post("/api/v1/admin/employees")
            .send(newEmployee({ email: "y@example.com", schedule: [{ weekday: 1, start: "09:00", end: "13:00" }, { weekday: 1, start: "12:00", end: "17:00" }] }))
            .expect(400);

        // A split shift is fine.
        const split = [{ weekday: 6, start: "14:00", end: "18:00" }, { weekday: 6, start: "09:00", end: "12:00" }];
        const updated = await agent.patch(`/api/v1/admin/employees/${created.body.id}`).send({ schedule: split, position: "Team lead" }).expect(200);
        expect(updated.body.schedule).toEqual([{ weekday: 6, start: "09:00", end: "12:00" }, { weekday: 6, start: "14:00", end: "18:00" }]);

        const events = await agent.get(`/api/v1/admin/employees/${created.body.id}/events`).expect(200);
        expect(events.body.items.map((event: { type: string }) => event.type)).toEqual(
            expect.arrayContaining(["created", "schedule_updated", "updated"]),
        );
        const update = events.body.items.find((event: { type: string }) => event.type === "updated");
        expect(update.data.changes.position).toEqual({ from: "Support engineer", to: "Team lead" });

        const search = await agent.get("/api/v1/admin/employees?q=lead").expect(200);
        expect(search.body.total).toBe(1);
    });

    it("works out who is on shift in the company timezone", () => {
        const employee = { schedule: [{ weekday: 2, start: "09:00", end: "18:00" }] };
        // Tuesday 2026-10-27 10:30 in Tbilisi (UTC+4) is 06:30 UTC.
        expect(presenceOf(employee, undefined, new Date("2026-10-27T06:30:00Z"))).toEqual({ state: "working", until: "2026-10-27T14:00:00.000Z" });
        // After hours on Tuesday: next shift is the following Tuesday.
        expect(presenceOf(employee, undefined, new Date("2026-10-27T15:00:00Z"))).toEqual({ state: "off", nextShiftAt: "2026-11-03T05:00:00.000Z" });
        // Early Tuesday morning: later today.
        expect(presenceOf(employee, undefined, new Date("2026-10-27T03:00:00Z"))).toEqual({ state: "off", nextShiftAt: "2026-10-27T05:00:00.000Z" });
    });
});

describe("overtime", () => {
    it("starts and ends overtime, shows it on the board and keeps a log", async () => {
        const agent = await loginAs();
        const { body: employee } = await agent.post("/api/v1/admin/employees").send(newEmployee({ schedule: [] })).expect(201);

        const started = await agent.post(`/api/v1/admin/employees/${employee.id}/overtime`).send({ reason: "Release night", startedAt: minutesAgo(90) }).expect(201);
        expect(started.body.status).toBe("active");
        const again = await agent.post(`/api/v1/admin/employees/${employee.id}/overtime`).send({ reason: "Again" }).expect(409);
        expect(again.body.error.code).toBe("OVERTIME_ACTIVE");
        await agent.post(`/api/v1/admin/employees/${employee.id}/overtime`).send({ reason: "Future", startedAt: new Date(Date.now() + 3600_000).toISOString() }).expect(400);

        const board = await agent.get("/api/v1/admin/employees/board").expect(200);
        expect(board.body.counts).toEqual({ overtime: 1, working: 0, off: 0, total: 1 });
        expect(board.body.items[0].presence).toMatchObject({ state: "overtime", overtimeId: started.body.id });

        const ended = await agent.post(`/api/v1/admin/overtime/${started.body.id}/end`).send({}).expect(200);
        expect(ended.body.status).toBe("completed");
        await agent.post(`/api/v1/admin/overtime/${started.body.id}/end`).send({}).expect(409);

        // Overtime that already happened can be registered afterwards.
        await agent
            .post(`/api/v1/admin/employees/${employee.id}/overtime`)
            .send({ reason: "Weekend migration", startedAt: minutesAgo(3 * 24 * 60), endedAt: minutesAgo(3 * 24 * 60 - 120) })
            .expect(201);

        const log = await agent.get(`/api/v1/admin/overtime?employeeId=${employee.id}`).expect(200);
        expect(log.body.totals.entries).toBe(2);
        expect(log.body.totals.minutes).toBeGreaterThanOrEqual(209);
        expect(log.body.items[0]).toMatchObject({ reason: "Release night", durationMinutes: 90, employee: { name: "Giorgi Beridze" }, startedBy: { displayName: "admin" } });

        const events = await agent.get(`/api/v1/admin/employees/${employee.id}/events`).expect(200);
        expect(events.body.items.map((event: { type: string }) => event.type).slice(0, 3)).toEqual(["overtime_started", "overtime_ended", "overtime_started"]);
        expect(events.body.items[0].data).toMatchObject({ registeredAfterwards: true, minutes: 120 });
    });

    it("ends planned overtime automatically and logs corrections and cancellations", async () => {
        const agent = await loginAs();
        const { body: employee } = await agent.post("/api/v1/admin/employees").send(newEmployee()).expect(201);
        const plannedEndAt = new Date(Date.now() + 30 * 60_000);
        const { body: entry } = await agent
            .post(`/api/v1/admin/employees/${employee.id}/overtime`)
            .send({ reason: "Client deadline", plannedEndAt: plannedEndAt.toISOString() })
            .expect(201);

        const corrected = await agent.patch(`/api/v1/admin/overtime/${entry.id}`).send({ reason: "Client deadline (Acme)" }).expect(200);
        expect(corrected.body.reason).toBe("Client deadline (Acme)");

        expect(await runOvertimeSchedule(new Date(plannedEndAt.getTime() - 1000))).toBe(0);
        expect(await runOvertimeSchedule(new Date(plannedEndAt.getTime() + 1000))).toBe(1);
        const log = await agent.get("/api/v1/admin/overtime").expect(200);
        expect(log.body.items[0]).toMatchObject({ status: "completed", endedAt: plannedEndAt.toISOString(), endedBy: null, durationMinutes: 30 });

        const { body: second } = await agent.post(`/api/v1/admin/employees/${employee.id}/overtime`).send({ reason: "Mistake" }).expect(201);
        await agent.post(`/api/v1/admin/overtime/${second.id}/cancel`).expect(200);

        const events = (await agent.get(`/api/v1/admin/employees/${employee.id}/events`).expect(200)).body.items;
        expect(events.map((event: { type: string }) => event.type).slice(0, 5)).toEqual([
            "overtime_cancelled", "overtime_started", "overtime_ended", "overtime_updated", "overtime_started",
        ]);
        expect(events.find((event: { type: string }) => event.type === "overtime_ended")).toMatchObject({ actor: null, data: { automatic: true } });
        expect(events.find((event: { type: string }) => event.type === "overtime_updated").data.changes.reason).toEqual({
            from: "Client deadline",
            to: "Client deadline (Acme)",
        });
    });

    it("ends running overtime when the employee is deactivated, and exports reports", async () => {
        const agent = await loginAs();
        const { body: employee } = await agent.post("/api/v1/admin/employees").send(newEmployee()).expect(201);
        await agent.post(`/api/v1/admin/employees/${employee.id}/overtime`).send({ reason: "Late support", startedAt: minutesAgo(60) }).expect(201);

        const deactivated = await agent.patch(`/api/v1/admin/employees/${employee.id}`).send({ status: "inactive" }).expect(200);
        expect(deactivated.body.presence).toBeNull();
        const log = await agent.get("/api/v1/admin/overtime?status=active").expect(200);
        expect(log.body.total).toBe(0);
        await agent.post(`/api/v1/admin/employees/${employee.id}/overtime`).send({ reason: "x" }).expect(409);
        expect((await agent.get("/api/v1/admin/employees/board").expect(200)).body.counts.total).toBe(0);

        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tbilisi" });
        const employees = await agent.get(`/api/v1/admin/reports/employees?format=csv&from=${today}&to=${today}`).expect(200);
        expect(employees.text).toContain("Giorgi,Beridze,giorgi@example.com,,Support engineer,Support,2026-01-05,Inactive,Added manually,45,");
        expect(employees.text).toContain("Mon 09:00–18:00; Tue 09:00–18:00");
        const overtime = await agent.get(`/api/v1/admin/reports/overtime?format=csv&from=${today}&to=${today}`).expect(200);
        expect(overtime.text).toMatch(/,1,Giorgi Beridze,Support engineer,Late support,Completed,admin,admin/);
    });
});
