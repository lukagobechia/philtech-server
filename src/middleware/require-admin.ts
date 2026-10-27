import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import type { AdminRole, AdminUser } from "../entities/admin-user.entity.js";
import { HttpError } from "../lib/http-error.js";
import { setAuditActor } from "../modules/audit/audit.context.js";
import { findSession } from "../modules/auth/sessions.js";

declare module "express-serve-static-core" {
    interface Request {
        admin?: AdminUser;
        sessionToken?: string;
    }
}

export const requireAdmin: RequestHandler = async (req, _res, next) => {
    const token: unknown = req.cookies?.[env.SESSION_COOKIE_NAME];
    if (typeof token !== "string" || !token) throw HttpError.unauthorized();

    const session = await findSession(token);
    if (!session) throw HttpError.unauthorized("Session expired");

    req.admin = session.adminUser;
    req.sessionToken = token;
    setAuditActor({ id: session.adminUser.id, email: session.adminUser.email, role: session.adminUser.role });
    next();
};

export const requireRole =
    (...roles: AdminRole[]): RequestHandler =>
    (req, _res, next) => {
        if (!req.admin || !roles.includes(req.admin.role)) throw HttpError.forbidden();
        next();
    };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated routes: state-changing requests that carry an
 * Origin header must come from an allowed origin. SameSite=Lax covers the rest.
 */
export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
    const origin = req.get("origin");
    if (!SAFE_METHODS.has(req.method) && origin && !env.CORS_ORIGINS.includes(origin)) {
        throw HttpError.forbidden("Untrusted origin");
    }
    next();
};
