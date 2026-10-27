import { z } from "zod";
import { env } from "../config/env.js";
import { addDays, zonedTimeToUtc } from "./timezone.js";

/** ILIKE pattern matching `value` anywhere, with LIKE wildcards in it escaped. */
export const likePattern = (value: string) => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export const searchQuery = z.string().trim().max(100).optional();

/** `from`/`to` are whole days (inclusive) in the company timezone. */
export const dateRangeQuery = {
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
};

export function dayRange(from?: string, to?: string): { start?: Date; end?: Date } {
    return {
        start: from ? zonedTimeToUtc(from, "00:00", env.COMPANY_TIMEZONE) : undefined,
        // Exclusive end: midnight after the last day.
        end: to ? zonedTimeToUtc(addDays(to, 1), "00:00", env.COMPANY_TIMEZONE) : undefined,
    };
}

/** Comma-separated list of enum values, e.g. "?status=new,read". */
export const enumList = <T extends Record<string, string>>(values: T) =>
    z
        .string()
        .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
        .pipe(z.array(z.enum(values)).min(1));

export type GroupCount = { key: string | null; count: number };

/** Response of the ".../summary?groupBy=" endpoints: largest groups first, then by key (empty last). */
export const grouped = (groupBy: string, groups: GroupCount[]) => ({
    groupBy,
    // Sorted here because Postgres orders enum keys by declaration, not alphabetically.
    groups: [...groups].sort(
        (a, b) => b.count - a.count || (a.key === null ? 1 : b.key === null ? -1 : a.key.localeCompare(b.key)),
    ),
    total: groups.reduce((sum, group) => sum + group.count, 0),
});
