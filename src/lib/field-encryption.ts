import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { ValueTransformer } from "typeorm";
import { env } from "../config/env.js";

/**
 * Application-level encryption for personal data. Values are encrypted before they reach
 * Postgres and decrypted only inside the API, which hands them out to signed-in admins,
 * so a database dump or backup on its own reveals nothing.
 *
 * Stored format: "enc:v1:<key id>:<base64url(iv | auth tag | ciphertext)>". The key id lets
 * rows written with a retired key (DATA_ENCRYPTION_PREVIOUS_KEYS) still be read after a rotation.
 */

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

type Key = { id: string; secret: Buffer };

const toKey = (base64: string): Key => {
    const secret = Buffer.from(base64, "base64");
    return { id: createHash("sha256").update(secret).digest("hex").slice(0, 8), secret };
};

const currentKey = toKey(env.DATA_ENCRYPTION_KEY);
const keysById = new Map([currentKey, ...env.DATA_ENCRYPTION_PREVIOUS_KEYS.map(toKey)].map((key) => [key.id, key]));

export function encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", currentKey.secret, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${PREFIX}${currentKey.id}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

export const isEncrypted = (value: string) => value.startsWith(PREFIX);

/** Values without the prefix were written before encryption was turned on and are returned as is. */
export function decrypt(value: string): string {
    if (!isEncrypted(value)) return value;
    const [keyId, payload] = value.slice(PREFIX.length).split(":");
    const key = keysById.get(keyId!);
    if (!key || !payload) throw new Error(`Cannot decrypt value: unknown key "${keyId}"`);

    const data = Buffer.from(payload, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key.secret, data.subarray(0, IV_BYTES));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

export const decryptJson = <T>(value: string): T => JSON.parse(decrypt(value)) as T;

/** Column transformer for encrypted text. Encrypted columns can't be filtered, sorted or searched in SQL. */
export const encrypted: ValueTransformer = {
    to: (value: string | null | undefined) => (value == null ? value : encrypt(value)),
    from: (value: string | null) => (value == null ? value : decrypt(value)),
};

/** Same as `encrypted` for structured values, stored as encrypted JSON in a text column. */
export const encryptedJson: ValueTransformer = {
    to: (value: unknown) => (value === undefined ? value : encrypt(JSON.stringify(value))),
    from: (value: string | null) => (value == null ? value : decryptJson(value)),
};

/** Decrypts the named fields of rows from a raw query, which skips column transformers. */
export function decryptRows<T extends Record<string, unknown>>(rows: T[], fields: (keyof T)[]): T[] {
    for (const row of rows) {
        for (const field of fields) {
            if (typeof row[field] === "string") row[field] = decrypt(row[field] as string) as T[keyof T];
        }
    }
    return rows;
}

// ---- Blind index ----
// Keyed hashes that let SQL match encrypted values without decrypting them. They reveal
// which rows share a value, so they are only kept for fields that need lookups or search.

const blindHash = (value: string) => createHmac("sha256", env.DATA_INDEX_KEY).update(value).digest("base64url").slice(0, 22);

/** Exact-match lookup hash, e.g. for a unique email. */
export const lookupHash = (value: string) => blindHash(`lookup:${value.trim().toLowerCase()}`);

// Longest prefix that is indexed; longer search words are cut to it.
const MAX_PREFIX = 24;

const words = (text: string) =>
    text
        .normalize("NFKC")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);

const term = (word: string) => blindHash(`term:${word.slice(0, MAX_PREFIX)}`);

/**
 * Search terms for a row. Short fields (names, emails) are indexed by every word prefix so
 * "ali" finds "Alice"; long text (messages, notes) by whole words only, to keep the index small.
 */
export function searchIndexTerms(prefixed: (string | null | undefined)[], whole: (string | null | undefined)[] = []): string[] {
    const terms = new Set<string>();
    for (const word of prefixed.flatMap((text) => (text ? words(text) : []))) {
        for (let length = 1; length <= Math.min(word.length, MAX_PREFIX); length++) terms.add(term(word.slice(0, length)));
    }
    for (const word of whole.flatMap((text) => (text ? words(text) : []))) terms.add(term(word));
    return [...terms];
}

/** Terms a row must all contain to match a search query: each word of the query, as typed. */
export const searchQueryTerms = (query: string): string[] => [...new Set(words(query).map(term))];
