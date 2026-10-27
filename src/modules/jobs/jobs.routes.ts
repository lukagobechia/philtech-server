import { Router } from "express";
import { z } from "zod";
import { schemas } from "../../lib/schemas.js";
import {
    adminJobsSummaryQuery,
    adminListJobsQuery,
    createJobBody,
    jobSlugParams,
    langQuery,
    listJobsQuery,
    updateJobBody,
} from "./jobs.schema.js";
import * as service from "./jobs.service.js";

export const publicJobsRouter = Router();

publicJobsRouter.get("/", async (req, res) => {
    res.json(await service.listPublicJobs(listJobsQuery.parse(req.query)));
});

publicJobsRouter.get("/filters", async (_req, res) => {
    res.set("Cache-Control", "public, max-age=60");
    res.json(await service.getPublicJobFilters());
});

publicJobsRouter.get("/:slug", async (req, res) => {
    const { slug } = jobSlugParams.parse(req.params);
    const { lang } = langQuery.parse(req.query);
    res.json(await service.getPublicJob(slug, lang));
});

const idParams = z.object({ id: schemas.uuid });

export const adminJobsRouter = Router();

adminJobsRouter.get("/", async (req, res) => {
    res.json(await service.listAdminJobs(adminListJobsQuery.parse(req.query)));
});

// Registered before "/:id" so "summary" and "codes" aren't read as ids.
adminJobsRouter.get("/summary", async (req, res) => {
    res.json(await service.summarizeAdminJobs(adminJobsSummaryQuery.parse(req.query)));
});

adminJobsRouter.get("/codes", async (_req, res) => {
    res.json(await service.listJobCodes());
});

adminJobsRouter.post("/archive-unpublished", async (_req, res) => {
    res.json(await service.archiveUnpublishedJobs());
});

adminJobsRouter.post("/", async (req, res) => {
    res.status(201).json(await service.createJob(createJobBody.parse(req.body)));
});

adminJobsRouter.get("/:id", async (req, res) => {
    res.json(await service.getAdminJob(idParams.parse(req.params).id));
});

adminJobsRouter.patch("/:id", async (req, res) => {
    res.json(await service.updateJob(idParams.parse(req.params).id, updateJobBody.parse(req.body)));
});

adminJobsRouter.post("/:id/publish", async (req, res) => {
    res.json(await service.setJobPublished(idParams.parse(req.params).id, true));
});

adminJobsRouter.post("/:id/unpublish", async (req, res) => {
    res.json(await service.setJobPublished(idParams.parse(req.params).id, false));
});

adminJobsRouter.post("/:id/archive", async (req, res) => {
    res.json(await service.setJobArchived(idParams.parse(req.params).id, true));
});

adminJobsRouter.post("/:id/unarchive", async (req, res) => {
    res.json(await service.setJobArchived(idParams.parse(req.params).id, false));
});

adminJobsRouter.delete("/:id", async (req, res) => {
    await service.deleteJob(idParams.parse(req.params).id);
    res.status(204).end();
});
