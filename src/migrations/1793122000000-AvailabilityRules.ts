import { randomUUID } from "node:crypto";
import type { MigrationInterface, QueryRunner } from "typeorm";

type LegacyRow = { id: string; weeklySlots: Record<string, string[]>; blockedDates: string[] };
type RuleRow = { id: string; rules: { weekdays: number[]; times: string[] }[]; dateOverrides: { date: string; times: string[] }[] };

/** Replaces the fixed weekly slots + blocked dates with recurring rules + per-date overrides. */
export class AvailabilityRules1793122000000 implements MigrationInterface {
    name = "AvailabilityRules1793122000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "booking_settings" ADD "rules" jsonb NOT NULL DEFAULT '[]'::jsonb`);
        await queryRunner.query(`ALTER TABLE "booking_settings" ADD "dateOverrides" jsonb NOT NULL DEFAULT '[]'::jsonb`);

        const rows: LegacyRow[] = await queryRunner.query(`SELECT id, "weeklySlots", "blockedDates" FROM "booking_settings"`);
        for (const row of rows) {
            // Weekdays sharing the same times become one weekly rule.
            const groups = new Map<string, number[]>();
            for (const [day, times] of Object.entries(row.weeklySlots ?? {})) {
                if (!times?.length) continue;
                const key = [...times].sort().join(",");
                groups.set(key, [...(groups.get(key) ?? []), Number(day)]);
            }
            const rules = [...groups.entries()].map(([times, weekdays]) => ({
                id: randomUUID(),
                label: null,
                weekdays: weekdays.sort(),
                times: times.split(","),
                startDate: null,
                endDate: null,
                intervalWeeks: 1,
            }));
            const dateOverrides = (row.blockedDates ?? []).map((date) => ({ date, times: [] }));

            await queryRunner.query(`UPDATE "booking_settings" SET "rules" = $2, "dateOverrides" = $3 WHERE id = $1`, [
                row.id,
                JSON.stringify(rules),
                JSON.stringify(dateOverrides),
            ]);
        }

        await queryRunner.query(`ALTER TABLE "booking_settings" DROP COLUMN "weeklySlots"`);
        await queryRunner.query(`ALTER TABLE "booking_settings" DROP COLUMN "blockedDates"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "booking_settings" ADD "weeklySlots" jsonb NOT NULL DEFAULT '{}'::jsonb`);
        await queryRunner.query(`ALTER TABLE "booking_settings" ADD "blockedDates" jsonb NOT NULL DEFAULT '[]'::jsonb`);

        // Lossy: date ranges, intervals and custom-time dates can't be expressed in the old format.
        const rows: RuleRow[] = await queryRunner.query(`SELECT id, "rules", "dateOverrides" FROM "booking_settings"`);
        for (const row of rows) {
            const weeklySlots: Record<string, string[]> = {};
            for (const rule of row.rules) {
                for (const day of rule.weekdays) {
                    weeklySlots[day] = [...new Set([...(weeklySlots[day] ?? []), ...rule.times])].sort();
                }
            }
            const blockedDates = row.dateOverrides.filter((item) => item.times.length === 0).map((item) => item.date);
            await queryRunner.query(`UPDATE "booking_settings" SET "weeklySlots" = $2, "blockedDates" = $3 WHERE id = $1`, [
                row.id,
                JSON.stringify(weeklySlots),
                JSON.stringify(blockedDates),
            ]);
        }

        await queryRunner.query(`ALTER TABLE "booking_settings" DROP COLUMN "rules"`);
        await queryRunner.query(`ALTER TABLE "booking_settings" DROP COLUMN "dateOverrides"`);
    }
}
