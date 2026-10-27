import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { AppDataSource } from "./config/database.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { getStorage } from "./lib/storage.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { apiLimiter } from "./middleware/rate-limit.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { auditRequests } from "./modules/audit/audit.service.js";
import { publicApplicationsRouter } from "./modules/applications/applications.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { publicBookingsRouter } from "./modules/bookings/bookings.routes.js";
import { publicContactRouter } from "./modules/contact/contact.routes.js";
import { publicJobsRouter } from "./modules/jobs/jobs.routes.js";

export const app = express();

app.disable("x-powered-by");
app.set("trust proxy", env.TRUST_PROXY);

app.use(
    pinoHttp({
        logger,
        genReqId: (req, res) => {
            const incoming = req.headers["x-request-id"];
            const id = typeof incoming === "string" && /^[\w-]{1,128}$/.test(incoming) ? incoming : randomUUID();
            res.setHeader("X-Request-Id", id);
            return id;
        },
        autoLogging: { ignore: (req) => req.url?.startsWith("/health") ?? false },
    }),
);
// Right after the request id is assigned, so every API request is recorded with it.
app.use(auditRequests);
app.use(helmet());
app.use(
    cors({
        origin: env.CORS_ORIGINS,
        credentials: true,
        exposedHeaders: ["X-Request-Id"],
    }),
);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.get("/health/live", (_req, res) => {
    res.status(200).json({ status: "ok" });
});

app.get("/health/ready", async (req, res) => {
    const checks = await Promise.allSettled([AppDataSource.query("SELECT 1"), getStorage().ping()]);
    const [database, storage] = checks.map((check) => (check.status === "fulfilled" ? "ok" : "error"));
    const ok = checks.every((check) => check.status === "fulfilled");
    if (!ok) req.log.warn({ checks }, "Readiness check failed");
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "error", database, storage });
});

const api = Router();
api.use(apiLimiter);
api.use("/jobs", publicJobsRouter);
api.use("/jobs/:slug/applications", publicApplicationsRouter);
api.use("/contact-messages", publicContactRouter);
api.use("/bookings", publicBookingsRouter);
api.use("/auth", authRouter);
api.use("/admin", adminRouter);

app.use("/api/v1", api);

app.use(notFoundHandler);
app.use(errorHandler);
