import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function secretBox(key: string) {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('APP_ENCRYPTION_KEY must contain 64 hexadecimal characters.');
    const bytes = Buffer.from(key, 'hex');
    return {
        seal(value: unknown) {
            const nonce = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', bytes, nonce);
            const content = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
            return Buffer.concat([nonce, cipher.getAuthTag(), content]).toString('base64');
        },
        open<T = any>(value: string): T {
            const content = Buffer.from(value, 'base64');
            const decipher = createDecipheriv('aes-256-gcm', bytes, content.subarray(0, 12));
            decipher.setAuthTag(content.subarray(12, 28));
            return JSON.parse(Buffer.concat([decipher.update(content.subarray(28)), decipher.final()]).toString('utf8'));
        }
    };
}
