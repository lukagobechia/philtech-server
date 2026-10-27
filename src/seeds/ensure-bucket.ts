// Creates the resume bucket if it does not exist (dev / first deploy). Safe to re-run.
import { CreateBucketCommand, HeadBucketCommand, PutPublicAccessBlockCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";

const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
});

try {
    await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    console.log(`Bucket ${env.S3_BUCKET} exists`);
} catch {
    await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
    console.log(`Created bucket ${env.S3_BUCKET}`);
}

// Resumes must never be publicly readable. Not every S3-compatible server supports this call.
await client
    .send(
        new PutPublicAccessBlockCommand({
            Bucket: env.S3_BUCKET,
            PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                IgnorePublicAcls: true,
                BlockPublicPolicy: true,
                RestrictPublicBuckets: true,
            },
        }),
    )
    .catch(() => console.warn("Public access block not supported by this storage provider; verify bucket is private"));
