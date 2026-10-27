const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
    let value = formatters.get(timeZone);
    if (!value) {
        value = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        formatters.set(timeZone, value);
    }
    return value;
}

export function isValidTimeZone(timeZone: string): boolean {
    try {
        formatter(timeZone);
        return true;
    } catch {
        return false;
    }
}

/** Wall-clock parts of an instant in the given zone. */
export function zonedParts(date: Date, timeZone: string) {
    const parts = Object.fromEntries(
        formatter(timeZone)
            .formatToParts(date)
            .map((part) => [part.type, part.value]),
    );
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}

function offsetMs(date: Date, timeZone: string): number {
    const p = zonedParts(date, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Converts a wall-clock time in `timeZone` to a UTC instant. */
export function zonedTimeToUtc(dateIso: string, time: string, timeZone: string): Date {
    const [year, month, day] = dateIso.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    const guess = Date.UTC(year!, month! - 1, day!, hour!, minute!);
    let result = guess - offsetMs(new Date(guess), timeZone);
    // Second pass corrects for offset changes (DST) between the guess and the result.
    result = guess - offsetMs(new Date(result), timeZone);
    return new Date(result);
}

/** Calendar date (YYYY-MM-DD) of an instant in the given zone. */
export function zonedDate(date: Date, timeZone: string): string {
    const p = zonedParts(date, timeZone);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** ISO weekday, 1 = Monday ... 7 = Sunday, of a YYYY-MM-DD date. */
export function isoWeekday(dateIso: string): number {
    const day = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
    return day === 0 ? 7 : day;
}

export function addDays(dateIso: string, days: number): string {
    const date = new Date(`${dateIso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
