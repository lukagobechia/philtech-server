import { describe, expect, it } from "vitest";
import { AppDataSource } from "../src/config/database.js";
import { JobApplication } from "../src/entities/job-application.entity.js";
import { processOutboxBatch } from "../src/modules/email/outbox.worker.js";
import { sentMails, storedObjects } from "./fakes.js";
import { api, loginAs, PDF, seedJob } from "./helpers.js";

const inDays = (days: number, hourUtc = 10) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    date.setUTCHours(hourUtc, 0, 0, 0);
    return date.toISOString();
};

async function createApplication(locale = "en") {
    await seedJob();
    const req = api().post("/api/v1/jobs/java-developer/applications");
    const fields = { firstName: "Nino", lastName: "Beridze", city: "Tbilisi", country: "GE", email: "nino@example.com", phone: "+995593512663", consent: "true", locale };
    for (const [key, value] of Object.entries(fields)) req.field(key, value);
    const res = await req.attach("resume", PDF, "cv.pdf").expect(201);
    await processOutboxBatch(AppDataSource);
    sentMails.length = 0;
    return res.body.id as string;
}

const interview = (overrides: Record<string, unknown> = {}) => ({
    title: "Tech interview",
    startsAt: inDays(3),
    durationMinutes: 45,
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    notes: "Technical round",
    ...overrides,
});

describe("interviews", () => {
    it("lets a recruiter schedule an interview, moves the application forward and invites the candidate", async () => {
        const applicationId = await createApplication("ka");
        const recruiter = await loginAs("recruiter" as never);

        const created = await recruiter.post(`/api/v1/admin/applications/${applicationId}/interviews`).send(interview()).expect(201);
        expect(created.body).toMatchObject({ title: "Tech interview", status: "scheduled", durationMinutes: 45, meetingUrl: "https://meet.google.com/abc-defg-hij" });

        const application = await AppDataSource.getRepository(JobApplication).findOneByOrFail({ id: applicationId });
        expect(application.status).toBe("interview");

        await processOutboxBatch(AppDataSource);
        expect(sentMails).toHaveLength(1);
        expect(sentMails[0]).toMatchObject({ to: ["nino@example.com"], subject: "მოწვევა გასაუბრებაზე: Tech interview" });
        expect(sentMails[0]!.text).toContain("https://meet.google.com/abc-defg-hij");
        expect(sentMails[0]!.text).toContain("Java დეველოპერი");

        const list = await recruiter.get(`/api/v1/admin/applications/${applicationId}/interviews`).expect(200);
        expect(list.body.items).toHaveLength(1);
    });

    it("doesn't move applications that are past the interview stage, and can skip the email", async () => {
        const applicationId = await createApplication();
        const agent = await loginAs();
        await agent.patch(`/api/v1/admin/applications/${applicationId}`).send({ status: "hired" }).expect(200);

        await agent.post(`/api/v1/admin/applications/${applicationId}/interviews`).send(interview({ notifyCandidate: false })).expect(201);
        expect((await AppDataSource.getRepository(JobApplication).findOneByOrFail({ id: applicationId })).status).toBe("hired");

        await processOutboxBatch(AppDataSource);
        expect(sentMails).toHaveLength(0);
    });

    it("reschedules and cancels with matching candidate emails", async () => {
        const applicationId = await createApplication();
        const agent = await loginAs();
        const { body } = await agent.post(`/api/v1/admin/applications/${applicationId}/interviews`).send(interview()).expect(201);
        await processOutboxBatch(AppDataSource);
        sentMails.length = 0;

        // Notes-only edits don't bother the candidate.
        await agent.patch(`/api/v1/admin/interviews/${body.id}`).send({ notes: "Bring portfolio" }).expect(200);
        await processOutboxBatch(AppDataSource);
        expect(sentMails).toHaveLength(0);

        const moved = await agent.patch(`/api/v1/admin/interviews/${body.id}`).send({ startsAt: inDays(4) }).expect(200);
        expect(moved.body.startsAt).toBe(inDays(4));
        await processOutboxBatch(AppDataSource);
        expect(sentMails.map((mail) => mail.subject)).toEqual(["Your interview has been updated: Tech interview"]);

        // Renaming the interview is a detail the candidate sees, so it notifies too.
        sentMails.length = 0;
        await agent.patch(`/api/v1/admin/interviews/${body.id}`).send({ title: "Final interview" }).expect(200);
        await processOutboxBatch(AppDataSource);
        expect(sentMails.map((mail) => mail.subject)).toEqual(["Your interview has been updated: Final interview"]);

        sentMails.length = 0;
        await agent.patch(`/api/v1/admin/interviews/${body.id}`).send({ status: "cancelled" }).expect(200);
        await agent.patch(`/api/v1/admin/interviews/${body.id}`).send({ status: "cancelled" }).expect(200);
        await processOutboxBatch(AppDataSource);
        expect(sentMails.map((mail) => mail.subject)).toEqual(["Your interview has been cancelled: Final interview"]);
        expect(sentMails[0]!.text).not.toContain("meet.google.com");

        await agent.patch(`/api/v1/admin/interviews/${body.id}`).send({ status: "completed", notifyCandidate: false }).expect(200);
    });

    it("validates the meeting link and input", async () => {
        const applicationId = await createApplication();
        const agent = await loginAs();
        const url = `/api/v1/admin/applications/${applicationId}/interviews`;

        const bad = await agent.post(url).send(interview({ meetingUrl: "javascript:alert(1)" })).expect(400);
        expect(bad.body.error.details.meetingUrl).toBeDefined();
        await agent.post(url).send(interview({ meetingUrl: "meet.google.com/abc" })).expect(400);
        await agent.post(url).send(interview({ durationMinutes: 5 })).expect(400);
        const untitled = await agent.post(url).send(interview({ title: "   " })).expect(400);
        expect(untitled.body.error.details.title).toBeDefined();
        await agent.post(url).send(interview({ startsAt: "tomorrow" })).expect(400);
        await agent.post(`/api/v1/admin/applications/00000000-0000-4000-8000-000000000000/interviews`).send(interview()).expect(404);
    });

    it("deletes interviews together with their application", async () => {
        const applicationId = await createApplication();
        const agent = await loginAs();
        await agent.post(`/api/v1/admin/applications/${applicationId}/interviews`).send(interview()).expect(201);
        await agent.delete(`/api/v1/admin/applications/${applicationId}`).expect(204);
        expect(await AppDataSource.query(`SELECT count(*)::int AS n FROM interviews`)).toEqual([{ n: 0 }]);
    });
});

describe("admin calendar", () => {
    it("merges calls and interviews for admins, and shows recruiters interviews only", async () => {
        const applicationId = await createApplication();
        const agent = await loginAs();
        await agent.post(`/api/v1/admin/applications/${applicationId}/interviews`).send(interview({ startsAt: inDays(3, 12) })).expect(201);

        const availability = await api().get("/api/v1/bookings/availability").expect(200);
        const slot: string = availability.body.days[1].slots[0];
        await api().post("/api/v1/bookings").send({ name: "Ann", email: "ann@example.com", startsAt: slot }).expect(201);

        const from = new Date().toISOString();
        const to = inDays(30);
        const res = await agent.get(`/api/v1/admin/calendar?from=${from}&to=${to}`).expect(200);
        expect(res.body.kinds).toEqual(["booking", "interview"]);

        const kinds = res.body.events.map((event: { kind: string }) => event.kind).sort();
        expect(kinds).toEqual(["booking", "interview"]);

        const call = res.body.events.find((event: { kind: string }) => event.kind === "booking");
        expect(call.booking.ipHash).toBeUndefined();
        expect(Date.parse(call.endsAt) - Date.parse(call.startsAt)).toBe(60 * 60_000);

        const meeting = res.body.events.find((event: { kind: string }) => event.kind === "interview");
        expect(meeting.interview.title).toBe("Tech interview");
        expect(meeting.interview.candidate).toMatchObject({ applicationId, name: "Nino Beridze", jobTitle: "Java Developer" });
        expect(Date.parse(meeting.endsAt) - Date.parse(meeting.startsAt)).toBe(45 * 60_000);

        const recruiter = await loginAs("recruiter" as never);
        const limited = await recruiter.get(`/api/v1/admin/calendar?from=${from}&to=${to}`).expect(200);
        expect(limited.body.kinds).toEqual(["interview"]);
        expect(limited.body.events.map((event: { kind: string }) => event.kind)).toEqual(["interview"]);

        await agent.get(`/api/v1/admin/calendar?from=${to}&to=${from}`).expect(400);
    });
});

describe("take-home tasks and custom emails", () => {
    const multipart = (req: import("supertest").Test, body: Record<string, unknown>, files: [Buffer, string][] = []) => {
        req.field("data", JSON.stringify(body));
        for (const [content, name] of files) req.attach("attachments", content, name);
        return req;
    };

    it("sends a take-home task without a meeting link, with the PDF attached and a custom message", async () => {
        const applicationId = await createApplication();
        const recruiter = await loginAs("recruiter" as never);

        const created = await multipart(
            recruiter.post(`/api/v1/admin/applications/${applicationId}/interviews`),
            {
                title: "Take-home task",
                startsAt: inDays(7),
                durationMinutes: 60,
                meetingUrl: "",
                email: { subject: "Your PhilTech take-home task", message: "Hi Nino,\nPlease find the task attached. Good luck!" },
            },
            [[PDF, "task.pdf"]],
        ).expect(201);

        expect(created.body.meetingUrl).toBeNull();
        expect(created.body.attachments).toEqual([
            expect.objectContaining({ fileName: "task.pdf", mimeType: "application/pdf", key: expect.stringContaining(`interview-attachments/${applicationId}/`) }),
        ]);

        await processOutboxBatch(AppDataSource);
        expect(sentMails).toHaveLength(1);
        const mail = sentMails[0]!;
        expect(mail.subject).toBe("Your PhilTech take-home task");
        expect(mail.text).toContain("Please find the task attached. Good luck!");
        expect(mail.text).not.toContain("Meeting link");
        expect(mail.attachments).toEqual([{ filename: "task.pdf", content: PDF, contentType: "application/pdf" }]);
    });

    it("previews the email with defaults for the editor", async () => {
        const applicationId = await createApplication("ka");
        const agent = await loginAs();
        const res = await agent
            .post("/api/v1/admin/interviews/email-preview")
            .send({ applicationId, title: "Tech interview", startsAt: inDays(2), meetingUrl: "https://meet.google.com/x", attachmentNames: ["brief.pdf"] })
            .expect(200);

        expect(res.body).toMatchObject({ to: "nino@example.com", locale: "ka", defaultSubject: "მოწვევა გასაუბრებაზე: Tech interview" });
        expect(res.body.defaultMessage).toContain("გამარჯობა Nino,");
        expect(res.body.html).toContain("brief.pdf");

        const custom = await agent
            .post("/api/v1/admin/interviews/email-preview")
            .send({ applicationId, title: "Tech interview", subject: "Custom subject", message: "<b>Hi</b>" })
            .expect(200);
        expect(custom.body.subject).toBe("Custom subject");
        expect(custom.body.html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
    });

    it("adds and removes attachments on update, re-sending the files", async () => {
        const applicationId = await createApplication();
        const agent = await loginAs();
        const { body } = await multipart(
            agent.post(`/api/v1/admin/applications/${applicationId}/interviews`),
            { title: "Take-home task", startsAt: inDays(7), notifyCandidate: false },
            [[PDF, "v1.pdf"]],
        ).expect(201);
        const oldKey = body.attachments[0].key;

        const updated = await multipart(agent.patch(`/api/v1/admin/interviews/${body.id}`), { removeAttachments: [oldKey] }, [[PDF, "v2.pdf"]]).expect(200);
        expect(updated.body.attachments.map((file: { fileName: string }) => file.fileName)).toEqual(["v2.pdf"]);
        expect(storedObjects.has(oldKey)).toBe(false);

        await processOutboxBatch(AppDataSource);
        expect(sentMails.map((mail) => [mail.subject, mail.attachments?.map((file) => file.filename)])).toEqual([
            ["Your interview has been updated: Take-home task", ["v2.pdf"]],
        ]);

        const view = await agent.get(`/api/v1/admin/interviews/${body.id}/attachments/0?disposition=inline`).expect(200);
        expect(view.body).toMatchObject({ disposition: "inline", fileName: "v2.pdf" });
        await agent.get(`/api/v1/admin/interviews/${body.id}/attachments/2`).expect(404);
    });

    it("rejects non-document files and too many files, and cleans up files with the application", async () => {
        const applicationId = await createApplication();
        const agent = await loginAs();
        const url = `/api/v1/admin/applications/${applicationId}/interviews`;
        const body = { title: "Take-home task", startsAt: inDays(7), notifyCandidate: false };

        await multipart(agent.post(url), body, [[Buffer.from("MZ not a pdf"), "task.pdf"]]).expect(400);
        await multipart(agent.post(url), body, [[PDF, "1.pdf"], [PDF, "2.pdf"], [PDF, "3.pdf"], [PDF, "4.pdf"]]).expect(400);
        const resumeOnly = storedObjects.size;

        await multipart(agent.post(url), body, [[PDF, "task.pdf"]]).expect(201);
        expect(storedObjects.size).toBe(resumeOnly + 1);

        await agent.delete(`/api/v1/admin/applications/${applicationId}`).expect(204);
        expect(storedObjects.size).toBe(0);
    });
});
