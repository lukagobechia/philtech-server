import { afterAll, beforeAll, beforeEach, inject } from "vitest";

// Env must be set before any src module (env.ts parses it at import time).
Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: inject("databaseUrl"),
    IP_HASH_SECRET: "test-secret-test-secret",
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
