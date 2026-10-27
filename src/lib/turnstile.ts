import { env } from "../config/env.js";
import { HttpError } from "./http-error.js";

/** Verifies a Cloudflare Turnstile token. No-op unless TURNSTILE_SECRET is configured. */
export async function verifyTurnstile(token: unknown, ip: string | undefined): Promise<void> {
    if (!env.TURNSTILE_SECRET) return;

    if (typeof token !== "string" || !token) {
        throw HttpError.badRequest("Captcha verification required");
    }

    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }),
        signal: AbortSignal.timeout(5000),
    });
    const result = (await response.json()) as { success?: boolean };

    if (!result.success) {
        throw HttpError.badRequest("Captcha verification failed");
    }
}
