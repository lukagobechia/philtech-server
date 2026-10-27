import { describe, expect, it } from "vitest";
import { AppDataSource } from "../src/config/database.js";
import { Job } from "../src/entities/job.entity.js";
import { companyDate, runJobSchedule } from "../src/modules/jobs/jobs.service.js";
import { api, loginAs, PDF, seedExpiredJob, seedJob } from "./helpers.js";

describe("public jobs", () => {
    it("lists published open jobs in the requested language with an English fallback", async () => {
        await seedJob();
        await seedJob({
            slug: "designer",
            category: "digital",
            translations: [{ locale: "en", title: "Designer", description: "Design" }],
        });
        await seedJob({ slug: "draft", isPublished: false });
        await seedExpiredJob("expired");

        const res = await api().get("/api/v1/jobs?lang=ka").expect(200);
        expect(res.body.total).toBe(2);
        const titles = res.body.items.map((job: { title: string }) => job.title).sort();
        expect(titles).toEqual(["Designer", "Java დეველოპერი"]);
    });

    it("filters by category and searches titles", async () => {
        await seedJob();
        await seedJob({ slug: "designer", category: "digital", translations: [{ locale: "en", title: "Designer", description: "d" }] });

        const byCategory = await api().get("/api/v1/jobs?category=digital").expect(200);
        expect(byCategory.body.items.map((job: { slug: string }) => job.slug)).toEqual(["designer"]);

        const bySearch = await api().get("/api/v1/jobs?q=jav").expect(200);
        expect(bySearch.body.items.map((job: { slug: string }) => job.slug)).toEqual(["java-developer"]);

        await api().get("/api/v1/jobs?category=nope").expect(400);
    });

    it("returns job detail by slug and 404s for unpublished jobs", async () => {
        await seedJob();
        await seedJob({ slug: "draft", isPublished: false });

        const res = await api().get("/api/v1/jobs/java-developer?lang=en").expect(200);
        expect(res.body).toMatchObject({ title: "Java Developer", isOpen: true, requirements: ["Java"] });

        await api().get("/api/v1/jobs/draft").expect(404);
    });

    it("returns filters for published jobs", async () => {
        await seedJob();
        const res = await api().get("/api/v1/jobs/filters").expect(200);
        expect(res.body).toMatchObject({ categories: ["it"], locations: ["tbilisi"] });
    });
});

describe("admin jobs", () => {
    it("requires authentication", async () => {
        await api().get("/api/v1/admin/jobs").expect(401);
    });

    it("creates, updates translations, publishes and deletes a job", async () => {
        const agent = await loginAs();
        const created = await agent
            .post("/api/v1/admin/jobs")
            .send({
                slug: "qa-engineer",
                category: "it",
                location: "remote",
                employmentType: "contract",
                translations: [{ locale: "en", title: "QA", description: "Test" }],
            })
            .expect(201);
        expect(created.body.isPublished).toBe(false);

        await agent
            .post("/api/v1/admin/jobs")
            .send({ ...created.body, translations: [{ locale: "en", title: "x", description: "y" }] })
            .expect(409);

        const updated = await agent
            .patch(`/api/v1/admin/jobs/${created.body.id}`)
            .send({
                translations: [
                    { locale: "en", title: "QA Engineer", description: "Test" },
                    { locale: "ka", title: "QA ინჟინერი", description: "ტესტი" },
                ],
            })
            .expect(200);
        expect(updated.body.translations.map((t: { locale: string }) => t.locale)).toEqual(["en", "ka"]);

        const published = await agent.post(`/api/v1/admin/jobs/${created.body.id}/publish`).expect(200);
        expect(published.body.publishedAt).toBeTruthy();
        await api().get("/api/v1/jobs/qa-engineer?lang=ka").expect(200);

        await agent.delete(`/api/v1/admin/jobs/${created.body.id}`).expect(204);
    });

    it("rejects translations without English", async () => {
        const agent = await loginAs();
        const res = await agent
            .post("/api/v1/admin/jobs")
            .send({
                slug: "x",
                category: "it",
                location: "remote",
                employmentType: "contract",
                translations: [{ locale: "ka", title: "x", description: "y" }],
            })
            .expect(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
});

describe("job codes and archive", () => {
    const apply = (slug: string) =>
        api()
            .post(`/api/v1/jobs/${slug}/applications`)
            .field({
                firstName: "Nino",
                lastName: "Beridze",
                city: "Tbilisi",
                country: "GE",
                email: "nino@example.com",
                phone: "+995593512663",
                consent: "true",
                locale: "ka",
            })
            .attach("resume", PDF, "cv.pdf");

    it("generates unique codes per domain and accepts custom ones", async () => {
        const year = new Date().getUTCFullYear();
        const it1 = await seedJob();
        const digital = await seedJob({ slug: "designer", category: "digital" });
        expect(it1.code).toMatch(new RegExp(`^IT-${year}-\\d{3}$`));
        expect(digital.code).toMatch(new RegExp(`^DIG-${year}-\\d{3}$`));
        expect(digital.code.split("-")[2]).not.toBe(it1.code.split("-")[2]);

        const custom = await seedJob({ slug: "custom", code: " pt-qa-01 " });
        expect(custom.code).toBe("PT-QA-01");

        const agent = await loginAs();
        const duplicate = await agent
            .post("/api/v1/admin/jobs")
            .send({ slug: "other", category: "it", location: "remote", employmentType: "contract", code: "PT-QA-01", translations: [{ locale: "en", title: "x", description: "y" }] })
            .expect(409);
        expect(duplicate.body.error.code).toBe("CODE_TAKEN");

        // The code is fixed once created.
        const patched = await agent.patch(`/api/v1/admin/jobs/${custom.id}`).send({ code: "NEW-1", location: "batumi" }).expect(200);
        expect(patched.body.code).toBe("PT-QA-01");

        const publicJob = await api().get("/api/v1/jobs/custom?lang=en").expect(200);
        expect(publicJob.body.code).toBe("PT-QA-01");
    });

    it("archives a job: off the site, closed to applications, restorable as a draft", async () => {
        const job = await seedJob();
        const agent = await loginAs();

        const archived = await agent.post(`/api/v1/admin/jobs/${job.id}/archive`).expect(200);
        expect(archived.body).toMatchObject({ isPublished: false });
        expect(archived.body.archivedAt).toBeTruthy();

        expect((await api().get("/api/v1/jobs?lang=en").expect(200)).body.total).toBe(0);
        await api().get("/api/v1/jobs/java-developer?lang=en").expect(404);
        await apply("java-developer").expect(404);

        const publish = await agent.post(`/api/v1/admin/jobs/${job.id}/publish`).expect(409);
        expect(publish.body.error.code).toBe("JOB_ARCHIVED");

        expect((await agent.get("/api/v1/admin/jobs").expect(200)).body.total).toBe(0);
        expect((await agent.get("/api/v1/admin/jobs?archived=true").expect(200)).body.items[0].code).toBe(job.code);
        expect((await agent.get("/api/v1/admin/jobs?archived=all").expect(200)).body.total).toBe(1);

        const restored = await agent.post(`/api/v1/admin/jobs/${job.id}/unarchive`).expect(200);
        expect(restored.body).toMatchObject({ archivedAt: null, isPublished: false });
        await agent.post(`/api/v1/admin/jobs/${job.id}/publish`).expect(200);
        await apply("java-developer").expect(201);
    });

    it("keeps the code on applications after the job is deleted, and never reuses it", async () => {
        const job = await seedJob({ code: "IT-JAVA-1" });
        const { body } = await apply("java-developer").expect(201);
        const agent = await loginAs();

        const before = await agent.get(`/api/v1/admin/applications/${body.id}`).expect(200);
        expect(before.body).toMatchObject({ jobId: job.id, jobCode: "IT-JAVA-1", jobTitle: "Java Developer" });

        await agent.delete(`/api/v1/admin/jobs/${job.id}`).expect(204);

        const after = await agent.get(`/api/v1/admin/applications/${body.id}`).expect(200);
        expect(after.body).toMatchObject({ jobId: null, jobCode: "IT-JAVA-1", jobTitle: "Java Developer" });

        const byCode = await agent.get("/api/v1/admin/applications?jobCode=it-java-1").expect(200);
        expect(byCode.body.items.map((row: { id: string }) => row.id)).toEqual([body.id]);
        const bySearch = await agent.get("/api/v1/admin/applications?q=JAVA-1").expect(200);
        expect(bySearch.body.total).toBe(1);

        const codes = await agent.get("/api/v1/admin/jobs/codes").expect(200);
        expect(codes.body.items).toEqual([{ code: "IT-JAVA-1", title: "Java Developer", jobId: null, state: "deleted", applications: 1 }]);

        const reuse = await agent
            .post("/api/v1/admin/jobs")
            .send({ slug: "java-developer", category: "it", location: "remote", employmentType: "contract", code: "IT-JAVA-1", translations: [{ locale: "en", title: "x", description: "y" }] })
            .expect(409);
        expect(reuse.body.error.code).toBe("CODE_TAKEN");
    });
});

describe("scheduled posting and deadlines", () => {
    const body = (overrides: Record<string, unknown> = {}) => ({
        slug: "scheduled",
        category: "it",
        location: "remote",
        employmentType: "contract",
        translations: [{ locale: "en", title: "Scheduled", description: "Later" }],
        ...overrides,
    });
    const inDays = (days: number) => new Date(Date.now() + days * 86400_000);
    const day = (date: Date) => companyDate(date);

    it("posts a scheduled job at its time and takes it down after the deadline", async () => {
        const agent = await loginAs();
        const publishAt = inDays(2);
        const created = await agent
            .post("/api/v1/admin/jobs")
            .send(body({ publishAt: publishAt.toISOString(), applicationDeadline: day(inDays(10)) }))
            .expect(201);
        expect(created.body).toMatchObject({ isPublished: false, publishAt: publishAt.toISOString() });
        await api().get("/api/v1/jobs/scheduled?lang=en").expect(404);

        expect(await runJobSchedule(inDays(1))).toEqual({ published: 0, unpublished: 0 });
        expect(await runJobSchedule(inDays(2.01))).toMatchObject({ published: 1 });
        const posted = await AppDataSource.getRepository(Job).findOneByOrFail({ id: created.body.id });
        expect(posted).toMatchObject({ isPublished: true, publishAt: null, publishedAt: publishAt });
        await api().get("/api/v1/jobs/scheduled?lang=en").expect(200);

        // The deadline day still counts; the job comes down once it is over.
        expect(await runJobSchedule(inDays(10))).toMatchObject({ unpublished: 0 });
        expect(await runJobSchedule(inDays(12))).toMatchObject({ unpublished: 1 });
        expect((await AppDataSource.getRepository(Job).findOneByOrFail({ id: created.body.id })).isPublished).toBe(false);
    });

    it("validates scheduling against state and deadline", async () => {
        const agent = await loginAs();
        await agent.post("/api/v1/admin/jobs").send(body({ isPublished: true, publishAt: inDays(1).toISOString() })).expect(400);
        const late = await agent
            .post("/api/v1/admin/jobs")
            .send(body({ publishAt: inDays(5).toISOString(), applicationDeadline: day(inDays(3)) }))
            .expect(400);
        expect(late.body.error.details.publishAt).toBeDefined();

        // A time that has already come publishes right away.
        const now = await agent.post("/api/v1/admin/jobs").send(body({ publishAt: inDays(-1).toISOString() })).expect(201);
        expect(now.body).toMatchObject({ isPublished: true, publishAt: null });
        const reschedule = await agent.patch(`/api/v1/admin/jobs/${now.body.id}`).send({ publishAt: inDays(1).toISOString() }).expect(409);
        expect(reschedule.body.error.code).toBe("JOB_ALREADY_PUBLISHED");

        // Publishing a scheduled draft by hand clears its schedule.
        const draft = await agent.post("/api/v1/admin/jobs").send(body({ slug: "draft-job" })).expect(201);
        await agent.patch(`/api/v1/admin/jobs/${draft.body.id}`).send({ publishAt: inDays(3).toISOString() }).expect(200);
        const published = await agent.post(`/api/v1/admin/jobs/${draft.body.id}/publish`).expect(200);
        expect(published.body).toMatchObject({ isPublished: true, publishAt: null });

        const expired = await seedExpiredJob("old-job");
        const unpublished = await agent.post(`/api/v1/admin/jobs/${expired.id}/unpublish`).expect(200);
        expect(unpublished.body.isPublished).toBe(false);
        const blocked = await agent.post(`/api/v1/admin/jobs/${expired.id}/publish`).expect(409);
        expect(blocked.body.error.code).toBe("DEADLINE_PASSED");
    });

    it("archives all unpublished jobs except scheduled ones", async () => {
        const agent = await loginAs();
        await seedJob({ slug: "live" });
        await seedJob({ slug: "draft-1", isPublished: false });
        await seedJob({ slug: "draft-2", isPublished: false });
        await agent.post("/api/v1/admin/jobs").send(body({ publishAt: inDays(3).toISOString() })).expect(201);

        const result = await agent.post("/api/v1/admin/jobs/archive-unpublished").expect(200);
        expect(result.body).toEqual({ archived: 2 });

        const active = await agent.get("/api/v1/admin/jobs").expect(200);
        expect(active.body.items.map((job: { slug: string }) => job.slug).sort()).toEqual(["live", "scheduled"]);
        expect((await agent.get("/api/v1/admin/jobs?archived=true").expect(200)).body.total).toBe(2);
    });
});
