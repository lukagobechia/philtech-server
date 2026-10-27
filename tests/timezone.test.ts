import { describe, expect, it } from "vitest";
import { isoWeekday, zonedDate, zonedTimeToUtc } from "../src/lib/timezone.js";

describe("timezone helpers", () => {
    it("converts Tbilisi wall-clock time to UTC", () => {
        expect(zonedTimeToUtc("2026-10-28", "17:30", "Asia/Tbilisi").toISOString()).toBe("2026-10-28T13:30:00.000Z");
    });

    it("handles DST transitions", () => {
        expect(zonedTimeToUtc("2026-03-28", "10:00", "Europe/Berlin").toISOString()).toBe("2026-03-28T09:00:00.000Z");
        expect(zonedTimeToUtc("2026-03-30", "10:00", "Europe/Berlin").toISOString()).toBe("2026-03-30T08:00:00.000Z");
    });

    it("computes local dates and ISO weekdays", () => {
        expect(zonedDate(new Date("2026-10-27T21:00:00Z"), "Asia/Tbilisi")).toBe("2026-10-28");
        expect(isoWeekday("2026-11-01")).toBe(7);
    });
});
