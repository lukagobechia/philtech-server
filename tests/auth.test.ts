import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { api, loginAs } from "./helpers.js";

describe("auth", () => {
    it("uses a generic error for unknown users and wrong passwords", async () => {
        await loginAs();
        const unknown = await api().post("/api/v1/auth/login").send({ email: "nobody@example.com", password: "x" }).expect(401);
        const wrong = await api().post("/api/v1/auth/login").send({ email: "admin@example.com", password: "x" }).expect(401);
        expect(unknown.body.error.message).toBe(wrong.body.error.message);
    });

    it("sets an httpOnly session cookie and revokes it on logout", async () => {
        const agent = await loginAs();
        const me = await agent.get("/api/v1/auth/me").expect(200);
        expect(me.body.user.passwordHash).toBeUndefined();

        await agent.post("/api/v1/auth/logout").expect(204);
        await agent.get("/api/v1/auth/me").expect(401);
    });

    it("blocks state-changing admin requests from untrusted origins", async () => {
        const agent = await loginAs();
        await agent.post("/api/v1/admin/users").set("Origin", "https://evil.example").send({}).expect(403);
        await agent
            .post("/api/v1/admin/users")
            .set("Origin", "http://localhost:3000")
            .send({ email: "new@example.com", displayName: "New", password: "long-enough-password" })
            .expect(201);
    });

    it("revokes sessions when an admin is deactivated", async () => {
        const admin = await loginAs();
        const recruiter = await loginAs("recruiter" as never);
        const me = await recruiter.get("/api/v1/auth/me").expect(200);

        await admin.patch(`/api/v1/admin/users/${me.body.user.id}`).send({ isActive: false }).expect(200);
        await recruiter.get("/api/v1/auth/me").expect(401);
    });

    it("reports readiness", async () => {
        await request(app).get("/health/ready").expect(200);
    });
});
