import {
    DeleteObjectCommand,
    HeadBucketCommand,
    PutObjectCommand,
    S3Client,
    GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

export type SignedUrlOptions = {
    expiresInSeconds?: number;
    // "inline" lets the browser display the file (e.g. a PDF) instead of saving it.
    disposition?: "attachment" | "inline";
    contentType?: string;
};

export interface ObjectStorage {
    put(key: string, body: Buffer, contentType: string): Promise<void>;
    get(key: string): Promise<Buffer>;
    delete(key: string): Promise<void>;
    signedDownloadUrl(key: string, fileName: string, options?: SignedUrlOptions): Promise<string>;
    ping(): Promise<void>;
}

class S3Storage implements ObjectStorage {
    private readonly client = new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials: {
            accessKeyId: env.S3_ACCESS_KEY,
            secretAccessKey: env.S3_SECRET_KEY,
        },
    });

    async put(key: string, body: Buffer, contentType: string): Promise<void> {
        await this.client.send(
            new PutObjectCommand({
                Bucket: env.S3_BUCKET,
                Key: key,
                Body: body,
                ContentType: contentType,
                ServerSideEncryption: env.S3_ENDPOINT ? undefined : "AES256",
            }),
        );
    }

    async get(key: string): Promise<Buffer> {
        const response = await this.client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
        return Buffer.from(await response.Body!.transformToByteArray());
    }

    async delete(key: string): Promise<void> {
        await this.client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    }

    signedDownloadUrl(
        key: string,
        fileName: string,
        { expiresInSeconds = 300, disposition = "attachment", contentType }: SignedUrlOptions = {},
    ): Promise<string> {
        const safeName = fileName.replace(/[^\w.\- ]/g, "_");
        return getSignedUrl(
            this.client,
            new GetObjectCommand({
                Bucket: env.S3_BUCKET,
                Key: key,
                ResponseContentDisposition: `${disposition}; filename="${safeName}"`,
                ResponseContentType: contentType,
            }),
            { expiresIn: expiresInSeconds },
        );
    }

    async ping(): Promise<void> {
        await this.client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    }
}

// Replaceable in tests via setStorage().
let storage: ObjectStorage = new S3Storage();

export const getStorage = (): ObjectStorage => storage;
export const setStorage = (next: ObjectStorage): void => {
    storage = next;
};
