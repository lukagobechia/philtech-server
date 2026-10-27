import type { MigrationInterface, QueryRunner } from "typeorm";

export class Interviews1793122329533 implements MigrationInterface {
    name = 'Interviews1793122329533'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."interviews_status_enum" AS ENUM('scheduled', 'completed', 'cancelled', 'no_show')`);
        await queryRunner.query(`CREATE TABLE "interviews" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "application_id" uuid NOT NULL, "startsAt" TIMESTAMP WITH TIME ZONE NOT NULL, "durationMinutes" integer NOT NULL, "meetingUrl" character varying(500) NOT NULL, "notes" text, "status" "public"."interviews_status_enum" NOT NULL DEFAULT 'scheduled', "created_by_id" uuid, CONSTRAINT "PK_fd41af1f96d698fa33c2f070f47" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_77f7078daea9f2b36e9ff761bd" ON "interviews"  ("application_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_b15d2cbb2808004bbc98bed835" ON "interviews"  ("startsAt") `);
        await queryRunner.query(`ALTER TABLE "interviews" ADD CONSTRAINT "FK_77f7078daea9f2b36e9ff761bd1" FOREIGN KEY ("application_id") REFERENCES "job_applications"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "interviews" ADD CONSTRAINT "FK_6e55570fd5f35141174ef9587c6" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interviews" DROP CONSTRAINT "FK_6e55570fd5f35141174ef9587c6"`);
        await queryRunner.query(`ALTER TABLE "interviews" DROP CONSTRAINT "FK_77f7078daea9f2b36e9ff761bd1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b15d2cbb2808004bbc98bed835"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_77f7078daea9f2b36e9ff761bd"`);
        await queryRunner.query(`DROP TABLE "interviews"`);
        await queryRunner.query(`DROP TYPE "public"."interviews_status_enum"`);
    }

}
