import type { MigrationInterface, QueryRunner } from "typeorm";
import { decrypt, encrypt, isEncrypted, lookupHash, searchIndexTerms } from "../lib/field-encryption.js";

// Encrypted text columns with their previous type (for down).
const TEXT_COLUMNS: Record<string, Record<string, string>> = {
    job_applications: {
        firstName: "character varying(100)",
        lastName: "character varying(100)",
        city: "character varying(160)",
        currentEmployer: "character varying(160)",
        currentPosition: "character varying(160)",
        email: "character varying(320)",
        phone: "character varying(32)",
        resumeFileName: "character varying(255)",
    },
    contact_messages: {
        name: "character varying(160)",
        email: "character varying(320)",
        phone: "character varying(32)",
        company: "character varying(160)",
        message: "text",
    },
    call_bookings: { name: "character varying(160)", email: "character varying(320)", phone: "character varying(32)", notes: "text" },
    employees: { firstName: "character varying(100)", lastName: "character varying(100)", email: "character varying(320)", phone: "character varying(32)", notes: "text" },
    interviews: { notes: "text" },
};

// jsonb columns that become encrypted JSON text.
const JSON_COLUMNS: Record<string, string[]> = { email_outbox: ["to", "payload"], employee_events: ["data"] };

// Search index sources, as in SearchIndexSubscriber at the time of this migration.
const SEARCH: Record<string, { prefixed: string[]; whole: string[] }> = {
    job_applications: { prefixed: ["firstName", "lastName", "email"], whole: [] },
    contact_messages: { prefixed: ["name", "email", "company"], whole: ["message"] },
    call_bookings: { prefixed: ["name", "email"], whole: ["notes"] },
    employees: { prefixed: ["firstName", "lastName", "email"], whole: [] },
};

// Plain indexes on email are useless once it is encrypted.
const EMAIL_INDEXES: [table: string, name: string, unique: boolean][] = [
    ["job_applications", "IDX_40039e7ae104e9f722a4064331", false],
    ["contact_messages", "IDX_feb8b274c477df984576e1baf1", false],
    ["call_bookings", "IDX_d570a554b1767c22095e6b41d5", false],
    ["employees", "IDX_765bc1ac8967533a04c74a9f6a", true],
];

type Row = Record<string, string | null>;

/** Rewrites the given columns of every row of a table through `transform`. */
async function rewrite(queryRunner: QueryRunner, table: string, columns: string[], transform: (row: Row) => Row) {
    const rows: Row[] = await queryRunner.query(`SELECT id, ${columns.map((column) => `"${column}"`).join(", ")} FROM "${table}"`);
    for (const row of rows) {
        const values = transform(row);
        const keys = Object.keys(values);
        await queryRunner.query(
            `UPDATE "${table}" SET ${keys.map((key, index) => `"${key}" = $${index + 2}`).join(", ")} WHERE id = $1`,
            [row.id, ...keys.map((key) => values[key])],
        );
    }
}

const mapColumns = (row: Row, columns: string[], fn: (value: string) => string): Row =>
    Object.fromEntries(columns.map((column) => [column, row[column] === null ? null : fn(row[column]!)]));

export class EncryptPersonalData1793134241369 implements MigrationInterface {
    name = "EncryptPersonalData1793134241369";

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [, name] of EMAIL_INDEXES) await queryRunner.query(`DROP INDEX "public"."${name}"`);
        for (const [table, columns] of Object.entries(TEXT_COLUMNS)) {
            for (const column of Object.keys(columns)) await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE text`);
        }
        await queryRunner.query(`ALTER TABLE "employee_events" ALTER COLUMN "data" DROP DEFAULT`);
        for (const [table, columns] of Object.entries(JSON_COLUMNS)) {
            for (const column of columns) await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE text USING "${column}"::text`);
        }
        for (const table of Object.keys(SEARCH)) await queryRunner.query(`ALTER TABLE "${table}" ADD "searchIndex" text array NOT NULL DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "employees" ADD "emailHash" character varying(32)`);

        const encryptValue = (value: string) => (isEncrypted(value) ? value : encrypt(value));
        for (const [table, columns] of Object.entries(TEXT_COLUMNS)) {
            const search = SEARCH[table];
            await rewrite(queryRunner, table, Object.keys(columns), (row) => ({
                ...mapColumns(row, Object.keys(columns), encryptValue),
                ...(search && {
                    searchIndex: searchIndexTerms(search.prefixed.map((column) => row[column]), search.whole.map((column) => row[column])) as never,
                }),
                ...(table === "employees" && { emailHash: lookupHash(row.email!) }),
            }));
        }
        for (const [table, columns] of Object.entries(JSON_COLUMNS)) {
            await rewrite(queryRunner, table, columns, (row) => mapColumns(row, columns, encryptValue));
        }

        await queryRunner.query(`ALTER TABLE "employees" ALTER COLUMN "emailHash" SET NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_employees_email_hash" ON "employees" ("emailHash")`);
        for (const table of Object.keys(SEARCH)) {
            await queryRunner.query(`CREATE INDEX "IDX_${table}_search_index" ON "${table}" USING GIN ("searchIndex")`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of Object.keys(SEARCH)) await queryRunner.query(`DROP INDEX "public"."IDX_${table}_search_index"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_employees_email_hash"`);
        await queryRunner.query(`ALTER TABLE "employees" DROP COLUMN "emailHash"`);
        for (const table of Object.keys(SEARCH)) await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "searchIndex"`);

        const encryptedColumns = [...Object.entries(TEXT_COLUMNS).map(([table, columns]) => [table, Object.keys(columns)] as const), ...Object.entries(JSON_COLUMNS)];
        for (const [table, columns] of encryptedColumns) {
            await rewrite(queryRunner, table, columns, (row) => mapColumns(row, columns, decrypt));
        }

        for (const [table, columns] of Object.entries(JSON_COLUMNS)) {
            for (const column of columns) await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE jsonb USING "${column}"::jsonb`);
        }
        await queryRunner.query(`ALTER TABLE "employee_events" ALTER COLUMN "data" SET DEFAULT '{}'::jsonb`);
        for (const [table, columns] of Object.entries(TEXT_COLUMNS)) {
            for (const [column, type] of Object.entries(columns)) {
                if (type !== "text") await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE ${type}`);
            }
        }
        for (const [table, name, unique] of EMAIL_INDEXES) {
            await queryRunner.query(`CREATE ${unique ? "UNIQUE " : ""}INDEX "${name}" ON "${table}" ("email")`);
        }
    }
}
