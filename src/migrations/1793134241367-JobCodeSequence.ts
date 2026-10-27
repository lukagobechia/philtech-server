import type { MigrationInterface, QueryRunner } from "typeorm";

export class JobCodeSequence1793134241367 implements MigrationInterface {
    name = "JobCodeSequence1793134241367";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "job_code_seq"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP SEQUENCE IF EXISTS "job_code_seq"`);
    }
}
