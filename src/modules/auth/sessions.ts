import type { CookieOptions, Request } from "express";
import { LessThan, MoreThan } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { env, isProduction } from "../../config/env.js";
import { AdminSession } from "../../entities/admin-session.entity.js";
import type { AdminUser } from "../../entities/admin-user.entity.js";
import { hashIp, randomToken, sha256 } from "../../lib/crypto.js";

const sessions = () => AppDataSource.getRepository(AdminSession);

// lastSeenAt is only refreshed after this long, to avoid a write on every request.
const TOUCH_INTERVAL_MS = 5 * 60_000;

export const sessionCookieOptions = (): CookieOptions => ({
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: env.SESSION_TTL_HOURS * 3600_000,
});

export async function createSession(user: AdminUser, req: Request): Promise<string> {
    const token = randomToken();
    const now = new Date();
    await sessions().insert({
        tokenHash: sha256(token),
        adminUserId: user.id,
        expiresAt: new Date(now.getTime() + env.SESSION_TTL_HOURS * 3600_000),
        lastSeenAt: now,
        ipHash: hashIp(req.ip),
        userAgent: req.get("user-agent")?.slice(0, 500) ?? null,
    });
    return token;
}

export async function findSession(token: string): Promise<AdminSession | null> {
    const session = await sessions().findOne({
        where: { tokenHash: sha256(token), expiresAt: MoreThan(new Date()) },
        relations: { adminUser: true },
    });
    if (!session || !session.adminUser.isActive) return null;

    if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        await sessions().update(session.id, { lastSeenAt: new Date() });
    }
    return session;
}

export async function deleteSession(token: string): Promise<void> {
    await sessions().delete({ tokenHash: sha256(token) });
}

export async function deleteUserSessions(adminUserId: string): Promise<void> {
    await sessions().delete({ adminUserId });
}

export async function purgeExpiredSessions(): Promise<number> {
    const result = await sessions().delete({ expiresAt: LessThan(new Date()) });
    return result.affected ?? 0;
}
