import ExcelJS from "exceljs";
import { env } from "../config/env.js";
import { zonedParts } from "./timezone.js";

export type CellValue = string | number | Date | null | undefined;

export type Column = { header: string; width?: number; type?: "text" | "number" | "date" | "datetime" | "percent" };

export type Sheet = { name: string; columns: Column[]; rows: CellValue[][] };

/** Spreadsheet apps run CSV cells starting with these as formulas; prefix them so exported user input stays text. */
const FORMULA_START = /^[=+\-@\t\r]/;
const safeText = (value: string) => (FORMULA_START.test(value) ? `'${value}` : value);

/** Wall-clock parts in the company timezone, as spreadsheets have no time zones. */
function companyWallClock(date: Date) {
    const p = zonedParts(date, env.COMPANY_TIMEZONE);
    return { ...p, pad: (n: number) => String(n).padStart(2, "0") };
}

function csvText(value: CellValue, column: Column): string {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) {
        const p = companyWallClock(value);
        const date = `${p.year}-${p.pad(p.month)}-${p.pad(p.day)}`;
        return column.type === "date" ? date : `${date} ${p.pad(p.hour)}:${p.pad(p.minute)}`;
    }
    if (typeof value === "number") return column.type === "percent" ? `${Math.round(value * 1000) / 10}%` : String(value);
    return safeText(value);
}

const csvField = (text: string) => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** RFC 4180 CSV with a UTF-8 BOM so Excel shows Georgian text correctly. */
export function toCsv(sheet: Sheet): Buffer {
    const lines = [
        sheet.columns.map((column) => csvField(column.header)).join(","),
        ...sheet.rows.map((row) => sheet.columns.map((column, index) => csvField(csvText(row[index], column))).join(",")),
    ];
    return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}

const NUM_FMT: Partial<Record<NonNullable<Column["type"]>, string>> = {
    date: "yyyy-mm-dd",
    datetime: "yyyy-mm-dd hh:mm",
    percent: "0.0%",
    number: "#,##0.##",
};

/** One worksheet per sheet: bold frozen header, filters, sized columns, real dates and numbers. */
export async function toXlsx(sheets: Sheet[], meta: { title: string }): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "PhilTech Solutions";
    workbook.title = meta.title;
    workbook.created = new Date();

    for (const sheet of sheets) {
        // Excel limits sheet names to 31 characters and forbids some symbols.
        const worksheet = workbook.addWorksheet(sheet.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31), {
            views: [{ state: "frozen", ySplit: 1 }],
        });
        worksheet.columns = sheet.columns.map((column) => ({
            header: column.header,
            width: column.width ?? Math.min(48, Math.max(12, column.header.length + 4)),
            style: NUM_FMT[column.type ?? "text"] ? { numFmt: NUM_FMT[column.type ?? "text"] } : {},
        }));

        for (const row of sheet.rows) {
            worksheet.addRow(
                row.map((value) => {
                    if (value instanceof Date) {
                        // Stored as the company's wall-clock time, which is what readers expect to see.
                        const p = companyWallClock(value);
                        return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
                    }
                    // Strings are stored as text cells, never formulas, so no guard is needed here.
                    return value ?? null;
                }),
            );
        }

        const header = worksheet.getRow(1);
        header.font = { bold: true, color: { argb: "FFFFFFFF" } };
        header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBB2425" } };
        header.alignment = { vertical: "middle" };
        header.height = 22;
        if (sheet.columns.length) {
            worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
        }
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
}
