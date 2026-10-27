import { Router } from "express";
import { z } from "zod";
import { EmployeeStatus } from "../../entities/employee.entity.js";
import { OvertimeStatus } from "../../entities/overtime-entry.entity.js";
import { dateRangeQuery, enumList, searchQuery } from "../../lib/listing.js";
import { paginationQuery } from "../../lib/pagination.js";
import { schemas } from "../../lib/schemas.js";
import * as service from "./employees.service.js";

const idParams = z.object({ id: schemas.uuid });

const listQuery = paginationQuery.extend({
    q: searchQuery,
    status: z.enum(EmployeeStatus).optional(),
    department: z.string().trim().max(120).optional(),
    applicationId: schemas.uuid.optional(),
    sort: z.enum(["name", "newest", "startDate"]).default("name"),
});

/** Mounted at /admin/employees. */
export const employeesRouter = Router();

employeesRouter.get("/", async (req, res) => {
    res.json(await service.listEmployees(listQuery.parse(req.query)));
});

// Registered before "/:id" so "board" isn't read as an id.
employeesRouter.get("/board", async (_req, res) => {
    res.json(await service.employeeBoard());
});

employeesRouter.post("/", async (req, res) => {
    res.status(201).json(await service.createEmployee(service.createEmployeeBody.parse(req.body), req.admin!.id));
});

employeesRouter.get("/:id", async (req, res) => {
    res.json(await service.getEmployee(idParams.parse(req.params).id));
});

employeesRouter.patch("/:id", async (req, res) => {
    res.json(await service.updateEmployee(idParams.parse(req.params).id, service.updateEmployeeBody.parse(req.body), req.admin!.id));
});

employeesRouter.get("/:id/events", async (req, res) => {
    res.json(await service.listEmployeeEvents(idParams.parse(req.params).id, paginationQuery.parse(req.query)));
});

employeesRouter.post("/:id/overtime", async (req, res) => {
    res.status(201).json(await service.startOvertime(idParams.parse(req.params).id, service.startOvertimeBody.parse(req.body), req.admin!.id));
});

const overtimeListQuery = paginationQuery.extend({
    employeeId: schemas.uuid.optional(),
    status: enumList(OvertimeStatus).optional(),
    ...dateRangeQuery,
});

/** Mounted at /admin/overtime: the overtime log across employees. */
export const overtimeRouter = Router();

overtimeRouter.get("/", async (req, res) => {
    res.json(await service.listOvertime(overtimeListQuery.parse(req.query)));
});

overtimeRouter.post("/:id/end", async (req, res) => {
    res.json(await service.endOvertime(idParams.parse(req.params).id, service.endOvertimeBody.parse(req.body ?? {}), req.admin!.id));
});

overtimeRouter.patch("/:id", async (req, res) => {
    res.json(await service.updateOvertime(idParams.parse(req.params).id, service.updateOvertimeBody.parse(req.body), req.admin!.id));
});

overtimeRouter.post("/:id/cancel", async (req, res) => {
    res.json(await service.cancelOvertime(idParams.parse(req.params).id, req.admin!.id));
});
