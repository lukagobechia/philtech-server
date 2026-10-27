import { setMailer, type Mail } from "../src/lib/mailer.js";
import { setStorage, type ObjectStorage } from "../src/lib/storage.js";

export const storedObjects = new Map<string, { body: Buffer; contentType: string }>();
export const sentMails: Mail[] = [];

const storage: ObjectStorage = {
    async put(key, body, contentType) {
        storedObjects.set(key, { body, contentType });
    },
    async get(key) {
        const object = storedObjects.get(key);
        if (!object) throw new Error(`NoSuchKey: ${key}`);
        return object.body;
    },
    async delete(key) {
        storedObjects.delete(key);
    },
    async signedDownloadUrl(key, _fileName, options) {
        return `https://storage.test/${key}?disposition=${options?.disposition ?? "attachment"}&signature=fake`;
    },
    async ping() {},
};

export function resetFakes(): void {
    storedObjects.clear();
    sentMails.length = 0;
    setStorage(storage);
    setMailer({
        async send(mail) {
            sentMails.push(mail);
        },
    });
}
