import type { MigrationInterface, QueryRunner } from "typeorm";

export class InterviewAttachments1793123342285 implements MigrationInterface {
    name = 'InterviewAttachments1793123342285'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interviews" ADD "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb`);
        await queryRunner.query(`ALTER TABLE "interviews" ALTER COLUMN "meetingUrl" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Take-home tasks without a link need a value before the column becomes required again.
        await queryRunner.query(`UPDATE "interviews" SET "meetingUrl" = '' WHERE "meetingUrl" IS NULL`);
        await queryRunner.query(`ALTER TABLE "interviews" ALTER COLUMN "meetingUrl" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "interviews" DROP COLUMN "attachments"`);
    }

}
