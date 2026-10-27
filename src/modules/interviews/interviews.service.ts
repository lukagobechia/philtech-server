import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { In } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { logger } from "../../config/logger.js";
import { Locale } from "../../entities/enums.js";
import { Interview, InterviewStatus, type InterviewAttachment } from "../../entities/interview.entity.js";
import { JobApplication, JobApplicationStatus } from "../../entities/job-application.entity.js";
import { Job } from "../../entities/job.entity.js";
import { detectDocument } from "../../lib/documents.js";
import { HttpError } from "../../lib/http-error.js";
import { getStorage } from "../../lib/storage.js";
import { recordAudit } from "../audit/audit.service.js";
import { getBookingSchedule } from "../bookings/settings.js";
import { enqueueEmails } from "../email/outbox.js";
import { interviewEmailDefaults, templates, type InterviewEmailKind } from "../email/templates.js";
import { pickTranslation } from "../jobs/jobs.service.js";

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type InterviewInput = {
    title: string;
    startsAt: Date;
    durationMinutes: number;
    meetingUrl: string | null;
    notes: string | null;
};

export type InterviewUpdate = Partial<InterviewInput> & { status?: InterviewStatus };

// Per-email overrides of the default subject and message.
export type EmailCustomization = { subject?: string | null; message?: string | null };

export type UploadedFile = { originalname: string; buffer: Buffer; size: number };

type NotifyOptions = { notify: boolean; email?: EmailCustomization };

// Scheduling an interview moves early-stage applications forward automatically.
const ADVANCE_TO_INTERVIEW = new Set([JobApplicationStatus.RECEIVED, JobApplicationStatus.REVIEWING]);

async function applicationOrThrow(manager: EntityManager, id: string): Promise<JobApplication> {
    const application = await manager.getRepository(JobApplication).findOneBy({ id });
    if (!application) throw HttpError.notFound("Application not found");
    return application;
}

/** Everything the interview email templates need, in the candidate's language. */
async function emailPayload(
    manager: EntityManager,
    application: JobApplication,
    interview: Pick<Interview, "title" | "startsAt" | "durationMinutes" | "meetingUrl"> & { attachments: Pick<InterviewAttachment, "key" | "fileName" | "mimeType">[] },
) {
    const job = application.jobId
        ? await manager.getRepository(Job).findOne({ where: { id: application.jobId }, relations: { translations: true } })
        : null;
    const { timezone } = await getBookingSchedule();
    return {
        title: interview.title,
        firstName: application.firstName,
        // The job may have been deleted since; the application keeps its title.
        jobTitle: job ? pickTranslation(job, application.locale).title : application.jobTitle,
        startsAt: interview.startsAt.toISOString(),
        durationMinutes: interview.durationMinutes,
        meetingUrl: interview.meetingUrl,
        attachments: interview.attachments,
        timezone,
        locale: application.locale,
    };
}

async function notifyCandidate(
    manager: EntityManager,
    kind: InterviewEmailKind,
    application: JobApplication,
    interview: Interview,
    email: EmailCustomization = {},
) {
    const payload = await emailPayload(manager, application, {
        ...interview,
        // Files go out with invitations and updates, not with a cancellation.
        attachments: kind === "cancelled" ? [] : interview.attachments,
    });
    await enqueueEmails(manager, [
        {
            to: [application.email],
            template: `interview_${kind}`,
            payload: { ...payload, customSubject: email.subject || null, customMessage: email.message || null },
        },
    ]);
}

/** Validates and uploads files; returns their metadata. Throws before uploading anything if a file is invalid. */
async function storeAttachments(applicationId: string, files: UploadedFile[]): Promise<InterviewAttachment[]> {
    const typed = [];
    for (const file of files) {
        const type = await detectDocument(file.buffer);
        if (!type) {
            throw HttpError.badRequest(`"${file.originalname}" must be a PDF, DOC or DOCX file`, { attachments: ["Unsupported file type"] });
        }
        typed.push({ file, type });
    }

    const stored: InterviewAttachment[] = [];
    for (const { file, type } of typed) {
        const key = `interview-attachments/${applicationId}/${randomUUID()}.${type.ext}`;
        await getStorage().put(key, file.buffer, type.mime);
        stored.push({ key, fileName: file.originalname.slice(0, 255), mimeType: type.mime, sizeBytes: file.size });
    }
    return stored;
}

async function deleteFiles(keys: string[]) {
    for (const key of keys) {
        await getStorage()
            .delete(key)
            .catch((error) => logger.error({ err: error, key }, "Failed to delete interview attachment"));
    }
}

export async function listInterviews(applicationId: string): Promise<Interview[]> {
    await applicationOrThrow(AppDataSource.manager, applicationId);
    return AppDataSource.getRepository(Interview).find({ where: { applicationId }, order: { startsAt: "DESC" } });
}

export async function scheduleInterview(
    applicationId: string,
    input: InterviewInput,
    options: NotifyOptions & { adminUserId: string; files: UploadedFile[] },
): Promise<Interview> {
    await applicationOrThrow(AppDataSource.manager, applicationId);
    if (options.files.length > MAX_ATTACHMENTS) throw HttpError.badRequest(`Attach at most ${MAX_ATTACHMENTS} files`);
    const attachments = await storeAttachments(applicationId, options.files);

    try {
        return await AppDataSource.transaction(async (manager) => {
            const application = await applicationOrThrow(manager, applicationId);
            const interview = await manager.getRepository(Interview).save({
                ...input,
                attachments,
                applicationId,
                createdById: options.adminUserId,
            });

            if (ADVANCE_TO_INTERVIEW.has(application.status)) {
                await manager.getRepository(JobApplication).update(applicationId, { status: JobApplicationStatus.INTERVIEW });
                await recordAudit(
                    {
                        action: "application.status_changed",
                        entityType: "application",
                        entityId: applicationId,
                        summary: `Status ${application.status} → interview (interview scheduled)`,
                        data: { from: application.status, to: JobApplicationStatus.INTERVIEW, automatic: true },
                    },
                    manager,
                );
            }
            await recordAudit(
                {
                    action: "interview.scheduled",
                    entityType: "interview",
                    entityId: interview.id,
                    summary: `Scheduled "${interview.title}" with ${application.firstName} ${application.lastName}`,
                    data: { applicationId, title: interview.title, startsAt: interview.startsAt, files: attachments.length, notified: options.notify },
                },
                manager,
            );
            if (options.notify) await notifyCandidate(manager, "scheduled", application, interview, options.email);
            return interview;
        });
    } catch (error) {
        await deleteFiles(attachments.map((file) => file.key));
        throw error;
    }
}

export async function updateInterview(
    id: string,
    update: InterviewUpdate,
    options: NotifyOptions & { files: UploadedFile[]; removeAttachments: string[] },
): Promise<Interview> {
    const existing = await AppDataSource.getRepository(Interview).findOneBy({ id });
    if (!existing) throw HttpError.notFound("Interview not found");

    const kept = existing.attachments.filter((file) => !options.removeAttachments.includes(file.key));
    const removed = existing.attachments.filter((file) => options.removeAttachments.includes(file.key));
    if (kept.length + options.files.length > MAX_ATTACHMENTS) throw HttpError.badRequest(`Attach at most ${MAX_ATTACHMENTS} files`);
    const added = await storeAttachments(existing.applicationId, options.files);

    try {
        const interview = await AppDataSource.transaction(async (manager) => {
            const repository = manager.getRepository(Interview);
            await repository.update(id, { ...update, attachments: [...kept, ...added] });
            const saved = (await repository.findOneBy({ id }))!;
            const changes = Object.fromEntries(
                Object.keys(update)
                    .filter((key) => String(existing[key as keyof Interview]) !== String(saved[key as keyof Interview]))
                    .map((key) => [key, { from: existing[key as keyof Interview], to: saved[key as keyof Interview] }]),
            );
            await recordAudit(
                {
                    action: saved.status !== existing.status ? "interview.status_changed" : "interview.updated",
                    entityType: "interview",
                    entityId: id,
                    summary: saved.status !== existing.status ? `Interview "${saved.title}" ${existing.status} → ${saved.status}` : `Updated interview "${saved.title}"`,
                    data: { applicationId: saved.applicationId, changes, filesAdded: added.length, filesRemoved: removed.length, notified: options.notify },
                },
                manager,
            );

            if (options.notify) {
                const application = await applicationOrThrow(manager, saved.applicationId);
                const cancelled = saved.status === InterviewStatus.CANCELLED && existing.status !== InterviewStatus.CANCELLED;
                const changed =
                    saved.status === InterviewStatus.SCHEDULED &&
                    (saved.startsAt.getTime() !== existing.startsAt.getTime() ||
                        saved.title !== existing.title ||
                        saved.meetingUrl !== existing.meetingUrl ||
                        saved.durationMinutes !== existing.durationMinutes ||
                        added.length > 0 ||
                        removed.length > 0 ||
                        existing.status !== InterviewStatus.SCHEDULED);

                if (cancelled) await notifyCandidate(manager, "cancelled", application, saved, options.email);
                else if (changed) await notifyCandidate(manager, "updated", application, saved, options.email);
            }
            return saved;
        });

        // Emails already queued with a removed file just go out without it.
        await deleteFiles(removed.map((file) => file.key));
        return interview;
    } catch (error) {
        await deleteFiles(added.map((file) => file.key));
        throw error;
    }
}

export async function getAttachment(id: string, index: number): Promise<InterviewAttachment> {
    const interview = await AppDataSource.getRepository(Interview).findOneBy({ id });
    const attachment = interview?.attachments[index];
    if (!attachment) throw HttpError.notFound("Attachment not found");
    await recordAudit({ action: "interview.attachment_accessed", entityType: "interview", entityId: id, summary: `Opened ${attachment.fileName}`, data: { fileName: attachment.fileName } });
    return attachment;
}

/** Removes stored files of all interviews of these applications; call before deleting the applications. */
export async function deleteInterviewFiles(applicationIds: string[]): Promise<void> {
    if (!applicationIds.length) return;
    const interviews = await AppDataSource.getRepository(Interview).find({
        where: { applicationId: In(applicationIds) },
        select: { id: true, attachments: true },
    });
    await deleteFiles(interviews.flatMap((interview) => interview.attachments.map((file) => file.key)));
}

export type EmailPreviewInput = {
    applicationId: string;
    kind: InterviewEmailKind;
    title: string;
    startsAt: Date;
    durationMinutes: number;
    meetingUrl: string | null;
    attachmentNames: string[];
} & EmailCustomization;

/** Renders the exact email the candidate would get, plus the default text for the editor. */
export async function previewInterviewEmail(input: EmailPreviewInput) {
    const application = await applicationOrThrow(AppDataSource.manager, input.applicationId);
    const payload = await emailPayload(AppDataSource.manager, application, {
        ...input,
        attachments: input.kind === "cancelled" ? [] : input.attachmentNames.map((fileName) => ({ key: "", fileName, mimeType: "" })),
    });
    const rendered = templates[`interview_${input.kind}`]!({ ...payload, customSubject: input.subject, customMessage: input.message });
    const defaults = interviewEmailDefaults(input.kind, payload);
    return {
        to: application.email,
        locale: application.locale,
        subject: rendered.subject,
        html: rendered.html,
        defaultSubject: defaults.subject,
        defaultMessage: defaults.message,
    };
}

/** Interviews in a time range with candidate and job details, for the calendar. */
export async function interviewsInRange(from: Date, to: Date) {
    const interviews = await AppDataSource.getRepository(Interview)
        .createQueryBuilder("interview")
        .innerJoinAndSelect("interview.application", "application")
        .where("interview.startsAt >= :from AND interview.startsAt < :to", { from, to })
        .orderBy("interview.startsAt", "ASC")
        .take(1000)
        .getMany();

    const jobIds = [...new Set(interviews.flatMap((interview) => interview.application.jobId ?? []))];
    const jobs = jobIds.length
        ? await AppDataSource.getRepository(Job).find({ where: { id: In(jobIds) }, relations: { translations: true } })
        : [];
    const jobTitles = new Map(jobs.map((job) => [job.id, pickTranslation(job, Locale.EN).title]));

    return interviews.map(({ application, ...interview }) => ({
        ...interview,
        candidate: {
            applicationId: application.id,
            name: `${application.firstName} ${application.lastName}`,
            email: application.email,
            phone: application.phone,
            jobTitle: (application.jobId && jobTitles.get(application.jobId)) || application.jobTitle,
            jobCode: application.jobCode,
        },
    }));
}
