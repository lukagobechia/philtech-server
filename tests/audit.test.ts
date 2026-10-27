import { describe, expect, it } from "vitest";
import { AppDataSource } from "../src/config/database.js";
import { AdminRole, AdminUser } from "../src/entities/admin-user.entity.js";
import { AuditLog } from "../src/entities/audit-log.entity.js";
import { Job } from "../src/entities/job.entity.js";
import { auditedJob } from "../src/modules/audit/audit.service.js";
import { runJobSchedule } from "../src/modules/jobs/jobs.service.js";
import { api, loginAs, PDF, seedJob } from "./helpers.js";

const logs = () => AppDataSource.getRepository(AuditLog);

/** Request rows are written after the response finishes, so wait for them to land. */
async function waitForLog(where: Partial<AuditLog>, timeoutMs = 3000): Promise<AuditLog> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const row = await logs().findOne({ where, order: { createdAt: "DESC" } });
        if (row) return row;
        if (Date.now() > deadline) throw new Error(`No audit log matching ${JSON.stringify(where)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const adminId = async (role = AdminRole.ADMIN) => (await AppDataSource.getRepository(AdminUser).findOneByOrFail({ email: `${role}@example.com` })).id;

describe("request audit", () => {
    it("records every request with endpoint, actor, status and duration", async () => {
        await api().get("/api/v1/jobs?lang=en").expect(200);
        const anonymous = await waitForLog({ path: "/api/v1/jobs", actorType: "public" as never });
        expect(anonymous).toMatchObject({ category: "request", action: "http.request", method: "GET", route: "/api/v1/jobs", statusCode: 200, actorId: null, outcome: "success" });
        expect(anonymous.durationMs).toBeGreaterThanOrEqual(0);
        expect(anonymous.data).toEqual({ query: { lang: "en" } });

        const agent = await loginAs();
        const job = await seedJob();
        await agent.get(`/api/v1/admin/jobs/${job.id}`).expect(200);
        const admin = await waitForLog({ path: `/api/v1/admin/jobs/${job.id}` });
        expect(admin).toMatchObject({ route: "/api/v1/admin/jobs/:id", actorType: "admin", actorId: await adminId(), actorEmail: "admin@example.com", actorRole: "admin", entityId: job.id });

        // Failures are recorded too, with the route pattern when one matched.
        await agent.get("/api/v1/admin/jobs/00000000-0000-4000-8000-000000000000").expect(404);
        expect(await waitForLog({ statusCode: 404 })).toMatchObject({ outcome: "failure", route: "/api/v1/admin/jobs/:id" });
        await api().get("/api/v1/nope").expect(404);
        expect(await waitForLog({ path: "/api/v1/nope" })).toMatchObject({ route: null, statusCode: 404 });
    });

    it("keeps admin input with secrets redacted, but only field names of visitors' input", async () => {
        const agent = await loginAs();
        await agent.post("/api/v1/admin/users").send({ email: "new@example.com", displayName: "New", password: "very-secret-password", role: "recruiter" }).expect(201);
        const created = await waitForLog({ path: "/api/v1/admin/users", method: "POST" });
        expect(created.data.body).toEqual({ email: "new@example.com", displayName: "New", password: "[redacted]", role: "recruiter" });

        await api().post("/api/v1/contact-messages").send({ name: "Nino", email: "nino@example.com", message: "Hello", locale: "en" }).expect(201);
        const submitted = await waitForLog({ path: "/api/v1/contact-messages", method: "POST" });
        expect(submitted.data.body).toEqual({ fields: ["name", "email", "message", "locale"] });
    });
});

describe("domain audit", () => {
    it("records status changes with who made them, linked to the request", async () => {
        await seedJob();
        const applied = await api()
            .post("/api/v1/jobs/java-developer/applications")
            .field({ firstName: "Nino", lastName: "B", city: "T", country: "GE", email: "n@example.com", phone: "+995593512663", consent: "true", locale: "en" })
            .attach("resume", PDF, "cv.pdf")
            .expect(201);
        expect(await waitForLog({ action: "application.submitted" })).toMatchObject({ actorType: "public", entityId: applied.body.id });

        const agent = await loginAs(AdminRole.RECRUITER);
        const patched = await agent.patch(`/api/v1/admin/applications/${applied.body.id}`).send({ status: "reviewing" }).expect(200);
        const event = await waitForLog({ action: "application.status_changed" });
        expect(event).toMatchObject({
            category: "event",
            actorId: await adminId(AdminRole.RECRUITER),
            entityType: "application",
            entityId: applied.body.id,
            summary: "Status received → reviewing",
            data: { from: "received", to: "reviewing" },
            requestId: patched.headers["x-request-id"],
        });

        // Opening the CV is recorded as access to personal data.
        await agent.get(`/api/v1/admin/applications/${applied.body.id}/resume?disposition=inline`).expect(200);
        expect(await waitForLog({ action: "application.resume_viewed" })).toMatchObject({ entityId: applied.body.id });

        const admin = await loginAs();
        await waitForLog({ requestId: patched.headers["x-request-id"], action: "http.request" });
        const detail = await admin.get(`/api/v1/admin/audit-logs/${event.id}`).expect(200);
        expect(detail.body.related.map((row: { action: string }) => row.action)).toContain("http.request");
    });

    it("records sign-ins, failed sign-ins and sign-outs", async () => {
        const agent = await loginAs();
        expect(await waitForLog({ action: "auth.login" })).toMatchObject({ actorEmail: "admin@example.com", actorType: "admin" });
        await api().post("/api/v1/auth/login").send({ email: "admin@example.com", password: "wrong-password" }).expect(401);
        expect(await waitForLog({ action: "auth.login_failed" })).toMatchObject({ outcome: "failure", actorType: "public", data: { email: "admin@example.com", reason: "wrong_password" } });
        await agent.post("/api/v1/auth/logout").expect(204);
        expect(await waitForLog({ action: "auth.logout" })).toMatchObject({ actorId: await adminId() });
    });

    it("records report exports and refused exports", async () => {
        const admin = await loginAs();
        await admin.get("/api/v1/admin/reports/jobs?format=csv").expect(200);
        expect(await waitForLog({ action: "report.exported" })).toMatchObject({ entityType: "report", entityId: "jobs", data: { format: "csv", rows: 0 } });

        const recruiter = await loginAs(AdminRole.RECRUITER);
        await recruiter.get("/api/v1/admin/reports/messages").expect(403);
        expect(await waitForLog({ action: "report.export_denied" })).toMatchObject({ outcome: "failure", actorId: await adminId(AdminRole.RECRUITER) });
    });

    it("records background jobs as the system, including failures", async () => {
        const job = await seedJob({ isPublished: false });
        await AppDataSource.getRepository(Job).update(job.id, { publishAt: new Date(Date.now() - 1000) });
        await auditedJob("vacancy_schedule", async () => {
            const result = await runJobSchedule();
            return { didWork: result.published > 0, data: result };
        });
        expect(await waitForLog({ action: "job.auto_published" })).toMatchObject({ category: "job", actorType: "system", actorId: null, entityId: job.id, data: { job: "vacancy_schedule" } });
        expect(await waitForLog({ action: "job.vacancy_schedule" })).toMatchObject({ outcome: "success", data: { published: 1 } });

        await auditedJob("broken", async () => {
            throw new Error("Mail server down");
        });
        expect(await waitForLog({ action: "job.broken" })).toMatchObject({ outcome: "failure", summary: "Mail server down" });

        // Idle runs are skipped so frequent schedulers don't flood the log.
        await auditedJob("idle", async () => ({ didWork: false }));
        expect(await logs().countBy({ action: "job.idle" })).toBe(0);
    });

    it("is append-only", async () => {
        await loginAs();
        const row = await waitForLog({ action: "auth.login" });
        await expect(logs().update(row.id, { summary: "tampered" })).rejects.toThrow(/append-only/);
    });
});

describe("audit log API", () => {
    it("filters by user id, searches, groups and exports; admins only", async () => {
        const admin = await loginAs();
        const recruiter = await loginAs(AdminRole.RECRUITER);
        const recruiterId = await adminId(AdminRole.RECRUITER);
        await recruiter.get("/api/v1/admin/jobs").expect(200);
        await recruiter.get("/api/v1/admin/audit-logs").expect(403);
        await waitForLog({ path: "/api/v1/admin/audit-logs", statusCode: 403 });

        const mine = await admin.get(`/api/v1/admin/audit-logs?actorId=${recruiterId}&category=request`).expect(200);
        expect(mine.body.items.every((row: AuditLog) => row.actorId === recruiterId)).toBe(true);
        expect(mine.body.items.map((row: AuditLog) => row.path)).toEqual(expect.arrayContaining(["/api/v1/admin/jobs", "/api/v1/admin/audit-logs"]));

        // A partial user id in the search box finds the same rows.
        const search = await admin.get(`/api/v1/admin/audit-logs?q=${recruiterId.slice(0, 8)}`).expect(200);
        expect(search.body.total).toBeGreaterThan(0);
        expect(search.body.items.every((row: AuditLog) => row.actorId === recruiterId)).toBe(true);

        const denied = await admin.get("/api/v1/admin/audit-logs?status=4xx").expect(200);
        expect(denied.body.items.every((row: AuditLog) => row.statusCode! >= 400 && row.statusCode! < 500)).toBe(true);
        const logins = await admin.get("/api/v1/admin/audit-logs?actionPrefix=auth.").expect(200);
        expect(logins.body.items.every((row: AuditLog) => row.action.startsWith("auth."))).toBe(true);

        const byUser = await admin.get("/api/v1/admin/audit-logs/summary?groupBy=actorId&category=event").expect(200);
        expect(byUser.body.groups).toEqual(
            expect.arrayContaining([expect.objectContaining({ key: recruiterId, label: "recruiter@example.com", count: 1 })]),
        );
        const byDay = await admin.get("/api/v1/admin/audit-logs/summary?groupBy=day").expect(200);
        expect(byDay.body.groups).toHaveLength(1);
        await admin.get("/api/v1/admin/audit-logs/summary?groupBy=password").expect(400);

        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tbilisi" });
        const csv = await admin.get(`/api/v1/admin/reports/audit?format=csv&from=${today}&to=${today}&actorId=${recruiterId}&status=4xx`).expect(200);
        const lines = csv.text.trim().split("\r\n");
        expect(lines[0]).toContain("Time,Category,Action,Outcome,Actor type,User id,User email");
        expect(lines.slice(1).every((line) => line.includes(recruiterId) && line.includes(",403,"))).toBe(true);
        expect(await waitForLog({ action: "report.exported", entityId: "audit" })).toMatchObject({ data: { filters: { actorId: recruiterId, status: "4xx" } } });
    });
});
