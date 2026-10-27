import { afterAll, beforeAll, beforeEach, inject } from "vitest";

// Env must be set before any src module (env.ts parses it at import time).
Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: inject("databaseUrl"),
    IP_HASH_SECRET: "test-secret-test-secret",
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    DATA_INDEX_KEY: "test-index-key-test-index-key-test-index-key",
    CORS_ORIGINS: "http://localhost:3000",
    S3_BUCKET: "test",
    S3_ACCESS_KEY: "test",
    S3_SECRET_KEY: "test",
    SMTP_HOST: "localhost",
    SMTP_FROM: "test@example.com",
    NOTIFY_EMAIL_TO: "team@example.com",
    BOOKING_WEEKDAYS: "1,2,3,4,5,6,7",
    BOOKING_MIN_LEAD_HOURS: "0",
});

const { AppDataSource } = await import("../src/config/database.js");
const { resetFakes } = await import("./fakes.js");

// Tests TRUNCATE every table, so never let them run against anything but the throwaway container.
if (AppDataSource.options.url !== inject("databaseUrl")) {
    throw new Error("Refusing to run tests: DATABASE_URL is not the test container's database");
}

// Load migrations through vitest rather than TypeORM's file glob: Node's own loader can't
// resolve the ".js" imports of src modules that some migrations use.
// Not eager: eager globs are hoisted above the env setup and would load the real .env.
const migrationModules = await Promise.all(Object.values(import.meta.glob<Record<string, unknown>>("../src/migrations/*.ts")).map((load) => load()));
AppDataSource.setOptions({ migrations: migrationModules.flatMap((module) => Object.values(module)) as Function[] });

beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.runMigrations();
});

beforeEach(async () => {
    resetFakes();
    const tables = AppDataSource.entityMetadatas.map((meta) => `"${meta.tableName}"`).join(", ");
    await AppDataSource.query(`TRUNCATE ${tables} CASCADE`);
});

afterAll(async () => {
    await AppDataSource.destroy();
});
