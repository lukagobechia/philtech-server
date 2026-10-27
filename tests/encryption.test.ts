import { describe, expect, it } from "vitest";
import { AppDataSource } from "../src/config/database.js";
import { ContactMessage } from "../src/entities/contact-message.entity.js";
import { Employee } from "../src/entities/employee.entity.js";
import { decrypt, encrypt } from "../src/lib/field-encryption.js";
import { EncryptPersonalData1793134241369 } from "../src/migrations/1793134241369-EncryptPersonalData.js";
import { processOutboxBatch } from "../src/modules/email/outbox.worker.js";
import { sentMails } from "./fakes.js";
import { api, loginAs } from "./helpers.js";

const contact = { name: "Nino Kapanadze", email: "nino@example.com", phone: "+995593512663", company: "Acme", service: "web", message: "Need a new website", locale: "en" };

describe("personal data encryption", () => {
    it("stores personal fields encrypted and shows them decrypted to signed-in admins only", async () => {
        const created = await api().post("/api/v1/contact-messages").send(contact).expect(201);
        expect(created.body).toEqual({ id: expect.any(String) });

        const [raw] = await AppDataSource.query(`SELECT name, email, phone, company, message, "searchIndex" FROM contact_messages`);
        const stored = JSON.stringify(raw);
        for (const value of ["Nino", "nino@example.com", "593512663", "Acme", "website"]) expect(stored).not.toContain(value);
        expect(raw.email).toMatch(/^enc:v1:/);

        const [outbox] = await AppDataSource.query(`SELECT "to", payload FROM email_outbox`);
        expect(JSON.stringify(outbox)).not.toContain("nino");

        await api().get("/api/v1/admin/contact-messages").expect(401);
        const agent = await loginAs();
        const list = await agent.get("/api/v1/admin/contact-messages").expect(200);
        expect(list.body.items[0]).toMatchObject({ name: "Nino Kapanadze", email: "nino@example.com", company: "Acme", message: "Need a new website" });
        expect(list.body.items[0]).not.toHaveProperty("searchIndex");

        // Queued emails still go out with the real address.
        await processOutboxBatch(AppDataSource);
        expect(sentMails.map((mail) => mail.to[0])).toContain("nino@example.com");
    });

    it("searches encrypted fields by word prefix", async () => {
        await api().post("/api/v1/contact-messages").send(contact).expect(201);
        await api().post("/api/v1/contact-messages").send({ ...contact, name: "Dato", email: "dato@test.ge", company: "Other", message: "Mobile app please" }).expect(201);
        const agent = await loginAs();
        const search = async (q: string) =>
            (await agent.get(`/api/v1/admin/contact-messages?q=${encodeURIComponent(q)}`).expect(200)).body.items.map((item: { name: string }) => item.name);

        expect(await search("kapan")).toEqual(["Nino Kapanadze"]);
        expect(await search("NINO@EXAMPLE.COM")).toEqual(["Nino Kapanadze"]);
        expect(await search("mobile")).toEqual(["Dato"]);
        expect(await search("nino dato")).toEqual([]);
        expect(await search("zzz")).toEqual([]);
    });

    it("keeps employee emails unique regardless of case and finds them by name", async () => {
        const agent = await loginAs();
        const employee = { firstName: "Giorgi", lastName: "Beridze", email: "giorgi@example.com", position: "Support engineer" };
        const created = await agent.post("/api/v1/admin/employees").send(employee).expect(201);
        await agent.post("/api/v1/admin/employees").send({ ...employee, email: "GIORGI@example.com" }).expect(409);

        await agent.patch(`/api/v1/admin/employees/${created.body.id}`).send({ lastName: "Tsereteli" }).expect(200);
        const found = await agent.get("/api/v1/admin/employees?q=tser").expect(200);
        expect(found.body.items.map((item: { lastName: string }) => item.lastName)).toEqual(["Tsereteli"]);
        expect((await agent.get("/api/v1/admin/employees?q=beridze").expect(200)).body.total).toBe(0);

        // Change history holds old and new values, so it is encrypted as well.
        const [event] = await AppDataSource.query(`SELECT data FROM employee_events WHERE type = 'updated'`);
        expect(event.data).not.toContain("Beridze");
        const events = await agent.get(`/api/v1/admin/employees/${created.body.id}/events`).expect(200);
        expect(events.body.items.find((item: { type: string }) => item.type === "updated").data.changes.lastName).toEqual({ from: "Beridze", to: "Tsereteli" });
    });

    it("rejects tampered ciphertext", () => {
        const value = encrypt("secret");
        expect(decrypt(value)).toBe("secret");
        const at = value.length - 10;
        const tampered = value.slice(0, at) + (value[at] === "A" ? "B" : "A") + value.slice(at + 1);
        expect(() => decrypt(tampered)).toThrow();
    });

    it("encrypts rows that existed before the migration, and can undo it", async () => {
        const runner = AppDataSource.createQueryRunner();
        const migration = new EncryptPersonalData1793134241369();
        try {
            await migration.down(runner);
            await runner.query(`INSERT INTO contact_messages (name, email, message) VALUES ('Old Timer', 'old@example.com', 'Legacy hello')`);
            await runner.query(`INSERT INTO employees ("firstName", "lastName", email, position, "startDate") VALUES ('Eka', 'Old', 'eka@example.com', 'QA', '2026-01-01')`);
            await migration.up(runner);
        } finally {
            await runner.release();
        }

        const [raw] = await AppDataSource.query(`SELECT name, email, message FROM contact_messages`);
        expect(JSON.stringify(raw)).not.toContain("Old Timer");
        expect(await AppDataSource.getRepository(ContactMessage).findOneByOrFail({})).toMatchObject({ name: "Old Timer", email: "old@example.com", message: "Legacy hello" });
        expect(await AppDataSource.getRepository(Employee).findOneByOrFail({})).toMatchObject({ firstName: "Eka", email: "eka@example.com" });

        const agent = await loginAs();
        expect((await agent.get("/api/v1/admin/contact-messages?q=legacy").expect(200)).body.total).toBe(1);
        await agent.post("/api/v1/admin/employees").send({ firstName: "X", lastName: "Y", email: "EKA@example.com", position: "QA" }).expect(409);
    });
});
