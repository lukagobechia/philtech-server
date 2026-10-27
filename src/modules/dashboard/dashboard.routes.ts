import { Router } from "express";
import { AdminRole } from "../../entities/admin-user.entity.js";
import { dateRangeQuery, getDashboard } from "./dashboard.service.js";

/** Mounted at /admin/dashboard. Recruiters see the hiring figures only. */
export const dashboardRouter = Router();

dashboardRouter.get("/", async (req, res) => {
    const range = dateRangeQuery.parse(req.query);
    res.json(await getDashboard(range, { includeInbox: req.admin!.role === AdminRole.ADMIN }));
});
