import ExcelJS from "exceljs";
import type { Response } from "supertest";
import { describe, expect, it } from "vitest";
import { AppDataSource } from "../src/config/database.js";
import { AdminRole } from "../src/entities/admin-user.entity.js";
import { ContactMessage } from "../src/entities/contact-message.entity.js";
import { bucketOf, bucketsBetween, pickGranularity } from "../src/modules/dashboard/dashboard.service.js";
import { api, loginAs, PDF, seedJob } from "./helpers.js";

/** Collects a binary response body (supertest only buffers text by default). */
const binary = (res: Response, callback: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
};

async function apply(slug: string, lastName: string, country = "GE") {
    return api()
        .post(`/api/v1/jobs/${slug}/applications`)
        .field({ firstName: "Nino", lastName, city: "Tbilisi", country, email: `${lastName}@example.com`, phone: "+995593512663", consent: "true", locale: "en" })
        .attach("resume", PDF, "cv.pdf")
        .expect(201);
}

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tbilisi" });

describe("dashboard buckets", () => {
    it("picks a granularity and buckets like date_trunc", () => {
        expect(pickGranularity("2026-10-01", "2026-10-30")).toBe("day");
        expect(pickGranularity("2026-01-01", "2026-05-01")).toBe("week");
        expect(pickGranularity("2025-01-01", "2026-01-01")).toBe("month");
        // 2026-10-29 is a Thursday; its week starts on Monday the 26th.
        expect(bucketOf("2026-10-29", "week")).toBe("2026-10-26");
        expect(bucketOf("2026-10-29", "month")).toBe("2026-10-01");
        expect(bucketsBetween("2026-10-30", "2026-11-02", "day")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
        expect(bucketsBetween("2026-09-30", "2026-11-02", "month")).toEqual(["2026-09-01", "2026-10-01", "2026-11-01"]);
    });
});

describe("dashboard", () => {
    it("summarizes the period with the previous one, a timeline and breakdowns", async () => {
        const java = await seedJob();
        await seedJob({ slug: "draft", isPublished: false });
        const first = await apply("java-developer", "One");
        await apply("java-developer", "Two", "DE");
        await AppDataSource.getRepository(ContactMessage).save({ name: "M", email: "m@example.com", message: "Hi", locale: "en", service: "web" } as never);

        const agent = await loginAs();
        await agent
            .post(`/api/v1/admin/applications/${first.body.id}/interviews`)
            .send({ title: "Tech interview", startsAt: new Date(Date.now() + 2 * 86400_000).toISOString(), notifyCandidate: false })
            .expect(201);

        const res = await agent.get(`/api/v1/admin/dashboard?from=${today()}&to=${today()}`).expect(200);
        expect(res.body.range).toMatchObject({ from: today(), to: today(), granularity: "day" });
        expect(res.body.series).toEqual(["applications", "interviews", "messages", "bookings"]);
        expect(res.body.totals.applications).toEqual({ value: 2, previous: 0 });
        expect(res.body.totals.messages.value).toBe(1);
        expect(res.body.timeline).toEqual([{ bucket: today(), applications: 2, interviews: 0, messages: 1, bookings: 0 }]);
        // The interview moved the application on.
        expect(res.body.pipeline).toEqual(expect.arrayContaining([{ key: "interview", count: 1 }, { key: "received", count: 1 }]));
        expect(res.body.topVacancies).toEqual([{ code: java.code, title: "Java Developer", count: 2 }]);
        expect(res.body.countries).toEqual([{ key: "DE", count: 1 }, { key: "GE", count: 1 }]);
        expect(res.body.kpis).toMatchObject({ openVacancies: 1, upcomingInterviews: 1, interviewRate: { value: 0.5, previous: null } });
        expect(res.body.kpis.medianDaysToInterview).toBeGreaterThan(1.9);
        expect(res.body.messageServices).toEqual([{ key: "web", count: 1 }]);

        // Default range is the last 30 days.
        const defaults = await agent.get("/api/v1/admin/dashboard").expect(200);
        expect(defaults.body.timeline).toHaveLength(30);
        await agent.get("/api/v1/admin/dashboard?from=2020-01-01&to=2026-01-01").expect(400);
    });

    it("leaves messages and bookings out for recruiters", async () => {
        const agent = await loginAs(AdminRole.RECRUITER);
        const res = await agent.get("/api/v1/admin/dashboard").expect(200);
        expect(res.body.series).toEqual(["applications", "interviews"]);
        expect(res.body.messageServices).toBeNull();
        expect(res.body.bookingStatuses).toBeNull();
    });
});

describe("reports", () => {
    it("exports applications as a styled Excel workbook with real dates", async () => {
        await seedJob();
        await apply("java-developer", "Excel");
        const agent = await loginAs();

        const res = await agent.get(`/api/v1/admin/reports/applications?format=xlsx&from=${today()}&to=${today()}`).buffer(true).parse(binary).expect(200);
        expect(res.headers["content-type"]).toContain("spreadsheetml");
        expect(res.headers["content-disposition"]).toBe(`attachment; filename="philtech-applications-${today()}_${today()}.xlsx"`);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(res.body);
        const sheet = workbook.getWorksheet("Applications")!;
        expect(sheet.getRow(1).getCell(1).value).toBe("Applied at");
        expect(sheet.getRow(1).font?.bold).toBe(true);
        expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
        expect(sheet.getRow(2).getCell(1).value).toBeInstanceOf(Date);
        expect(sheet.getRow(2).getCell(3).value).toBe("Excel");
        expect(sheet.getRow(2).getCell(5).value).toBe("+995593512663");
        expect(sheet.rowCount).toBe(2);
    });

    it("exports CSV with a BOM, escaping and formula protection", async () => {
        await AppDataSource.getRepository(ContactMessage).save({
            name: "=HYPERLINK(\"evil\")",
            email: "x@example.com",
            message: 'Line one\nsays "hi", ok',
            locale: "ka",
        } as never);
        const agent = await loginAs();
        const res = await agent.get(`/api/v1/admin/reports/messages?format=csv&from=${today()}&to=${today()}`).expect(200);
        expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
        expect(res.text.charCodeAt(0)).toBe(0xfeff);
        const [header, row] = res.text.slice(1).split("\r\n");
        expect(header).toBe("Received at,Name,Email,Phone,Company,Service,Message,Status,Language");
        expect(row).toContain(`"'=HYPERLINK(""evil"")"`);
        expect(row).toContain('"Line one\nsays ""hi"", ok"');
        expect(row).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2},/);
    });

    it("builds a multi-sheet overview and flattens it for CSV", async () => {
        await seedJob();
        await apply("java-developer", "Overview");
        const agent = await loginAs();

        const xlsx = await agent.get("/api/v1/admin/reports/overview").buffer(true).parse(binary).expect(200);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(xlsx.body);
        expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
            "Summary", "Timeline", "Application pipeline", "Top vacancies", "Countries",
            "Interviews by status", "Vacancies by status", "Messages by service", "Call bookings by status",
        ]);
        expect(workbook.getWorksheet("Summary")!.getRow(2).values).toEqual([undefined, "Applications", 1, 0]);

        const csv = await agent.get("/api/v1/admin/reports/overview?format=csv").expect(200);
        expect(csv.text).toContain("Summary,Applications,1,0,");
        expect(csv.text).toContain("Application pipeline,Received,1,,");
    });

    it("limits recruiters to hiring reports and validates input", async () => {
        const recruiter = await loginAs(AdminRole.RECRUITER);
        await recruiter.get("/api/v1/admin/reports/messages").expect(403);
        await recruiter.get("/api/v1/admin/reports/bookings?format=csv").expect(403);
        await recruiter.get("/api/v1/admin/reports/jobs?format=csv").expect(200);
        await recruiter.get("/api/v1/admin/reports/unknown").expect(400);
        await recruiter.get("/api/v1/admin/reports/applications?format=pdf").expect(400);
        await api().get("/api/v1/admin/reports/applications").expect(401);
    });
});
