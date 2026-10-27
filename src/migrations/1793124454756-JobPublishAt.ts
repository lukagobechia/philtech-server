import type { MigrationInterface, QueryRunner } from "typeorm";

export class JobPublishAt1793124454756 implements MigrationInterface {
    name = 'JobPublishAt1793124454756'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "publishAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "IDX_7c8b066f02285ac5564e19d667" ON "jobs"  ("publishAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_7c8b066f02285ac5564e19d667"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "publishAt"`);
    }

}
