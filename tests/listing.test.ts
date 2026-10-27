import { describe, expect, it } from "vitest";
import { AppDataSource } from "../src/config/database.js";
import { AdminRole } from "../src/entities/admin-user.entity.js";
import { CallBooking } from "../src/entities/call-booking.entity.js";
import { ContactMessage } from "../src/entities/contact-message.entity.js";
import { Job } from "../src/entities/job.entity.js";
import { api, loginAs, PDF, seedJob } from "./helpers.js";

const messages = () => AppDataSource.getRepository(ContactMessage);

async function seedMessages() {
    const rows = [
        { name: "Ana", status: "new", service: "web", createdAt: new Date("2026-03-01T10:00:00Z") },
        { name: "Beka", status: "new", service: "mobile", createdAt: new Date("2026-03-05T10:00:00Z") },
        { name: "Dato", status: "resolved", service: "web", createdAt: new Date("2026-03-10T10:00:00Z") },
        { name: "Eka", status: "spam", service: null, createdAt: new Date("2026-03-15T10:00:00Z") },
    ] as const;
    for (const row of rows) {
        const saved = await messages().save({ ...row, email: `${row.name.toLowerCase()}@example.com`, message: `Hi from ${row.name}`, locale: "en" } as never);
        // createdAt is set by the database on insert; backdate it for the range tests.
        await messages().update((saved as ContactMessage).id, { createdAt: row.createdAt });
    }
}

const names = (body: { items: { name: string }[] }) => body.items.map((item) => item.name);

describe("inbox listing", () => {
    it("filters by several statuses, a day range and search, and sorts", async () => {
        await seedMessages();
        const agent = await loginAs();

        const open = await agent.get("/api/v1/admin/contact-messages?status=new,resolved").expect(200);
        expect(names(open.body)).toEqual(["Dato", "Beka", "Ana"]);

        const range = await agent.get("/api/v1/admin/contact-messages?from=2026-03-05&to=2026-03-10&sort=oldest").expect(200);
        expect(names(range.body)).toEqual(["Beka", "Dato"]);

        const search = await agent.get("/api/v1/admin/contact-messages?q=from%20eka").expect(200);
        expect(names(search.body)).toEqual(["Eka"]);

        const paged = await agent.get("/api/v1/admin/contact-messages?limit=3&page=2").expect(200);
        expect(paged.body).toMatchObject({ total: 4, page: 2, limit: 3 });
        expect(names(paged.body)).toEqual(["Ana"]);

        await agent.get("/api/v1/admin/contact-messages?status=bogus").expect(400);
        await agent.get("/api/v1/admin/contact-messages?sort=bogus").expect(400);
    });

    it("groups counts by a column, ignoring that column's own filter", async () => {
        await seedMessages();
        const agent = await loginAs();

        const byStatus = await agent.get("/api/v1/admin/contact-messages/summary?status=new&service=web").expect(200);
        // The status filter is left out so every status is counted; the service filter still applies.
        expect(byStatus.body).toEqual({
            groupBy: "status",
            total: 2,
            groups: [
                { key: "new", count: 1 },
                { key: "resolved", count: 1 },
            ],
        });

        const byService = await agent.get("/api/v1/admin/contact-messages/summary?groupBy=service").expect(200);
        expect(byService.body.groups).toEqual([
            { key: "web", count: 2 },
            { key: "mobile", count: 1 },
            { key: null, count: 1 },
        ]);

        await agent.get("/api/v1/admin/contact-messages/summary?groupBy=email").expect(400);
    });

    it("filters bookings by call time and sorts by the soonest call", async () => {
        const bookings = AppDataSource.getRepository(CallBooking);
        for (const [name, startsAt] of [["Late", "2026-05-03T08:00:00Z"], ["Early", "2026-05-01T08:00:00Z"], ["Out", "2026-06-01T08:00:00Z"]]) {
            await bookings.save({ name, email: "x@example.com", startsAt: new Date(startsAt!), timezone: "Asia/Tbilisi", locale: "en" } as never);
        }
        const agent = await loginAs();
        const res = await agent.get("/api/v1/admin/bookings?from=2026-05-01&to=2026-05-31&sort=soonest").expect(200);
        expect(names(res.body)).toEqual(["Early", "Late"]);
    });

    it("groups applications by job code and filters by country", async () => {
        const java = await seedJob();
        const react = await seedJob({ slug: "react", code: "IT-REACT" });
        const apply = (slug: string, lastName: string, country: string) =>
            api()
                .post(`/api/v1/jobs/${slug}/applications`)
                .field({ firstName: "N", lastName, city: "X", country, email: `${lastName}@example.com`, phone: "+995593512663", consent: "true", locale: "en" })
                .attach("resume", PDF, "cv.pdf")
                .expect(201);
        await apply("java-developer", "Zed", "GE");
        await apply("java-developer", "Abe", "DE");
        await apply("react", "Mia", "GE");

        const agent = await loginAs();
        const summary = await agent.get("/api/v1/admin/applications/summary?groupBy=jobCode").expect(200);
        expect(summary.body.groups).toEqual([
            { key: java.code, count: 2 },
            { key: react.code, count: 1 },
        ]);

        const georgians = await agent.get("/api/v1/admin/applications?country=ge&sort=name").expect(200);
        expect(georgians.body.items.map((item: { lastName: string }) => item.lastName)).toEqual(["Mia", "Zed"]);
    });
});

describe("admin job listing", () => {
    async function seedVariety() {
        await seedJob({ slug: "java-developer", code: "IT-JAVA" });
        await seedJob({ slug: "designer", category: "digital", location: "batumi", isPublished: false, translations: [{ locale: "en", title: "Brand Designer", description: "x" }] });
        const scheduled = await seedJob({ slug: "later", isPublished: false, translations: [{ locale: "en", title: "Analyst", description: "x" }] });
        await AppDataSource.getRepository(Job).update(scheduled.id, { publishAt: new Date(Date.now() + 86400_000) });
        // Past its deadline and already taken down by the scheduler.
        await seedJob({ slug: "old", isPublished: false, applicationDeadline: "2020-01-01" });
        const archived = await seedJob({ slug: "gone", isPublished: false });
        await AppDataSource.getRepository(Job).update(archived.id, { archivedAt: new Date() });
    }

    it("searches, filters by lifecycle status and attributes, and sorts by title", async () => {
        await seedVariety();
        const agent = await loginAs();
        const slugs = (body: { items: { slug: string }[] }) => body.items.map((item) => item.slug);

        expect(slugs((await agent.get("/api/v1/admin/jobs?q=it-java").expect(200)).body)).toEqual(["java-developer"]);
        expect(slugs((await agent.get("/api/v1/admin/jobs?q=brand").expect(200)).body)).toEqual(["designer"]);

        const statuses = await agent.get("/api/v1/admin/jobs?status=scheduled,expired&sort=title").expect(200);
        expect(statuses.body.items.map((job: { slug: string; status: string }) => [job.slug, job.status])).toEqual([
            ["later", "scheduled"],
            ["old", "expired"],
        ]);

        expect(slugs((await agent.get("/api/v1/admin/jobs?category=digital&location=batumi").expect(200)).body)).toEqual(["designer"]);

        const sorted = await agent.get("/api/v1/admin/jobs?sort=title&limit=2").expect(200);
        expect(sorted.body.total).toBe(4);
        expect(slugs(sorted.body)).toEqual(["later", "designer"]);
        expect(sorted.body.items[0].translations).toHaveLength(1);
    });

    it("summarizes jobs by status and category", async () => {
        await seedVariety();
        const agent = await loginAs();

        const byStatus = await agent.get("/api/v1/admin/jobs/summary?archived=all").expect(200);
        expect(Object.fromEntries(byStatus.body.groups.map((g: { key: string; count: number }) => [g.key, g.count]))).toEqual({
            published: 1,
            draft: 1,
            scheduled: 1,
            expired: 1,
            archived: 1,
        });

        const byCategory = await agent.get("/api/v1/admin/jobs/summary?groupBy=category&status=draft,published").expect(200);
        expect(byCategory.body.groups).toEqual([
            { key: "digital", count: 1 },
            { key: "it", count: 1 },
        ]);
    });
});

describe("other lists", () => {
    it("paginates and filters admin users", async () => {
        const agent = await loginAs();
        await agent.post("/api/v1/admin/users").send({ email: "rec1@example.com", displayName: "Recruiter One", password: "long-password-123", role: "recruiter" }).expect(201);
        await agent.post("/api/v1/admin/users").send({ email: "rec2@example.com", displayName: "Second", password: "long-password-123", role: "recruiter" }).expect(201);

        const recruiters = await agent.get(`/api/v1/admin/users?role=${AdminRole.RECRUITER}&limit=1`).expect(200);
        expect(recruiters.body).toMatchObject({ total: 2, limit: 1 });
        const search = await agent.get("/api/v1/admin/users?q=second").expect(200);
        expect(search.body.items.map((user: { email: string }) => user.email)).toEqual(["rec2@example.com"]);
    });

    it("filters the calendar by kind", async () => {
        await AppDataSource.getRepository(CallBooking).save({ name: "Call", email: "x@example.com", startsAt: new Date("2026-05-01T08:00:00Z"), timezone: "Asia/Tbilisi", locale: "en" } as never);
        const agent = await loginAs();
        const range = "from=2026-04-30T00:00:00Z&to=2026-05-02T00:00:00Z";
        expect((await agent.get(`/api/v1/admin/calendar?${range}`).expect(200)).body.events).toHaveLength(1);
        expect((await agent.get(`/api/v1/admin/calendar?${range}&kind=interview`).expect(200)).body.events).toHaveLength(0);
        expect((await agent.get(`/api/v1/admin/calendar?${range}&status=cancelled`).expect(200)).body.events).toHaveLength(0);
    });

    it("counts open jobs per category and location for the career filters", async () => {
        await seedJob();
        await seedJob({ slug: "remote-java", location: "remote" });
        await seedJob({ slug: "designer", category: "digital", isPublished: false });
        const res = await api().get("/api/v1/jobs/filters").expect(200);
        expect(res.body).toEqual({
            categories: ["it"],
            locations: ["remote", "tbilisi"],
            counts: { category: { it: 2 }, location: { remote: 1, tbilisi: 1 } },
        });
    });
});
