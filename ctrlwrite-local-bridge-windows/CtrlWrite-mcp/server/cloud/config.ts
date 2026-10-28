import { z } from 'zod';

export const configSchema = z.object({
    DATABASE_URL: z.string().min(1), REDIS_URL: z.string().min(1),
    PUBLIC_ORIGIN: z.url().refine(value => (new URL(value).protocol === 'https:' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)) && new URL(value).origin === value, 'Use an HTTPS origin without a trailing slash outside localhost.'),
    APP_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    HOST: z.string().default('0.0.0.0'),
    AUTH_DELIVERY_URL: z.preprocess(value => value === '' ? undefined : value, z.url().optional()), AUTH_DELIVERY_TOKEN: z.string().optional(),
    SMTP_HOST: z.string().optional(), SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    SMTP_USER: z.string().optional(), SMTP_PASSWORD: z.string().optional(), SMTP_FROM: z.string().optional(),
    TENCENT_SMS_SECRET_ID: z.string().optional(), TENCENT_SMS_SECRET_KEY: z.string().optional(),
    TENCENT_SMS_APP_ID: z.string().optional(), TENCENT_SMS_SIGN_NAME: z.string().optional(),
    TENCENT_SMS_TEMPLATE_ID: z.string().optional(), TENCENT_SMS_REGION: z.string().default('ap-guangzhou'),
    TRUST_PROXY: z.string().default(''),
    S3_ENDPOINT: z.url(), S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(1), S3_ACCESS_KEY_ID: z.string().min(1), S3_SECRET_ACCESS_KEY: z.string().min(1),
    AI_ALLOWED_BASE_URLS: z.string().default('https://api.openai.com/v1,https://generativelanguage.googleapis.com/v1beta,https://api.anthropic.com/v1,https://openrouter.ai/api/v1,https://api.deepseek.com'),
    AI_DAILY_REQUESTS: z.coerce.number().int().positive().default(100),
    AI_MAX_PENDING: z.coerce.number().int().positive().max(20).default(3)
});
export type CloudConfig = z.infer<typeof configSchema>;
export const loadConfig = () => configSchema.parse(process.env);
