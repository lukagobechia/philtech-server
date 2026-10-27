import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../../config/database.js";
import { env } from "../../config/env.js";
import { AdminUser } from "../../entities/admin-user.entity.js";
import { HttpError } from "../../lib/http-error.js";
import { verifyDummyPassword, verifyPassword } from "../../lib/password.js";
import { schemas } from "../../lib/schemas.js";
import { loginLimiter } from "../../middleware/rate-limit.js";
import { requireAdmin, requireTrustedOrigin } from "../../middleware/require-admin.js";
import { AuditOutcome } from "../../entities/audit-log.entity.js";
import { setAuditActor } from "../audit/audit.context.js";
import { recordAudit } from "../audit/audit.service.js";
import { createSession, deleteSession, sessionCookieOptions } from "./sessions.js";

const loginBody = z.object({
    email: schemas.email,
    password: z.string().min(1).max(256),
});

export const toAdminView = ({ passwordHash: _hash, ...user }: AdminUser) => user;

export const authRouter = Router();

authRouter.use(requireTrustedOrigin);

authRouter.post("/login", loginLimiter, async (req, res) => {
    const { email, password } = loginBody.parse(req.body);
    const repository = AppDataSource.getRepository(AdminUser);
    const user = await repository.findOneBy({ email });

    const failed = async (reason: string) => {
        await recordAudit({
            action: "auth.login_failed",
            outcome: AuditOutcome.FAILURE,
            entityType: "admin_user",
            entityId: user?.id,
            summary: `Failed sign-in for ${email}`,
            data: { email, reason },
        });
        return HttpError.unauthorized("Invalid email or password");
    };
    if (!user) {
        await verifyDummyPassword(password);
        throw await failed("unknown_email");
    }
    if (!(await verifyPassword(user.passwordHash, password))) throw await failed("wrong_password");
    if (!user.isActive) throw await failed("inactive");

    const token = await createSession(user, req);
    await repository.update(user.id, { lastLoginAt: new Date() });
    // From here on this request (and its log entries) belongs to the user who signed in.
    setAuditActor({ id: user.id, email: user.email, role: user.role });
    await recordAudit({ action: "auth.login", entityType: "admin_user", entityId: user.id, summary: `${user.email} signed in` });

    res.cookie(env.SESSION_COOKIE_NAME, token, sessionCookieOptions());
    res.json({ user: toAdminView(user) });
});

authRouter.post("/logout", requireAdmin, async (req, res) => {
    await deleteSession(req.sessionToken!);
    await recordAudit({ action: "auth.logout", entityType: "admin_user", entityId: req.admin!.id, summary: `${req.admin!.email} signed out` });
    const { maxAge: _maxAge, ...cookieOptions } = sessionCookieOptions();
    res.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions);
    res.status(204).end();
});

authRouter.get("/me", requireAdmin, (req, res) => {
    res.json({ user: toAdminView(req.admin!) });
});
