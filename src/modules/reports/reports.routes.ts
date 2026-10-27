import { Router } from "express";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import { AdminRole } from "../../entities/admin-user.entity.js";
import { HttpError } from "../../lib/http-error.js";
import { toCsv, toXlsx } from "../../lib/spreadsheet.js";
import { AuditOutcome } from "../../entities/audit-log.entity.js";
import { auditFilters } from "../audit/audit.routes.js";
import { recordAudit } from "../audit/audit.service.js";
import { dateRangeQuery } from "../dashboard/dashboard.service.js";
import { ADMIN_ONLY_REPORTS, buildReport, flattenSheets, REPORT_TYPES } from "./reports.service.js";

const reportParams = z.object({ type: z.enum(REPORT_TYPES) });

const reportQuery = z.object({
    format: z.enum(["csv", "xlsx"]).default("xlsx"),
    // Comma-separated statuses of the report's own kind, e.g. "received,reviewing".
    status: z
        .string()
        .regex(/^[a-z_]+(,[a-z_]+)*$/, "Use comma-separated statuses")
        .transform((value) => value.split(","))
        .optional(),
});

/** Mounted at /admin/reports. */
export const reportsRouter = Router();

reportsRouter.get("/:type", async (req, res) => {
    const { type } = reportParams.parse(req.params);
    // For the audit report "status" is an HTTP status filter, read by its own filters below.
    const { format, status } = reportQuery.parse(type === "audit" ? { format: req.query.format } : req.query);
    const range = dateRangeQuery.parse(req.query);
    const isAdmin = req.admin!.role === AdminRole.ADMIN;
    // The audit report takes the audit page's filters (user id, action, outcome...).
    const audit = type === "audit" ? auditFilters.parse(req.query) : undefined;
    const details = { type, format, from: range.from, to: range.to, statuses: status ?? null, ...(audit ? { filters: audit } : {}) };
    if (ADMIN_ONLY_REPORTS.has(type) && !isAdmin) {
        await recordAudit({ action: "report.export_denied", outcome: AuditOutcome.FAILURE, entityType: "report", entityId: type, summary: `Denied ${type} report`, data: details });
        throw HttpError.forbidden();
    }

    let sheets, body;
    try {
        sheets = await buildReport(type, range, { includeInbox: isAdmin, statuses: status, auditFilters: audit });
        body = format === "csv" ? toCsv(flattenSheets(sheets)) : await toXlsx(sheets, { title: `PhilTech ${type} report` });
    } catch (error) {
        await recordAudit({ action: "report.export_failed", outcome: AuditOutcome.FAILURE, entityType: "report", entityId: type, summary: `Failed to build ${type} report`, data: { ...details, error: String(error) } });
        throw error;
    }

    // Reports contain personal data, so every export is recorded with who made it and what it covered.
    const rows = sheets.reduce((n, sheet) => n + sheet.rows.length, 0);
    logger.info({ adminUserId: req.admin!.id, ...details, rows }, "Report exported");
    await recordAudit({
        action: "report.exported",
        entityType: "report",
        entityId: type,
        summary: `Exported ${type} report (${format.toUpperCase()}, ${range.from} – ${range.to}, ${rows} rows)`,
        data: { ...details, rows, sheets: sheets.map((sheet) => sheet.name) },
    });

    const fileName = `philtech-${type}-${range.from}_${range.to}.${format}`;
    res.set({
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(body.length),
    });
    res.send(body);
});
