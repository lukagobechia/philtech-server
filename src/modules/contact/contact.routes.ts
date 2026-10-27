import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../../config/database.js";
import { ContactMessage, ContactMessageStatus, ContactService } from "../../entities/contact-message.entity.js";
import { Locale } from "../../entities/enums.js";
import { hashIp } from "../../lib/crypto.js";
import { schemas } from "../../lib/schemas.js";
import { acceptSubmission } from "../../lib/submission.js";
import { submissionLimiter } from "../../middleware/rate-limit.js";
import { enqueueEmails, notificationPair } from "../email/outbox.js";
import { adminCrudRouter } from "../admin/crud.js";
import { recordAudit } from "../audit/audit.service.js";

const createContactBody = z.object({
    name: schemas.name,
    email: schemas.email,
    phone: schemas.phone.optional().or(z.literal("").transform(() => undefined)),
    company: schemas.optionalTrimmed(160),
    service: z.enum(ContactService).optional(),
    message: z.string().trim().min(1).max(5000),
    locale: schemas.locale,
    website: schemas.honeypot,
});

export const publicContactRouter = Router();

publicContactRouter.post("/", submissionLimiter(), async (req, res) => {
    if (!(await acceptSubmission(req, res, req.body ?? {}))) return;
    const { website: _honeypot, ...input } = createContactBody.parse(req.body);

    const message = await AppDataSource.transaction(async (manager) => {
        const saved = await manager.getRepository(ContactMessage).save({
            ...input,
            phone: input.phone ?? null,
            service: input.service ?? null,
            ipHash: hashIp(req.ip),
        });
        await enqueueEmails(manager, notificationPair("contact", saved.email, { ...input, id: saved.id }));
        await recordAudit(
            { action: "contact_message.submitted", entityType: "contact_message", entityId: saved.id, summary: `Contact message from ${saved.name}`, data: { service: saved.service, locale: saved.locale } },
            manager,
        );
        return saved;
    });

    res.status(201).json({ id: message.id });
});

export const adminContactRouter = adminCrudRouter({
    entity: ContactMessage,
    auditEntity: "contact_message",
    statusEnum: ContactMessageStatus,
    searchColumns: ["name", "email", "company", "message"],
    filters: { service: z.enum(ContactService), locale: z.enum(Locale) },
    groupBy: ["service", "locale"],
});
