import request from "supertest";
import { app } from "../src/app.js";
import { AppDataSource } from "../src/config/database.js";
import { AdminRole, AdminUser } from "../src/entities/admin-user.entity.js";
import { Job } from "../src/entities/job.entity.js";
import { hashPassword } from "../src/lib/password.js";
import { createJob } from "../src/modules/jobs/jobs.service.js";
import { createJobBody } from "../src/modules/jobs/jobs.schema.js";

export const api = () => request(app);

export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

export function seedJob(overrides: Record<string, unknown> = {}) {
    return createJob(
        createJobBody.parse({
            slug: "java-developer",
            category: "it",
            location: "tbilisi",
            employmentType: "full_time",
            isPublished: true,
            translations: [
                { locale: "en", title: "Java Developer", description: "Build things", requirements: ["Java"] },
                { locale: "ka", title: "Java დეველოპერი", description: "შექმენი" },
            ],
            ...overrides,
        }),
    );
}

/** A job that was published and whose deadline has since passed (publishing it now would be rejected). */
export async function seedExpiredJob(slug: string) {
    const job = await seedJob({ slug, isPublished: false, applicationDeadline: "2020-01-01" });
    await AppDataSource.getRepository(Job).update(job.id, { isPublished: true, publishedAt: new Date("2019-12-01") });
    return job;
}

export async function loginAs(role: AdminRole = AdminRole.ADMIN) {
    const email = `${role}@example.com`;
    const password = "correct-horse-battery";
    await AppDataSource.getRepository(AdminUser).insert({
        email,
        displayName: role,
        role,
        passwordHash: await hashPassword(password),
    });
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ email, password }).expect(200);
    return agent;
}
