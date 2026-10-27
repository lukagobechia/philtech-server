import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { QueryFailedError } from "typeorm";
import { ZodError, z } from "zod";
import { isProduction } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
    next(HttpError.notFound("Route not found"));
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
    if (error instanceof ZodError) {
        res.status(400).json({
            error: {
                code: "VALIDATION_ERROR",
                message: "Request validation failed",
                details: z.flattenError(error).fieldErrors,
            },
        });
        return;
    }

    if (error instanceof multer.MulterError) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({ error: { code: error.code, message: error.message } });
        return;
    }

    if (error instanceof HttpError) {
        res.status(error.status).json({
            error: { code: error.code, message: error.message, details: error.details },
        });
        return;
    }

    if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === "23505") {
        res.status(409).json({ error: { code: "CONFLICT", message: "Resource conflicts with an existing record" } });
        return;
    }

    // body-parser errors (malformed JSON, payload too large) carry a status.
    const status = typeof error?.status === "number" ? error.status : 500;
    if (status >= 400 && status < 500) {
        res.status(status).json({ error: { code: "BAD_REQUEST", message: error.message } });
        return;
    }

    req.log.error({ err: error }, "Unhandled error");
    res.status(500).json({
        error: {
            code: "INTERNAL_ERROR",
            message: isProduction ? "Internal server error" : String(error?.message ?? error),
        },
    });
};
