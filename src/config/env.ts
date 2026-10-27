import "dotenv/config";
import { z } from "zod";

const booleanString = z
    .enum(["true", "false", "1", "0"])
    .transform((value) => value === "true" || value === "1");

const csv = z
    .string()
    .transform((value) =>
        value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
    );

const envSchema = z.object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),

    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    LOG_LEVEL: z
        .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
        .default("info"),

    DATABASE_URL: z.string().min(1),

    POSTGRES_PASSWORD: z.string().min(1).optional(),

    // Comma separated list of origins allowed to call the API from a browser.
    CORS_ORIGINS: csv.default([]),

    // Number of reverse proxy hops in front of the API (0 = none).
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    // Secret used to hash client IPs before storing them.
    IP_HASH_SECRET: z.string().min(16),

    SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(12),
    SESSION_COOKIE_NAME: z.string().default("pt_session"),

    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: booleanString.default(false),

    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_SECURE: booleanString.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().min(1),
    NOTIFY_EMAIL_TO: csv,

    // Vacancy deadlines are whole days in this zone.
    COMPANY_TIMEZONE: z.string().default("Asia/Tbilisi"),

    // Initial booking schedule; after the first save in the admin panel the database copy is used.
    BOOKING_TIMEZONE: z.string().default("Asia/Tbilisi"),
    // ISO weekdays (1 = Monday ... 7 = Sunday).
    BOOKING_WEEKDAYS: csv
        .transform((items) => items.map(Number))
        .pipe(z.array(z.number().int().min(1).max(7)))
        .default([1, 2, 3, 4, 5]),
    // Local wall-clock slot start times, HH:mm.
    BOOKING_SLOTS: csv
        .pipe(z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)))
        .default(["17:30", "18:30", "19:30", "20:30", "21:30"]),
    BOOKING_SLOT_MINUTES: z.coerce.number().int().min(5).default(60),
    BOOKING_MIN_LEAD_HOURS: z.coerce.number().int().min(0).default(12),
    BOOKING_MAX_DAYS_AHEAD: z.coerce.number().int().min(1).default(60),

    PRIVACY_POLICY_VERSION: z.string().default("2026-01"),
    RETENTION_MONTHS: z.coerce.number().int().min(1).default(24),
    // Audit entries older than this are purged by the retention job.
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).default(730),
    // Also record scheduler runs that found nothing to do (off by default: they run every 30 s).
    AUDIT_IDLE_JOB_RUNS: z
        .enum(["true", "false"])
        .default("false")
        .transform((value) => value === "true"),

    TURNSTILE_SECRET: z.string().optional(),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
    console.error("Invalid environment configuration:");
    console.error(z.flattenError(result.error).fieldErrors);
    process.exit(1);
}

export const env = result.data;
export const isProduction = env.NODE_ENV === "production";
