import { Router } from "express";
import { AdminRole } from "../../entities/admin-user.entity.js";
import { requireAdmin, requireRole, requireTrustedOrigin } from "../../middleware/require-admin.js";
import { adminApplicationsRouter } from "../applications/applications.routes.js";
import { auditRouter } from "../audit/audit.routes.js";
import { adminBookingSettingsRouter, adminBookingsRouter } from "../bookings/bookings.routes.js";
import { adminContactRouter } from "../contact/contact.routes.js";
import { adminJobsRouter } from "../jobs/jobs.routes.js";
import { calendarRouter } from "../calendar/calendar.routes.js";
import { dashboardRouter } from "../dashboard/dashboard.routes.js";
import { employeesRouter, overtimeRouter } from "../employees/employees.routes.js";
import { reportsRouter } from "../reports/reports.routes.js";
import { applicationInterviewsRouter, interviewsRouter } from "../interviews/interviews.routes.js";
import { adminUsersRouter } from "./users.routes.js";

export const adminRouter = Router();

adminRouter.use(requireTrustedOrigin, requireAdmin, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
});

const anyStaff = requireRole(AdminRole.ADMIN, AdminRole.RECRUITER);
const adminOnly = requireRole(AdminRole.ADMIN);

adminRouter.use("/jobs", anyStaff, adminJobsRouter);
adminRouter.use("/applications/:id/interviews", anyStaff, applicationInterviewsRouter);
adminRouter.use("/applications", anyStaff, adminApplicationsRouter);
adminRouter.use("/interviews", anyStaff, interviewsRouter);
adminRouter.use("/calendar", anyStaff, calendarRouter);
adminRouter.use("/dashboard", anyStaff, dashboardRouter);
adminRouter.use("/employees", anyStaff, employeesRouter);
adminRouter.use("/overtime", anyStaff, overtimeRouter);
// Messages and bookings reports are refused to recruiters inside the router.
adminRouter.use("/reports", anyStaff, reportsRouter);
adminRouter.use("/contact-messages", adminOnly, adminContactRouter);
adminRouter.use("/bookings", adminOnly, adminBookingsRouter);
adminRouter.use("/booking-settings", adminOnly, adminBookingSettingsRouter);
adminRouter.use("/users", adminOnly, adminUsersRouter);
adminRouter.use("/audit-logs", adminOnly, auditRouter);
