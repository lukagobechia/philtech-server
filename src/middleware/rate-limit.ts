import { rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";

const handler: Parameters<typeof rateLimit>[0] = {
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => env.NODE_ENV === "test",
    message: { error: { code: "RATE_LIMITED", message: "Too many requests, try again later" } },
};

export const apiLimiter = rateLimit({ ...handler, windowMs: 60_000, limit: 300 });

// Public form submissions; each form gets its own counter so one form can't exhaust another.
export const submissionLimiter = () => rateLimit({ ...handler, windowMs: 10 * 60_000, limit: 10 });

export const loginLimiter = rateLimit({
    ...handler,
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
});
