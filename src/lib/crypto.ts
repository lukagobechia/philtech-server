import { createHash, createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

export function hashIp(ip: string | undefined): string | null {
    if (!ip) return null;
    return createHmac("sha256", env.IP_HASH_SECRET).update(ip).digest("hex");
}

export function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
}
