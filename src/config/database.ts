import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { DataSource } from "typeorm";
import { env } from "./env.js";
import { AdminSession } from "../entities/admin-session.entity.js";
import { AdminUser } from "../entities/admin-user.entity.js";
import { AuditLog } from "../entities/audit-log.entity.js";
import { BookingSettings } from "../entities/booking-settings.entity.js";
import { CallBooking } from "../entities/call-booking.entity.js";
import { ContactMessage } from "../entities/contact-message.entity.js";
import { EmailOutbox } from "../entities/email-outbox.entity.js";
import { EmployeeEvent } from "../entities/employee-event.entity.js";
import { Employee } from "../entities/employee.entity.js";
import { Interview } from "../entities/interview.entity.js";
import { JobApplication } from "../entities/job-application.entity.js";
import { JobTranslation } from "../entities/job-translation.entity.js";
import { Job } from "../entities/job.entity.js";
import { OvertimeEntry } from "../entities/overtime-entry.entity.js";

// Resolves to src/migrations/*.ts under tsx and dist/migrations/*.js in production.
const migrationsGlob = fileURLToPath(
    new URL(`../migrations/*.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url),
);

export const AppDataSource = new DataSource({
    type: "postgres",
    url: env.DATABASE_URL,
    entities: [
        AdminSession,
        AdminUser,
        AuditLog,
        BookingSettings,
        CallBooking,
        ContactMessage,
        EmailOutbox,
        Employee,
        EmployeeEvent,
        Interview,
        Job,
        JobApplication,
        JobTranslation,
        OvertimeEntry,
    ],
    synchronize: false,
    logging: env.NODE_ENV === "development" ? ["error", "warn", "migration"] : ["error"],
    migrations: [migrationsGlob],
    extra: { max: 10 },
});
