import type { MigrationInterface, QueryRunner } from "typeorm";

export class AuditLogs1793128221663 implements MigrationInterface {
    name = 'AuditLogs1793128221663'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_category_enum" AS ENUM('request', 'event', 'job')`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_outcome_enum" AS ENUM('success', 'failure')`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_actortype_enum" AS ENUM('admin', 'public', 'system')`);
        await queryRunner.query(`CREATE TABLE "audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "category" "public"."audit_logs_category_enum" NOT NULL, "action" character varying(100) NOT NULL, "outcome" "public"."audit_logs_outcome_enum" NOT NULL DEFAULT 'success', "actorType" "public"."audit_logs_actortype_enum" NOT NULL, "actorId" uuid, "actorEmail" character varying(320), "actorRole" character varying(20), "entityType" character varying(50), "entityId" character varying(64), "summary" character varying(500), "data" jsonb NOT NULL DEFAULT '{}'::jsonb, "method" character varying(10), "route" character varying(300), "path" character varying(1000), "statusCode" integer, "durationMs" integer, "requestId" character varying(128), "ipHash" character varying(64), "userAgent" character varying(300), CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c69efb19bf127c97e6740ad530" ON "audit_logs"  ("createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_8a0324bcdc1e155445c66213af" ON "audit_logs"  ("category") `);
        await queryRunner.query(`CREATE INDEX "IDX_cee5459245f652b75eb2759b4c" ON "audit_logs"  ("action") `);
        await queryRunner.query(`CREATE INDEX "IDX_2dc33f7f3c22e2e7badafca1d1" ON "audit_logs"  ("actorId") `);
        await queryRunner.query(`CREATE INDEX "IDX_046285d4b8a799c3656b5ffa36" ON "audit_logs"  ("route") `);
        await queryRunner.query(`CREATE INDEX "IDX_a3efbfd507134492f264a19b9c" ON "audit_logs"  ("requestId") `);
        await queryRunner.query(`CREATE INDEX "IDX_13c69424c440a0e765053feb4b" ON "audit_logs"  ("entityType", "entityId") `);
        // Append-only: entries can't be edited, only purged by retention.
        await queryRunner.query(`
            CREATE FUNCTION audit_logs_block_update() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'audit_logs is append-only';
            END $$`);
        await queryRunner.query(`CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION audit_logs_block_update()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER audit_logs_no_update ON "audit_logs"`);
        await queryRunner.query(`DROP FUNCTION audit_logs_block_update()`);
        await queryRunner.query(`DROP INDEX "public"."IDX_13c69424c440a0e765053feb4b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a3efbfd507134492f264a19b9c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_046285d4b8a799c3656b5ffa36"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2dc33f7f3c22e2e7badafca1d1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cee5459245f652b75eb2759b4c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8a0324bcdc1e155445c66213af"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c69efb19bf127c97e6740ad530"`);
        await queryRunner.query(`DROP TABLE "audit_logs"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_actortype_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_outcome_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_category_enum"`);
    }

}
