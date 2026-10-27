import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { InterviewStatus } from "../../entities/interview.entity.js";
import { PDF_MIME } from "../../lib/documents.js";
import { HttpError } from "../../lib/http-error.js";
import { schemas } from "../../lib/schemas.js";
import { getStorage } from "../../lib/storage.js";
import {
    getAttachment,
    listInterviews,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    previewInterviewEmail,
    scheduleInterview,
    updateInterview,
} from "./interviews.service.js";

const optionalText = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .nullish()
        .transform((value) => value || null);

const interviewFields = {
    title: z.string().trim().min(1, "Give the interview a name").max(120),
    startsAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    durationMinutes: z.number().int().min(15).max(480),
    // Optional: take-home tasks have no meeting.
    meetingUrl: z
        .union([z.literal(""), z.url({ protocol: /^https?$/, error: "Use a full https:// meeting link" }).trim().max(500)])
        .nullish()
        .transform((value) => value || null),
    notes: optionalText(2000),
};

const emailCustomization = z
    .object({ subject: optionalText(200), message: optionalText(5000) })
    .default({ subject: null, message: null });

const createBody = z.object({
    ...interviewFields,
    durationMinutes: interviewFields.durationMinutes.default(45),
    notifyCandidate: z.boolean().default(true),
    email: emailCustomization,
});

const updateBody = z
    .object({ ...interviewFields, status: z.enum(InterviewStatus) })
    .partial()
    .extend({
        notifyCandidate: z.boolean().default(true),
        email: emailCustomization,
        removeAttachments: z.array(z.string().max(500)).max(MAX_ATTACHMENTS).default([]),
    });

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS, fields: 5, fieldSize: 100_000 },
});

/** JSON requests send the body as usual; multipart ones send it as a "data" field next to the files. */
function readBody(req: Request): unknown {
    if (!req.is("multipart/form-data")) return req.body;
    try {
        return JSON.parse(String(req.body?.data ?? "{}"));
    } catch {
        throw HttpError.badRequest('Field "data" must be JSON');
    }
}

const uploadedFiles = (req: Request) => (Array.isArray(req.files) ? req.files : []);

const applicationParams = z.object({ id: schemas.uuid });
const idParams = z.object({ id: schemas.uuid });

/** Mounted at /admin/applications/:id/interviews. */
export const applicationInterviewsRouter = Router({ mergeParams: true });

applicationInterviewsRouter.get("/", async (req, res) => {
    const { id } = applicationParams.parse(req.params);
    res.json({ items: await listInterviews(id) });
});

applicationInterviewsRouter.post("/", upload.array("attachments", MAX_ATTACHMENTS), async (req, res) => {
    const { id } = applicationParams.parse(req.params);
    const { notifyCandidate, email, ...input } = createBody.parse(readBody(req));
    const interview = await scheduleInterview(id, input, {
        notify: notifyCandidate,
        email,
        adminUserId: req.admin!.id,
        files: uploadedFiles(req),
    });
    res.status(201).json(interview);
});

/** Mounted at /admin/interviews. */
export const interviewsRouter = Router();

const previewBody = z.object({
    applicationId: schemas.uuid,
    kind: z.enum(["scheduled", "updated", "cancelled"]).default("scheduled"),
    title: z.string().trim().max(120).default(""),
    startsAt: z.iso
        .datetime({ offset: true })
        .optional()
        .transform((value) => (value ? new Date(value) : new Date())),
    durationMinutes: z.number().int().min(1).max(480).default(45),
    meetingUrl: z.string().trim().max(500).nullish().transform((value) => value || null),
    attachmentNames: z.array(z.string().max(255)).max(MAX_ATTACHMENTS).default([]),
    subject: optionalText(200),
    message: optionalText(5000),
});

// Registered before "/:id" routes so "email-preview" isn't read as an id.
interviewsRouter.post("/email-preview", async (req, res) => {
    res.json(await previewInterviewEmail(previewBody.parse(req.body)));
});

interviewsRouter.patch("/:id", upload.array("attachments", MAX_ATTACHMENTS), async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { notifyCandidate, email, removeAttachments, ...update } = updateBody.parse(readBody(req));
    res.json(await updateInterview(id, update, { notify: notifyCandidate, email, files: uploadedFiles(req), removeAttachments }));
});

const attachmentParams = z.object({ id: schemas.uuid, index: z.coerce.number().int().min(0).max(MAX_ATTACHMENTS - 1) });
const attachmentQuery = z.object({ disposition: z.enum(["attachment", "inline"]).default("attachment") });

interviewsRouter.get("/:id/attachments/:index", async (req, res) => {
    const { id, index } = attachmentParams.parse(req.params);
    const attachment = await getAttachment(id, index);
    // Only PDFs can be shown by the browser; Word files are always downloaded.
    const { disposition: requested } = attachmentQuery.parse(req.query);
    const disposition = requested === "inline" && attachment.mimeType === PDF_MIME ? "inline" : "attachment";
    const url = await getStorage().signedDownloadUrl(attachment.key, attachment.fileName, {
        expiresInSeconds: 300,
        disposition,
        contentType: attachment.mimeType,
    });
    res.json({ url, disposition, mimeType: attachment.mimeType, fileName: attachment.fileName });
});
