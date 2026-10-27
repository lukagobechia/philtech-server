import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { verifyTurnstile } from "./turnstile.js";

/**
 * Anti-spam gate shared by all public forms. Returns false (and answers with a fake
 * success) when the honeypot is filled, so bots get no signal that they were caught.
 */
export async function acceptSubmission(req: Request, res: Response, body: Record<string, unknown>): Promise<boolean> {
    if (typeof body.website === "string" && body.website.trim() !== "") {
        req.log.info("Honeypot triggered, dropping submission");
        res.status(201).json({ id: randomUUID() });
        return false;
    }
    await verifyTurnstile(body.turnstileToken, req.ip);
    return true;
}
