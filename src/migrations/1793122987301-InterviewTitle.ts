import type { MigrationInterface, QueryRunner } from "typeorm";

export class InterviewTitle1793122987301 implements MigrationInterface {
    name = 'InterviewTitle1793122987301'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interviews" ADD "title" character varying(120) NOT NULL DEFAULT 'Interview'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interviews" DROP COLUMN "title"`);
    }

}
