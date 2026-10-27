// Usage: npm run admin:create -- <email> "<display name>" [admin|recruiter]
// The password is read from ADMIN_PASSWORD or prompted for, so it never lands in shell history.
import { createInterface } from "node:readline/promises";
import { AppDataSource } from "../config/database.js";
import { AdminRole, AdminUser } from "../entities/admin-user.entity.js";
import { hashPassword } from "../lib/password.js";
import { schemas } from "../lib/schemas.js";
import { passwordSchema } from "../modules/admin/users.routes.js";

const [emailArg, displayName, roleArg = AdminRole.ADMIN] = process.argv.slice(2);
if (!emailArg || !displayName || !Object.values(AdminRole).includes(roleArg as AdminRole)) {
    console.error('Usage: npm run admin:create -- <email> "<display name>" [admin|recruiter]');
    process.exit(1);
}

let password = process.env.ADMIN_PASSWORD;
if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question("Password (min 12 chars): ");
    rl.close();
}

const email = schemas.email.parse(emailArg);
passwordSchema.parse(password);

await AppDataSource.initialize();
try {
    const repository = AppDataSource.getRepository(AdminUser);
    const existing = await repository.findOneBy({ email });
    const fields = { displayName, role: roleArg as AdminRole, passwordHash: await hashPassword(password), isActive: true };
    if (existing) {
        await repository.update(existing.id, fields);
        console.log(`Updated admin ${email}`);
    } else {
        await repository.insert({ email, ...fields });
        console.log(`Created admin ${email}`);
    }
} finally {
    await AppDataSource.destroy();
}
