import { pino } from "pino";
import { env, isProduction } from "./env.js";

export const logger = pino({
    level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
    redact: {
        paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            'res.headers["set-cookie"]',
            "*.password",
            "*.passwordHash",
            ...(isProduction ? ["*.email", "*.phone"] : []),
        ],
        censor: "[redacted]",
    },
    ...(isProduction
        ? {}
        : { transport: { target: "pino-pretty", options: { colorize: true } } }),
});
