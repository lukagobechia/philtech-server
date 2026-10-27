import { env } from "../../config/env.js";
import type { Mail } from "../../lib/mailer.js";

type Locale = "en" | "ka";

const escapeHtml = (value: unknown): string =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

function layout(title: string, rows: [string, unknown][], intro?: string): { text: string; html: string } {
    const visible = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
    const text = [intro, ...visible.map(([label, value]) => `${label}: ${value}`)].filter(Boolean).join("\n");
    const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111">
<h2 style="color:#bb2425">${escapeHtml(title)}</h2>
${intro ? `<p style="white-space:pre-wrap">${escapeHtml(intro)}</p>` : ""}
<table cellpadding="6" style="border-collapse:collapse">
${visible.map(([label, value]) => `<tr><td style="font-weight:bold;vertical-align:top">${escapeHtml(label)}</td><td style="white-space:pre-wrap">${escapeHtml(value)}</td></tr>`).join("\n")}
</table>
<p style="color:#888;font-size:12px">PhilTech Solutions</p>
</body></html>`;
    return { text, html };
}

function formatSlot(iso: unknown, timeZone: string, locale: Locale): string {
    return new Date(String(iso)).toLocaleString(locale === "ka" ? "ka-GE" : "en-GB", {
        timeZone,
        dateStyle: "full",
        timeStyle: "short",
    });
}

const confirmations = {
    en: {
        contact: { subject: "We received your message", intro: "Thank you for reaching out. Our team will get back to you shortly." },
        booking: { subject: "Your call request", intro: "Thank you for booking a call. We will confirm the time with you shortly." },
        application: { subject: "We received your application", intro: "Thank you for applying. Our Talent Acquisition team will review your application." },
        labels: { time: "Time", position: "Position", reference: "Reference code" },
        interview: {
            scheduled: { subject: "Interview invitation", intro: "Thank you for your application. We would like to invite you to an interview." },
            updated: { subject: "Your interview has been updated", intro: "The details of your interview have changed. Please see the updated information below." },
            cancelled: { subject: "Your interview has been cancelled", intro: "Unfortunately we had to cancel your interview. We will contact you if we can arrange a new time." },
            labels: { interview: "Interview", position: "Position", time: "Time", duration: "Duration", link: "Meeting link", attachments: "Attached files", minutes: "min" },
        },
        bookingStatus: {
            confirmed: { subject: "Your call is confirmed", intro: "Your call with PhilTech Solutions is confirmed. We look forward to talking with you." },
            cancelled: { subject: "Your call has been cancelled", intro: "Unfortunately we had to cancel this call. Feel free to book another time on our website." },
        },
    },
    ka: {
        contact: { subject: "თქვენი შეტყობინება მიღებულია", intro: "გმადლობთ, რომ დაგვიკავშირდით. ჩვენი გუნდი მალე გიპასუხებთ." },
        booking: { subject: "ზარის მოთხოვნა", intro: "გმადლობთ ზარის დაჯავშნისთვის. დროს მალე დაგიდასტურებთ." },
        application: { subject: "თქვენი განაცხადი მიღებულია", intro: "გმადლობთ განაცხადისთვის. ჩვენი გუნდი განიხილავს მას." },
        labels: { time: "დრო", position: "პოზიცია", reference: "საიდენტიფიკაციო კოდი" },
        interview: {
            scheduled: { subject: "მოწვევა გასაუბრებაზე", intro: "გმადლობთ განაცხადისთვის. გვსურს მოგიწვიოთ გასაუბრებაზე." },
            updated: { subject: "გასაუბრების დეტალები შეიცვალა", intro: "თქვენი გასაუბრების დეტალები შეიცვალა. იხილეთ განახლებული ინფორმაცია ქვემოთ." },
            cancelled: { subject: "გასაუბრება გაუქმდა", intro: "სამწუხაროდ, გასაუბრების გაუქმება მოგვიწია. ახალი დროის შეთანხმების შემთხვევაში დაგიკავშირდებით." },
            labels: { interview: "გასაუბრება", position: "პოზიცია", time: "დრო", duration: "ხანგრძლივობა", link: "შეხვედრის ბმული", attachments: "მიმაგრებული ფაილები", minutes: "წთ" },
        },
        bookingStatus: {
            confirmed: { subject: "თქვენი ზარი დადასტურებულია", intro: "თქვენი ზარი PhilTech Solutions-თან დადასტურებულია. მოუთმენლად ველით საუბარს." },
            cancelled: { subject: "თქვენი ზარი გაუქმდა", intro: "სამწუხაროდ, ზარის გაუქმება მოგვიწია. შეგიძლიათ სხვა დრო დაჯავშნოთ ჩვენს ვებგვერდზე." },
        },
    },
} as const;

type Payload = Record<string, unknown>;

export type InterviewEmailKind = "scheduled" | "updated" | "cancelled";

/** The standard subject and message, which recruiters can replace per email. */
export function interviewEmailDefaults(kind: InterviewEmailKind, p: Payload): { subject: string; message: string } {
    const locale = (p.locale as Locale) ?? "en";
    const t = confirmations[locale].interview;
    const greeting = locale === "ka" ? `გამარჯობა ${p.firstName},` : `Hello ${p.firstName},`;
    return {
        subject: p.title ? `${t[kind].subject}: ${p.title}` : t[kind].subject,
        message: `${greeting}\n\n${t[kind].intro}`,
    };
}

function interviewEmail(kind: InterviewEmailKind, p: Payload): Omit<Mail, "to"> {
    const locale = (p.locale as Locale) ?? "en";
    const t = confirmations[locale].interview;
    const defaults = interviewEmailDefaults(kind, p);
    const subject = (p.customSubject as string) || defaults.subject;
    const message = (p.customMessage as string) || defaults.message;

    const rows: [string, unknown][] = [
        [t.labels.interview, p.title],
        [t.labels.position, p.jobTitle],
        [t.labels.time, `${formatSlot(p.startsAt, String(p.timezone), locale)} (${p.timezone})`],
    ];
    // A cancelled interview doesn't need joining details.
    if (kind !== "cancelled") {
        const files = Array.isArray(p.attachments) ? (p.attachments as { fileName: string }[]).map((file) => file.fileName) : [];
        rows.push(
            [t.labels.duration, `${p.durationMinutes} ${t.labels.minutes}`],
            [t.labels.link, p.meetingUrl],
            [t.labels.attachments, files.join(", ")],
        );
    }
    return { subject, ...layout(subject, rows, message) };
}

export const templates: Record<string, (payload: Payload) => Omit<Mail, "to">> = {
    contact_internal: (p) => ({
        subject: `New contact message from ${p.name}`,
        replyTo: String(p.email),
        ...layout("New contact message", [
            ["Name", p.name],
            ["Email", p.email],
            ["Phone", p.phone],
            ["Company", p.company],
            ["Service", p.service],
            ["Message", p.message],
        ]),
    }),
    contact_confirmation: (p) => {
        const t = confirmations[(p.locale as Locale) ?? "en"];
        return { subject: t.contact.subject, ...layout(t.contact.subject, [], t.contact.intro) };
    },
    booking_internal: (p) => ({
        subject: `New call booking: ${p.name}`,
        replyTo: String(p.email),
        ...layout("New call booking", [
            ["Name", p.name],
            ["Email", p.email],
            ["Phone", p.phone],
            ["Time", formatSlot(p.startsAt, String(p.businessTimezone ?? env.BOOKING_TIMEZONE), "en")],
            ["Duration", p.slotMinutes ? `${p.slotMinutes} min` : null],
            ["Visitor timezone", p.timezone],
            ["Service", p.service],
            ["Notes", p.notes],
        ]),
    }),
    booking_confirmation: (p) => {
        const locale = (p.locale as Locale) ?? "en";
        const t = confirmations[locale];
        return {
            subject: t.booking.subject,
            ...layout(t.booking.subject, [[t.labels.time, formatSlot(p.startsAt, String(p.timezone), locale)]], t.booking.intro),
        };
    },
    booking_status: (p) => {
        const locale = (p.locale as Locale) ?? "en";
        const t = confirmations[locale];
        const status = t.bookingStatus[p.status as "confirmed" | "cancelled"];
        return {
            subject: status.subject,
            ...layout(status.subject, [[t.labels.time, formatSlot(p.startsAt, String(p.timezone), locale)]], status.intro),
        };
    },
    interview_scheduled: (p) => interviewEmail("scheduled", p),
    interview_updated: (p) => interviewEmail("updated", p),
    interview_cancelled: (p) => interviewEmail("cancelled", p),
    application_internal: (p) => ({
        subject: `New application: ${p.jobTitle} [${p.jobCode}] (${p.firstName} ${p.lastName})`,
        replyTo: String(p.email),
        ...layout("New job application", [
            ["Position", p.jobTitle],
            ["Job code", p.jobCode],
            ["Name", `${p.firstName} ${p.lastName}`],
            ["Email", p.email],
            ["Phone", p.phone],
            ["Location", `${p.city}, ${p.country}`],
            ["Current employer", p.currentEmployer],
            ["Current position", p.currentPosition],
            ["Application ID", p.applicationId],
        ]),
    }),
    application_confirmation: (p) => {
        const t = confirmations[(p.locale as Locale) ?? "en"];
        return {
            subject: t.application.subject,
            ...layout(
                t.application.subject,
                [
                    [t.labels.position, p.jobTitle],
                    [t.labels.reference, p.jobCode],
                ],
                t.application.intro,
            ),
        };
    },
};

export type EmailTemplate = keyof typeof templates;
