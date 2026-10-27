import type { MigrationInterface, QueryRunner } from "typeorm";

export class BookingSettings1793120485603 implements MigrationInterface {
    name = 'BookingSettings1793120485603'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "booking_settings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "timezone" character varying(64) NOT NULL, "slotMinutes" integer NOT NULL, "minLeadHours" integer NOT NULL, "maxDaysAhead" integer NOT NULL, "weeklySlots" jsonb NOT NULL, "blockedDates" jsonb NOT NULL DEFAULT '[]'::jsonb, CONSTRAINT "PK_1bb13e911613647af2a151ab0a0" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "booking_settings"`);
    }

}
