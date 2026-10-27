import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { AppDataSource } from "../../config/database.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { Locale } from "../../entities/enums.js";
import { JobApplication, JobApplicationStatus } from "../../entities/job-application.entity.js";
import { hashIp } from "../../lib/crypto.js";
import { detectDocument, PDF_MIME } from "../../lib/documents.js";
import { HttpError } from "../../lib/http-error.js";
import { schemas } from "../../lib/schemas.js";
import { getStorage } from "../../lib/storage.js";
import { acceptSubmission } from "../../lib/submission.js";
import { submissionLimiter } from "../../middleware/rate-limit.js";
import { adminCrudRouter } from "../admin/crud.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueEmails, notificationPair } from "../email/outbox.js";
import { hireFromApplication } from "../employees/employees.service.js";
import { deleteInterviewFiles } from "../interviews/interviews.service.js";
import { jobCode } from "../jobs/jobs.schema.js";
import { findPublishedJobBySlug, isJobOpen, pickTranslation } from "../jobs/jobs.service.js";

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_RESUME_BYTES, files: 1, fields: 30, fieldSize: 10_000 },
});

const createApplicationBody = z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    city: z.string().trim().min(1).max(160),
    country: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, "Use an ISO 3166-1 alpha-2 country code"),
    currentEmployer: schemas.optionalTrimmed(160),
    currentPosition: schemas.optionalTrimmed(160),
    email: schemas.email,
    phone: schemas.phone,
    consent: z.literal("true", { error: "Consent to data processing is required" }),
    locale: schemas.locale,
    website: schemas.honeypot,
});

const slugParams = z.object({ slug: z.string().trim().min(1).max(120) });

export const publicApplicationsRouter = Router({ mergeParams: true });

publicApplicationsRouter.post("/", submissionLimiter(), upload.single("resume"), async (req, res) => {
    if (!(await acceptSubmission(req, res, req.body ?? {}))) return;

    const { slug } = slugParams.parse(req.params);
    const { website: _honeypot, consent: _consent, ...input } = createApplicationBody.parse(req.body);

    const job = await findPublishedJobBySlug(slug);
    if (!isJobOpen(job)) {
        throw HttpError.conflict("JOB_CLOSED", "This vacancy is no longer accepting applications");
    }

    if (!req.file) throw HttpError.badRequest("Resume file is required", { resume: ["Required"] });
    const type = await detectDocument(req.file.buffer);
    if (!type) {
        throw HttpError.badRequest("Resume must be a PDF, DOC or DOCX file", { resume: ["Unsupported file type"] });
    }

    const resumeKey = `resumes/${job.id}/${randomUUID()}.${type.ext}`;
    await getStorage().put(resumeKey, req.file.buffer, type.mime);

    try {
        const application = await AppDataSource.transaction(async (manager) => {
            const saved = await manager.getRepository(JobApplication).save({
                ...input,
                jobId: job.id,
                jobCode: job.code,
                jobTitle: pickTranslation(job, Locale.EN).title,
                resumeKey,
                resumeFileName: req.file!.originalname.slice(0, 255),
                resumeMimeType: type.mime,
                resumeSizeBytes: req.file!.size,
                consentAt: new Date(),
                privacyPolicyVersion: env.PRIVACY_POLICY_VERSION,
                ipHash: hashIp(req.ip),
            });
            await enqueueEmails(
                manager,
                notificationPair("application", saved.email, {
                    ...input,
                    applicationId: saved.id,
                    jobCode: job.code,
                    jobTitle: pickTranslation(job, input.locale).title,
                }),
            );
            await recordAudit(
                {
                    action: "application.submitted",
                    entityType: "application",
                    entityId: saved.id,
                    summary: `Application for ${job.code} from ${saved.firstName} ${saved.lastName}`,
                    data: { jobCode: job.code, locale: saved.locale, resumeType: type.mime },
                },
                manager,
            );
            return saved;
        });
        res.status(201).json({ id: application.id });
    } catch (error) {
        // Don't leave orphaned CVs behind when the database write fails.
        await getStorage()
            .delete(resumeKey)
            .catch((cleanupError) => logger.error({ err: cleanupError, resumeKey }, "Failed to delete orphaned resume"));
        throw error;
    }
});

const serializeApplication = ({ resumeKey: _key, ipHash: _ip, ...application }: JobApplication) => application;

export const adminApplicationsRouter = adminCrudRouter({
    entity: JobApplication,
    auditEntity: "application",
    statusEnum: JobApplicationStatus,
    searchColumns: ["firstName", "lastName", "email", "jobCode", "jobTitle"],
    filters: {
        jobId: schemas.uuid,
        jobCode,
        country: z.string().trim().toUpperCase().length(2),
        locale: z.enum(Locale),
    },
    groupBy: ["jobCode", "country", "locale"],
    sorts: { newest: ["createdAt", "DESC"], oldest: ["createdAt", "ASC"], name: ["lastName", "ASC"] },
    // Hiring adds the candidate to the employees list in the same transaction.
    onStatusChange: async (manager, application, previousStatus, actorId) => {
        if (application.status === JobApplicationStatus.HIRED && previousStatus !== JobApplicationStatus.HIRED) {
            await hireFromApplication(manager, application, actorId);
        }
    },
    serialize: serializeApplication,
});

const idParams = z.object({ id: schemas.uuid });

const resumeQuery = z.object({ disposition: z.enum(["attachment", "inline"]).default("attachment") });

adminApplicationsRouter.get("/:id/resume", async (req, res) => {
    const application = await AppDataSource.getRepository(JobApplication).findOneBy({ id: idParams.parse(req.params).id });
    if (!application) throw HttpError.notFound();

    // Only PDFs can be shown by the browser; Word files are always downloaded.
    const { disposition: requested } = resumeQuery.parse(req.query);
    const disposition = requested === "inline" && application.resumeMimeType === PDF_MIME ? "inline" : "attachment";

    const url = await getStorage().signedDownloadUrl(application.resumeKey, application.resumeFileName, {
        expiresInSeconds: 300,
        disposition,
        contentType: application.resumeMimeType,
    });
    // Opening a CV is access to personal data, so it is recorded like a change.
    await recordAudit({
        action: disposition === "inline" ? "application.resume_viewed" : "application.resume_downloaded",
        entityType: "application",
        entityId: application.id,
        summary: `${disposition === "inline" ? "Viewed" : "Downloaded"} CV of ${application.firstName} ${application.lastName}`,
        data: { fileName: application.resumeFileName },
    });
    res.json({ url, disposition, mimeType: application.resumeMimeType, expiresInSeconds: 300 });
});

adminApplicationsRouter.delete("/:id", async (req, res) => {
    const repository = AppDataSource.getRepository(JobApplication);
    const application = await repository.findOneBy({ id: idParams.parse(req.params).id });
    if (!application) throw HttpError.notFound();
    await deleteInterviewFiles([application.id]);
    await getStorage().delete(application.resumeKey);
    await repository.delete(application.id);
    await recordAudit({
        action: "application.deleted",
        entityType: "application",
        entityId: application.id,
        summary: `Deleted application of ${application.firstName} ${application.lastName} (${application.jobCode})`,
        data: { jobCode: application.jobCode, email: application.email, status: application.status },
    });
    res.status(204).end();
});
