import { describe, expect, it } from "vitest";
import { AppDataSource } from "../src/config/database.js";
import { CallBooking } from "../src/entities/call-booking.entity.js";
import { ContactMessage } from "../src/entities/contact-message.entity.js";
import { EmailOutbox } from "../src/entities/email-outbox.entity.js";
import { JobApplication } from "../src/entities/job-application.entity.js";
import { setMailer } from "../src/lib/mailer.js";
import { processOutboxBatch } from "../src/modules/email/outbox.worker.js";
import { sentMails, storedObjects } from "./fakes.js";
import { api, loginAs, PDF, seedExpiredJob, seedJob } from "./helpers.js";

const contact = { name: "Nino", email: "Nino@Example.com", phone: "+995 593 51 26 63", service: "web", message: "Hi", locale: "ka" };

describe("contact messages", () => {
    it("stores the message normalized and queues two emails", async () => {
        await api().post("/api/v1/contact-messages").send(contact).expect(201);

        const [saved] = await AppDataSource.getRepository(ContactMessage).find();
        expect(saved).toMatchObject({ email: "nino@example.com", phone: "+995593512663", service: "web" });
        expect(saved!.ipHash).toMatch(/^[a-f0-9]{64}$/);

        expect(await processOutboxBatch(AppDataSource)).toBe(2);
        expect(sentMails.map((mail) => mail.to[0]).sort()).toEqual(["nino@example.com", "team@example.com"]);
        expect(sentMails.find((mail) => mail.to[0] === "nino@example.com")!.subject).toContain("მიღებულია");
    });

    it("returns field errors for invalid input", async () => {
        const res = await api().post("/api/v1/contact-messages").send({ ...contact, email: "nope", service: "ui-ux" }).expect(400);
        expect(Object.keys(res.body.error.details).sort()).toEqual(["email", "service"]);
    });

    it("silently drops honeypot submissions", async () => {
        await api().post("/api/v1/contact-messages").send({ ...contact, website: "http://spam" }).expect(201);
        expect(await AppDataSource.getRepository(ContactMessage).count()).toBe(0);
    });

    it("escapes user input in email HTML", async () => {
        await api().post("/api/v1/contact-messages").send({ ...contact, message: "<script>x</script>" }).expect(201);
        await processOutboxBatch(AppDataSource);
        const internal = sentMails.find((mail) => mail.to[0] === "team@example.com")!;
        expect(internal.html).toContain("&lt;script&gt;");
        expect(internal.html).not.toContain("<script>");
    });
});

describe("email outbox", () => {
    it("backs off and retries failed sends", async () => {
        await api().post("/api/v1/contact-messages").send(contact).expect(201);

        setMailer({ send: async () => Promise.reject(new Error("SMTP down")) });
        await processOutboxBatch(AppDataSource);
        const failed = await AppDataSource.getRepository(EmailOutbox).find();
        expect(failed.every((email) => email.status === "pending" && email.attempts === 1 && email.lastError)).toBe(true);
        // Not due yet, so nothing is picked up again immediately.
        expect(await processOutboxBatch(AppDataSource)).toBe(0);
    });
});

describe("bookings", () => {
    it("lists availability, books a slot, and rejects double booking", async () => {
        const availability = await api().get("/api/v1/bookings/availability").expect(200);
        const slot: string = availability.body.days[1].slots[0];

        const booking = { name: "Ann", email: "ann@example.com", startsAt: slot, timezone: "Europe/Berlin" };
        const results = await Promise.all([
            api().post("/api/v1/bookings").send(booking),
            api().post("/api/v1/bookings").send({ ...booking, email: "bob@example.com" }),
        ]);
        expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
        expect(results.find((res) => res.status === 409)!.body.error.code).toBe("SLOT_TAKEN");
        expect(await AppDataSource.getRepository(CallBooking).count()).toBe(1);

        const after = await api().get("/api/v1/bookings/availability").expect(200);
        expect(after.body.days.flatMap((day: { slots: string[] }) => day.slots)).not.toContain(slot);
    });

    it("rejects times that are not configured slots", async () => {
        const res = await api()
            .post("/api/v1/bookings")
            .send({ name: "Ann", email: "ann@example.com", startsAt: "2030-01-01T10:07:00Z" })
            .expect(409);
        expect(res.body.error.code).toBe("SLOT_UNAVAILABLE");
    });

    it("lets admins confirm or cancel bookings", async () => {
        const availability = await api().get("/api/v1/bookings/availability").expect(200);
        const created = await api()
            .post("/api/v1/bookings")
            .send({ name: "Ann", email: "ann@example.com", startsAt: availability.body.days[1].slots[0] })
            .expect(201);

        const agent = await loginAs();
        const res = await agent.patch(`/api/v1/admin/bookings/${created.body.id}`).send({ status: "confirmed" }).expect(200);
        expect(res.body.status).toBe("confirmed");
        expect(res.body.ipHash).toBeUndefined();
    });
});

describe("job applications", () => {
    const fields = {
        firstName: "Nino",
        lastName: "Beridze",
        city: "Tbilisi",
        country: "ge",
        email: "nino@example.com",
        phone: "+995593512663",
        consent: "true",
        locale: "en",
    };

    const apply = (slug: string, file: Buffer | null, overrides: Record<string, string> = {}) => {
        const req = api().post(`/api/v1/jobs/${slug}/applications`);
        for (const [key, value] of Object.entries({ ...fields, ...overrides })) req.field(key, value);
        if (file) req.attach("resume", file, "cv.pdf");
        return req;
    };

    it("stores the resume privately and records consent", async () => {
        await seedJob();
        const res = await apply("java-developer", PDF).expect(201);

        const saved = await AppDataSource.getRepository(JobApplication).findOneByOrFail({ id: res.body.id });
        expect(saved).toMatchObject({ country: "GE", resumeMimeType: "application/pdf", privacyPolicyVersion: "2026-01" });
        expect(storedObjects.has(saved.resumeKey)).toBe(true);

        const agent = await loginAs();
        const detail = await agent.get(`/api/v1/admin/applications/${saved.id}`).expect(200);
        expect(detail.body.resumeKey).toBeUndefined();
        const download = await agent.get(`/api/v1/admin/applications/${saved.id}/resume`).expect(200);
        expect(download.body.url).toContain(saved.resumeKey);
        expect(download.body.disposition).toBe("attachment");

        const preview = await agent.get(`/api/v1/admin/applications/${saved.id}/resume?disposition=inline`).expect(200);
        expect(preview.body).toMatchObject({ disposition: "inline", mimeType: "application/pdf" });
        expect(preview.body.url).toContain("disposition=inline");
    });

    it("never serves Word documents inline", async () => {
        await seedJob();
        // Minimal OLE compound-file header, detected as a legacy .doc.
        const doc = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(2048)]);
        const res = await apply("java-developer", doc).expect(201);

        const agent = await loginAs();
        const preview = await agent.get(`/api/v1/admin/applications/${res.body.id}/resume?disposition=inline`).expect(200);
        expect(preview.body).toMatchObject({ disposition: "attachment", mimeType: "application/msword" });
    });

    it("rejects files whose content is not a document, regardless of name", async () => {
        await seedJob();
        const res = await apply("java-developer", Buffer.from("MZ fake exe")).expect(400);
        expect(res.body.error.details.resume).toBeDefined();
        expect(storedObjects.size).toBe(0);
    });

    it("rejects oversized files, missing consent, closed and unknown jobs", async () => {
        await seedJob();
        await seedExpiredJob("closed");

        await apply("java-developer", Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)])).expect(413);
        await apply("java-developer", PDF, { consent: "false" }).expect(400);
        await apply("java-developer", null).expect(400);
        expect((await apply("closed", PDF).expect(409)).body.error.code).toBe("JOB_CLOSED");
        await apply("unknown", PDF).expect(404);
    });

    it("limits recruiters to jobs and applications", async () => {
        const recruiter = await loginAs("recruiter" as never);
        await recruiter.get("/api/v1/admin/applications").expect(200);
        await recruiter.get("/api/v1/admin/contact-messages").expect(403);
        await recruiter.get("/api/v1/admin/users").expect(403);
    });
});
