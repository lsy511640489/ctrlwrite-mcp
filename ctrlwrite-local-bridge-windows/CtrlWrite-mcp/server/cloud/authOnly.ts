import Fastify from 'fastify';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { createAuthMiddleware, type AuthBackend } from '../authBridge';
import { configSchema } from './config';
import { createCodeDelivery } from '../codeDelivery';

export const authOnlyConfigSchema = configSchema.pick({
    DATABASE_URL: true, REDIS_URL: true, PUBLIC_ORIGIN: true,
    HOST: true, PORT: true, TRUST_PROXY: true,
    AUTH_DELIVERY_URL: true, AUTH_DELIVERY_TOKEN: true,
    SMTP_HOST: true, SMTP_PORT: true, SMTP_USER: true, SMTP_PASSWORD: true, SMTP_FROM: true,
    TENCENT_SMS_SECRET_ID: true, TENCENT_SMS_SECRET_KEY: true, TENCENT_SMS_APP_ID: true,
    TENCENT_SMS_SIGN_NAME: true, TENCENT_SMS_TEMPLATE_ID: true, TENCENT_SMS_REGION: true
});

type AuthOnlyConfig = ReturnType<typeof authOnlyConfigSchema.parse>;

export function createAuthOnlyApp(config: AuthOnlyConfig, { pool, redis, auth }: { pool: Pool; redis: RedisClientType; auth: AuthBackend }) {
    const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }, trustProxy: config.TRUST_PROXY ? config.TRUST_PROXY.split(',').map(value => value.trim()) : false });
    const addresses = new WeakMap<object, string>();
    const authMiddleware = createAuthMiddleware({ store: auth, guard: false, localOnly: true, developmentCodes: false,
        secureCookies: true, publicOrigin: config.PUBLIC_ORIGIN, deliveryUrl: config.AUTH_DELIVERY_URL,
        deliveryToken: config.AUTH_DELIVERY_TOKEN, delivery: createCodeDelivery(config), address: request => addresses.get(request) || 'unknown' });
    app.addHook('onRequest', async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin');
        if (!request.url.startsWith('/api/auth/')) return;
        addresses.set(request.raw, request.ip);
        reply.hijack();
        await authMiddleware(request.raw, reply.raw, () => { reply.raw.writeHead(404); reply.raw.end(); });
    });
    app.get('/healthz', async (_request, reply) => {
        try { await Promise.all([pool.query('SELECT 1'), redis.ping()]); return { ok: true }; }
        catch { return reply.status(503).send({ ok: false }); }
    });
    app.all('/api/*', async (_request, reply) => reply.status(404).send({ error: '此部署仅提供账号服务，内容保存在当前浏览器。' }));
    return app;
}
