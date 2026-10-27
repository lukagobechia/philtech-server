import type { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1793117761761 implements MigrationInterface {
    name = 'InitialSchema1793117761761'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."admin_users_role_enum" AS ENUM('admin', 'recruiter')`);
        await queryRunner.query(`CREATE TABLE "admin_users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "email" character varying(320) NOT NULL, "passwordHash" character varying(255) NOT NULL, "displayName" character varying(160) NOT NULL, "role" "public"."admin_users_role_enum" NOT NULL DEFAULT 'recruiter', "isActive" boolean NOT NULL DEFAULT true, "lastLoginAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_06744d221bb6145dc61e5dc441d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_dcd0c8a4b10af9c986e510b9ec" ON "admin_users"  ("email") `);
        await queryRunner.query(`CREATE TABLE "admin_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tokenHash" character varying(64) NOT NULL, "admin_user_id" uuid NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, "ipHash" character varying(64), "userAgent" character varying(500), CONSTRAINT "PK_38bb553c2372215d48de2306c5e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ca4c418a9411015771ead0487b" ON "admin_sessions"  ("tokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_c1711b1831bdf66b77c3605bcd" ON "admin_sessions"  ("admin_user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ec115ef7cff0e3a48125bf538d" ON "admin_sessions"  ("expiresAt") `);
        await queryRunner.query(`CREATE TYPE "public"."contact_messages_service_enum" AS ENUM('ui_ux', 'web', 'mobile')`);
        await queryRunner.query(`CREATE TYPE "public"."contact_messages_locale_enum" AS ENUM('en', 'ka')`);
        await queryRunner.query(`CREATE TYPE "public"."contact_messages_status_enum" AS ENUM('new', 'in_progress', 'resolved', 'spam')`);
        await queryRunner.query(`CREATE TABLE "contact_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying(160) NOT NULL, "email" character varying(320) NOT NULL, "phone" character varying(32), "company" character varying(160), "service" "public"."contact_messages_service_enum", "message" text NOT NULL, "locale" "public"."contact_messages_locale_enum" NOT NULL DEFAULT 'en', "ipHash" character varying(64), "status" "public"."contact_messages_status_enum" NOT NULL DEFAULT 'new', CONSTRAINT "PK_b74f96eb2edd977ccfba6533293" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_feb8b274c477df984576e1baf1" ON "contact_messages"  ("email") `);
        await queryRunner.query(`CREATE INDEX "IDX_b45d117b08adbde9e0fe1b259b" ON "contact_messages"  ("status") `);
        await queryRunner.query(`CREATE TYPE "public"."call_bookings_service_enum" AS ENUM('ui_ux', 'web', 'mobile')`);
        await queryRunner.query(`CREATE TYPE "public"."call_bookings_locale_enum" AS ENUM('en', 'ka')`);
        await queryRunner.query(`CREATE TYPE "public"."call_bookings_status_enum" AS ENUM('requested', 'confirmed', 'cancelled', 'completed')`);
        await queryRunner.query(`CREATE TABLE "call_bookings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying(160) NOT NULL, "email" character varying(320) NOT NULL, "phone" character varying(32), "startsAt" TIMESTAMP WITH TIME ZONE NOT NULL, "timezone" character varying(64) NOT NULL DEFAULT 'Asia/Tbilisi', "service" "public"."call_bookings_service_enum", "notes" text, "locale" "public"."call_bookings_locale_enum" NOT NULL DEFAULT 'en', "ipHash" character varying(64), "status" "public"."call_bookings_status_enum" NOT NULL DEFAULT 'requested', CONSTRAINT "PK_de670837ed84e1b07e41a507001" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d570a554b1767c22095e6b41d5" ON "call_bookings"  ("email") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_call_bookings_active_slot" ON "call_bookings"  ("startsAt") WHERE "status" IN ('requested', 'confirmed')`);
        await queryRunner.query(`CREATE INDEX "IDX_2e5520ab7fe688b035ce21443b" ON "call_bookings"  ("startsAt", "status") `);
        await queryRunner.query(`CREATE TYPE "public"."email_outbox_status_enum" AS ENUM('pending', 'sent', 'failed')`);
        await queryRunner.query(`CREATE TABLE "email_outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "to" jsonb NOT NULL, "template" character varying(64) NOT NULL, "payload" jsonb NOT NULL, "status" "public"."email_outbox_status_enum" NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT '0', "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastError" text, "sentAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_b6fbfc201f705fbf1ac87bd7197" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_bc74428ac677484e9b168d1096" ON "email_outbox"  ("status", "nextAttemptAt") `);
        await queryRunner.query(`CREATE TYPE "public"."job_translations_locale_enum" AS ENUM('en', 'ka')`);
        await queryRunner.query(`CREATE TABLE "job_translations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "job_id" uuid NOT NULL, "locale" "public"."job_translations_locale_enum" NOT NULL, "title" character varying(160) NOT NULL, "description" text NOT NULL, "activities" jsonb NOT NULL DEFAULT '[]'::jsonb, "importantPoints" jsonb NOT NULL DEFAULT '[]'::jsonb, "requirements" jsonb NOT NULL DEFAULT '[]'::jsonb, CONSTRAINT "PK_03ea48d199069b7637e09faa2c3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0e14db44de3b8d65b1a31ffd69" ON "job_translations"  ("job_id", "locale") `);
        await queryRunner.query(`CREATE TYPE "public"."jobs_category_enum" AS ENUM('it', 'digital', 'other')`);
        await queryRunner.query(`CREATE TYPE "public"."jobs_location_enum" AS ENUM('tbilisi', 'batumi', 'remote')`);
        await queryRunner.query(`CREATE TYPE "public"."jobs_employmenttype_enum" AS ENUM('full_time', 'part_time', 'contract', 'internship')`);
        await queryRunner.query(`CREATE TABLE "jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "slug" character varying(120) NOT NULL, "category" "public"."jobs_category_enum" NOT NULL, "location" "public"."jobs_location_enum" NOT NULL, "employmentType" "public"."jobs_employmenttype_enum" NOT NULL, "applicationDeadline" date, "isPublished" boolean NOT NULL DEFAULT false, "publishedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_cf0a6c42b72fcc7f7c237def345" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ebf78eba11615c490d5db84451" ON "jobs"  ("slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_11f04e307252cfe31bbb59e3ac" ON "jobs"  ("isPublished", "category", "location") `);
        await queryRunner.query(`CREATE TYPE "public"."job_applications_locale_enum" AS ENUM('en', 'ka')`);
        await queryRunner.query(`CREATE TYPE "public"."job_applications_status_enum" AS ENUM('received', 'reviewing', 'interview', 'rejected', 'hired')`);
        await queryRunner.query(`CREATE TABLE "job_applications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "job_id" uuid NOT NULL, "firstName" character varying(100) NOT NULL, "lastName" character varying(100) NOT NULL, "city" character varying(160) NOT NULL, "country" character varying(2) NOT NULL, "currentEmployer" character varying(160), "currentPosition" character varying(160), "email" character varying(320) NOT NULL, "phone" character varying(32) NOT NULL, "resumeKey" character varying(500) NOT NULL, "resumeFileName" character varying(255) NOT NULL, "resumeMimeType" character varying(100) NOT NULL, "resumeSizeBytes" integer NOT NULL, "consentAt" TIMESTAMP WITH TIME ZONE NOT NULL, "privacyPolicyVersion" character varying(32) NOT NULL, "locale" "public"."job_applications_locale_enum" NOT NULL DEFAULT 'en', "ipHash" character varying(64), "status" "public"."job_applications_status_enum" NOT NULL DEFAULT 'received', CONSTRAINT "PK_c56a5e86707d0f0df18fa111280" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_99292c6cd0ed428e8f5b4e2295" ON "job_applications"  ("job_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_40039e7ae104e9f722a4064331" ON "job_applications"  ("email") `);
        await queryRunner.query(`CREATE INDEX "IDX_2f2d5f25a87c7f6a6ab3e5f4dc" ON "job_applications"  ("status") `);
        await queryRunner.query(`ALTER TABLE "admin_sessions" ADD CONSTRAINT "FK_c1711b1831bdf66b77c3605bcdb" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "job_translations" ADD CONSTRAINT "FK_f9ada7fa3973bb2809b6d215c00" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "job_applications" ADD CONSTRAINT "FK_99292c6cd0ed428e8f5b4e22958" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_applications" DROP CONSTRAINT "FK_99292c6cd0ed428e8f5b4e22958"`);
        await queryRunner.query(`ALTER TABLE "job_translations" DROP CONSTRAINT "FK_f9ada7fa3973bb2809b6d215c00"`);
        await queryRunner.query(`ALTER TABLE "admin_sessions" DROP CONSTRAINT "FK_c1711b1831bdf66b77c3605bcdb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2f2d5f25a87c7f6a6ab3e5f4dc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_40039e7ae104e9f722a4064331"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_99292c6cd0ed428e8f5b4e2295"`);
        await queryRunner.query(`DROP TABLE "job_applications"`);
        await queryRunner.query(`DROP TYPE "public"."job_applications_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."job_applications_locale_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_11f04e307252cfe31bbb59e3ac"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ebf78eba11615c490d5db84451"`);
        await queryRunner.query(`DROP TABLE "jobs"`);
        await queryRunner.query(`DROP TYPE "public"."jobs_employmenttype_enum"`);
        await queryRunner.query(`DROP TYPE "public"."jobs_location_enum"`);
        await queryRunner.query(`DROP TYPE "public"."jobs_category_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0e14db44de3b8d65b1a31ffd69"`);
        await queryRunner.query(`DROP TABLE "job_translations"`);
        await queryRunner.query(`DROP TYPE "public"."job_translations_locale_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bc74428ac677484e9b168d1096"`);
        await queryRunner.query(`DROP TABLE "email_outbox"`);
        await queryRunner.query(`DROP TYPE "public"."email_outbox_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2e5520ab7fe688b035ce21443b"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_call_bookings_active_slot"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d570a554b1767c22095e6b41d5"`);
        await queryRunner.query(`DROP TABLE "call_bookings"`);
        await queryRunner.query(`DROP TYPE "public"."call_bookings_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."call_bookings_locale_enum"`);
        await queryRunner.query(`DROP TYPE "public"."call_bookings_service_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b45d117b08adbde9e0fe1b259b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_feb8b274c477df984576e1baf1"`);
        await queryRunner.query(`DROP TABLE "contact_messages"`);
        await queryRunner.query(`DROP TYPE "public"."contact_messages_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."contact_messages_locale_enum"`);
        await queryRunner.query(`DROP TYPE "public"."contact_messages_service_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ec115ef7cff0e3a48125bf538d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c1711b1831bdf66b77c3605bcd"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ca4c418a9411015771ead0487b"`);
        await queryRunner.query(`DROP TABLE "admin_sessions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dcd0c8a4b10af9c986e510b9ec"`);
        await queryRunner.query(`DROP TABLE "admin_users"`);
        await queryRunner.query(`DROP TYPE "public"."admin_users_role_enum"`);
    }

}
