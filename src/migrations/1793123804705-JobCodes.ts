import type { MigrationInterface, QueryRunner } from "typeorm";

export class JobCodes1793123804705 implements MigrationInterface {
    name = 'JobCodes1793123804705'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Numbers for generated job codes; a sequence never hands out the same value twice.
        await queryRunner.query(`CREATE SEQUENCE "job_code_seq"`);

        await queryRunner.query(`ALTER TABLE "job_applications" DROP CONSTRAINT "FK_99292c6cd0ed428e8f5b4e22958"`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "code" character varying(32)`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "archivedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "job_applications" ADD "jobCode" character varying(32)`);
        await queryRunner.query(`ALTER TABLE "job_applications" ADD "jobTitle" character varying(160)`);

        // Existing jobs get codes in creation order, e.g. IT-2026-001.
        await queryRunner.query(`
            UPDATE "jobs" j SET "code" = numbered.code
            FROM (
                SELECT id,
                    (CASE category WHEN 'it' THEN 'IT' WHEN 'digital' THEN 'DIG' ELSE 'GEN' END)
                    || '-' || to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY')
                    || '-' || lpad(nextval('job_code_seq')::text, 3, '0') AS code
                FROM (SELECT id, category, "createdAt" FROM "jobs" ORDER BY "createdAt", id) ordered
            ) numbered
            WHERE j.id = numbered.id`);
        await queryRunner.query(`
            UPDATE "job_applications" a SET
                "jobCode" = j."code",
                "jobTitle" = COALESCE(
                    (SELECT t.title FROM "job_translations" t WHERE t.job_id = j.id ORDER BY (t.locale = 'en') DESC LIMIT 1),
                    j.slug)
            FROM "jobs" j
            WHERE j.id = a.job_id`);

        await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "code" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "job_applications" ALTER COLUMN "jobCode" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "job_applications" ALTER COLUMN "jobTitle" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "job_applications" ALTER COLUMN "job_id" DROP NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b5b5a0e60fb45722d25babee95" ON "jobs"  ("code") `);
        await queryRunner.query(`CREATE INDEX "IDX_a5478a4d3f32d6acd84434a1e1" ON "job_applications"  ("jobCode") `);
        await queryRunner.query(`ALTER TABLE "job_applications" ADD CONSTRAINT "FK_99292c6cd0ed428e8f5b4e22958" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Fails while applications of deleted jobs exist, since they have no job to point back to.
        await queryRunner.query(`ALTER TABLE "job_applications" DROP CONSTRAINT "FK_99292c6cd0ed428e8f5b4e22958"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a5478a4d3f32d6acd84434a1e1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b5b5a0e60fb45722d25babee95"`);
        await queryRunner.query(`ALTER TABLE "job_applications" ALTER COLUMN "job_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "job_applications" DROP COLUMN "jobTitle"`);
        await queryRunner.query(`ALTER TABLE "job_applications" DROP COLUMN "jobCode"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "archivedAt"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "code"`);
        await queryRunner.query(`ALTER TABLE "job_applications" ADD CONSTRAINT "FK_99292c6cd0ed428e8f5b4e22958" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`DROP SEQUENCE "job_code_seq"`);
    }

}
