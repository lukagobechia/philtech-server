import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../../config/database.js";
import { AdminRole, AdminUser } from "../../entities/admin-user.entity.js";
import { HttpError } from "../../lib/http-error.js";
import { likePattern, searchQuery } from "../../lib/listing.js";
import { paginated, paginationQuery, toSkipTake } from "../../lib/pagination.js";
import { hashPassword } from "../../lib/password.js";
import { schemas } from "../../lib/schemas.js";
import { deleteUserSessions } from "../auth/sessions.js";
import { toAdminView } from "../auth/auth.routes.js";
import { recordAudit } from "../audit/audit.service.js";

export const passwordSchema = z.string().min(12, "Password must be at least 12 characters").max(256);

const createUserBody = z.object({
    email: schemas.email,
    displayName: z.string().trim().min(1).max(160),
    password: passwordSchema,
    role: z.enum(AdminRole).default(AdminRole.RECRUITER),
});

const updateUserBody = z
    .object({
        displayName: z.string().trim().min(1).max(160),
        role: z.enum(AdminRole),
        isActive: z.boolean(),
        password: passwordSchema,
    })
    .partial();

const idParams = z.object({ id: schemas.uuid });
const users = () => AppDataSource.getRepository(AdminUser);

export const adminUsersRouter = Router();

const listUsersQuery = paginationQuery.extend({
    q: searchQuery,
    role: z.enum(AdminRole).optional(),
    isActive: z
        .enum(["true", "false"])
        .transform((value) => value === "true")
        .optional(),
});

adminUsersRouter.get("/", async (req, res) => {
    const query = listUsersQuery.parse(req.query);
    const qb = users().createQueryBuilder("user").orderBy("user.createdAt", "ASC");
    if (query.q) qb.andWhere("(user.email ILIKE :like OR user.displayName ILIKE :like)", { like: likePattern(query.q) });
    if (query.role) qb.andWhere("user.role = :role", { role: query.role });
    if (query.isActive !== undefined) qb.andWhere("user.isActive = :isActive", { isActive: query.isActive });

    const { skip, take } = toSkipTake(query);
    const [items, total] = await qb.skip(skip).take(take).getManyAndCount();
    res.json(paginated(items.map(toAdminView), total, query));
});

adminUsersRouter.post("/", async (req, res) => {
    const { password, ...input } = createUserBody.parse(req.body);
    if (await users().existsBy({ email: input.email })) {
        throw HttpError.conflict("EMAIL_TAKEN", "An admin with this email already exists");
    }
    const user = await users().save({ ...input, passwordHash: await hashPassword(password) });
    await recordAudit({ action: "admin_user.created", entityType: "admin_user", entityId: user.id, summary: `Added ${user.email} as ${user.role}`, data: { email: user.email, role: user.role } });
    res.status(201).json(toAdminView(user));
});

adminUsersRouter.patch("/:id", async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { password, ...input } = updateUserBody.parse(req.body);

    if (id === req.admin!.id && (input.isActive === false || (input.role && input.role !== AdminRole.ADMIN))) {
        throw HttpError.badRequest("You cannot deactivate or demote yourself");
    }

    const before = await users().findOneBy({ id });
    const result = await users().update(id, {
        ...input,
        ...(password ? { passwordHash: await hashPassword(password) } : {}),
    });
    if (!result.affected) throw HttpError.notFound();

    // Changing credentials or access revokes existing sessions.
    if (password || input.isActive === false || input.role) await deleteUserSessions(id);

    const after = (await users().findOneBy({ id }))!;
    const changes = Object.fromEntries(
        (Object.keys(input) as (keyof typeof input)[])
            .filter((key) => before?.[key] !== after[key])
            .map((key) => [key, { from: before?.[key], to: after[key] }]),
    );
    await recordAudit({
        action: "admin_user.updated",
        entityType: "admin_user",
        entityId: id,
        summary: `Updated ${after.email}`,
        data: { changes, passwordChanged: Boolean(password) },
    });
    res.json(toAdminView(after));
});
