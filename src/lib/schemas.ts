import { z } from "zod";
import { Locale } from "../entities/enums.js";

const optionalTrimmed = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .optional()
        .transform((value) => (value ? value : null));

export const schemas = {
    locale: z.enum(Locale).default(Locale.EN),
    name: z.string().trim().min(1).max(160),
    email: z.email().trim().toLowerCase().max(320),
    // Accepts "+995 593 51 26 63", "(+995) 593-51-26-63" etc. and normalizes to E.164.
    phone: z
        .string()
        .trim()
        .transform((value) => value.replace(/[\s()\-.]/g, ""))
        .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, "Invalid phone number")),
    optionalTrimmed,
    uuid: z.uuid(),
    // Bots fill hidden fields; humans leave them empty.
    honeypot: z.string().max(500).optional(),
};
