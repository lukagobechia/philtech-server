import nodemailer from "nodemailer";
import { env } from "../config/env.js";

export type MailAttachment = { filename: string; content: Buffer; contentType: string };

export type Mail = {
    to: string[];
    subject: string;
    text: string;
    html: string;
    replyTo?: string;
    attachments?: MailAttachment[];
};

export interface Mailer {
    send(mail: Mail): Promise<void>;
}

class SmtpMailer implements Mailer {
    private readonly transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });

    async send(mail: Mail): Promise<void> {
        await this.transport.sendMail({ from: env.SMTP_FROM, ...mail });
    }
}

let mailer: Mailer = new SmtpMailer();

export const getMailer = (): Mailer => mailer;
export const setMailer = (next: Mailer): void => {
    mailer = next;
};
