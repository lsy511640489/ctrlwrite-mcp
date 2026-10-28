import { createClient } from 'redis';
import { createPool, assertRestrictedRole } from './database';
import { CloudAuthStore } from './auth';
import { authOnlyConfigSchema, createAuthOnlyApp } from './authOnly';

const config = authOnlyConfigSchema.parse(process.env);
const pool = createPool(config.DATABASE_URL);
const redis = createClient({ url: config.REDIS_URL });
redis.on('error', () => console.error('Redis connection error.'));
await redis.connect();
await assertRestrictedRole(pool);
const app = createAuthOnlyApp(config, { pool, redis, auth: new CloudAuthStore(pool, redis) });
app.addHook('onClose', async () => { await Promise.all([redis.quit(), pool.end()]); });
process.on('SIGTERM', () => { void app.close(); });
process.on('SIGINT', () => { void app.close(); });
await app.listen({ host: config.HOST, port: config.PORT });
