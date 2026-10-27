import type { MigrationInterface, QueryRunner } from "typeorm";

export class AuditLogAppendOnly1793134241368 implements MigrationInterface {
    name = "AuditLogAppendOnly1793134241368";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'audit_logs is append-only';
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`
            CREATE TRIGGER audit_logs_append_only
            BEFORE UPDATE OR DELETE ON "audit_logs"
            FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only()
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS audit_logs_append_only ON "audit_logs"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS audit_logs_append_only()`);
    }
}
