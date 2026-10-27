import type { MigrationInterface, QueryRunner } from "typeorm";

export class Employees1793127235449 implements MigrationInterface {
    name = 'Employees1793127235449'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."employees_status_enum" AS ENUM('active', 'inactive')`);
        await queryRunner.query(`CREATE TABLE "employees" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "firstName" character varying(100) NOT NULL, "lastName" character varying(100) NOT NULL, "email" character varying(320) NOT NULL, "phone" character varying(32), "position" character varying(160) NOT NULL, "department" character varying(120), "startDate" date NOT NULL, "status" "public"."employees_status_enum" NOT NULL DEFAULT 'active', "schedule" jsonb NOT NULL DEFAULT '[]'::jsonb, "notes" text, "application_id" uuid, "jobCode" character varying(32), CONSTRAINT "REL_fc28280c26aca06a4a705358cb" UNIQUE ("application_id"), CONSTRAINT "PK_b9535a98350d5b26e7eb0c26af4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_765bc1ac8967533a04c74a9f6a" ON "employees"  ("email") `);
        await queryRunner.query(`CREATE INDEX "IDX_faa35befc241081a6b05010396" ON "employees"  ("status") `);
        await queryRunner.query(`CREATE TYPE "public"."employee_events_type_enum" AS ENUM('hired', 'created', 'updated', 'schedule_updated', 'deactivated', 'reactivated', 'overtime_started', 'overtime_ended', 'overtime_updated', 'overtime_cancelled')`);
        await queryRunner.query(`CREATE TABLE "employee_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "employee_id" uuid NOT NULL, "type" "public"."employee_events_type_enum" NOT NULL, "data" jsonb NOT NULL DEFAULT '{}'::jsonb, "actor_id" uuid, CONSTRAINT "PK_24a8884f457ff1ec6697785f876" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_01a1324cb133af3127530163ec" ON "employee_events"  ("employee_id", "createdAt") `);
        await queryRunner.query(`CREATE TYPE "public"."overtime_entries_status_enum" AS ENUM('active', 'completed', 'cancelled')`);
        await queryRunner.query(`CREATE TABLE "overtime_entries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "employee_id" uuid NOT NULL, "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endedAt" TIMESTAMP WITH TIME ZONE, "plannedEndAt" TIMESTAMP WITH TIME ZONE, "reason" character varying(500) NOT NULL, "status" "public"."overtime_entries_status_enum" NOT NULL DEFAULT 'active', "started_by_id" uuid, "ended_by_id" uuid, CONSTRAINT "PK_0f74fe7c1bb2abee4a746940fb6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d2b328a784a1214f3e7eccb75c" ON "overtime_entries"  ("employee_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_92c87999f7f70ceb6280ec2385" ON "overtime_entries"  ("startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_bd7217627b5ba575714085ed82" ON "overtime_entries"  ("status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_overtime_one_active_per_employee" ON "overtime_entries"  ("employee_id") WHERE status = 'active'`);
        await queryRunner.query(`ALTER TABLE "employees" ADD CONSTRAINT "FK_fc28280c26aca06a4a705358cb8" FOREIGN KEY ("application_id") REFERENCES "job_applications"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "employee_events" ADD CONSTRAINT "FK_048016cf1f71093ac8a80a4db79" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "employee_events" ADD CONSTRAINT "FK_01e6fe9abf55b8a181a1decc09e" FOREIGN KEY ("actor_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "overtime_entries" ADD CONSTRAINT "FK_d2b328a784a1214f3e7eccb75c4" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "overtime_entries" ADD CONSTRAINT "FK_57f93b4375b690fd8c1e3e31a2b" FOREIGN KEY ("started_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "overtime_entries" ADD CONSTRAINT "FK_b232e4fcd06f2554c5514ab06c1" FOREIGN KEY ("ended_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "overtime_entries" DROP CONSTRAINT "FK_b232e4fcd06f2554c5514ab06c1"`);
        await queryRunner.query(`ALTER TABLE "overtime_entries" DROP CONSTRAINT "FK_57f93b4375b690fd8c1e3e31a2b"`);
        await queryRunner.query(`ALTER TABLE "overtime_entries" DROP CONSTRAINT "FK_d2b328a784a1214f3e7eccb75c4"`);
        await queryRunner.query(`ALTER TABLE "employee_events" DROP CONSTRAINT "FK_01e6fe9abf55b8a181a1decc09e"`);
        await queryRunner.query(`ALTER TABLE "employee_events" DROP CONSTRAINT "FK_048016cf1f71093ac8a80a4db79"`);
        await queryRunner.query(`ALTER TABLE "employees" DROP CONSTRAINT "FK_fc28280c26aca06a4a705358cb8"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_overtime_one_active_per_employee"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bd7217627b5ba575714085ed82"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_92c87999f7f70ceb6280ec2385"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d2b328a784a1214f3e7eccb75c"`);
        await queryRunner.query(`DROP TABLE "overtime_entries"`);
        await queryRunner.query(`DROP TYPE "public"."overtime_entries_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_01a1324cb133af3127530163ec"`);
        await queryRunner.query(`DROP TABLE "employee_events"`);
        await queryRunner.query(`DROP TYPE "public"."employee_events_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_faa35befc241081a6b05010396"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_765bc1ac8967533a04c74a9f6a"`);
        await queryRunner.query(`DROP TABLE "employees"`);
        await queryRunner.query(`DROP TYPE "public"."employees_status_enum"`);
    }

}
