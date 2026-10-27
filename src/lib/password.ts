import argon2 from "argon2";

export function hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
        return await argon2.verify(hash, password);
    } catch {
        return false;
    }
}

// Used when the email is unknown so login timing does not reveal which accounts exist.
let dummyHash: Promise<string> | undefined;
export async function verifyDummyPassword(password: string): Promise<void> {
    dummyHash ??= hashPassword("dummy-password-for-timing");
    await verifyPassword(await dummyHash, password);
}
