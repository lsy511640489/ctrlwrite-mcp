import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CloudConfig } from './config';

export function objectStorage(config: CloudConfig) {
    const client = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, requestHandler: { connectionTimeout: 10000, requestTimeout: 60000 }, credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY } });
    return {
        put: (key: string, bytes: Buffer, mime: string) => client.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: bytes, ContentType: mime })),
        get: (key: string) => client.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key })),
        remove: (key: string) => client.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key })),
        close: () => client.destroy()
    };
}
