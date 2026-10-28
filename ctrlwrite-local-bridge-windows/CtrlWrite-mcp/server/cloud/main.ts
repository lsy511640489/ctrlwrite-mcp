import { createClient } from 'redis';
import { createPool, assertRestrictedRole } from './database';
import { CloudAuthStore } from './auth';
import { createCloudApp } from './app';
import { loadConfig } from './config';
import { objectStorage } from './storage';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const redis = createClient({ url: config.REDIS_URL });
redis.on('error', () => console.error('Redis connection error.'));
await redis.connect();
await assertRestrictedRole(pool);
const storage = objectStorage(config);
const app = createCloudApp(config, { pool, redis, auth: new CloudAuthStore(pool, redis), storage });
app.addHook('onClose', async () => { storage.close(); await Promise.all([redis.quit(), pool.end()]); });
process.on('SIGTERM', () => { void app.close(); });
process.on('SIGINT', () => { void app.close(); });
await app.listen({ host: config.HOST, port: config.PORT });
