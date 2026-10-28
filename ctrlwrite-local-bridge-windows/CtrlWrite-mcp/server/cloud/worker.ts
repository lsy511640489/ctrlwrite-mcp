import { createClient } from 'redis';
import { createPool, assertRestrictedRole, tenantTransaction } from './database';
import { loadConfig } from './config';
import { secretBox } from './crypto';
import { executeAI } from './ai';
import { processJob } from './jobProcessor';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const redis = createClient({ url: config.REDIS_URL });
redis.on('error', () => console.error('Worker Redis connection error.'));
const box = secretBox(config.APP_ENCRYPTION_KEY);
let stopping = false;
let rescanAt = 0;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
await redis.connect();
await assertRestrictedRole(pool);
try {
    while (!stopping) {
        try {
            if (Date.now() >= rescanAt) {
                const users = await pool.query('SELECT id FROM users');
                for (const user of users.rows) {
                    await tenantTransaction(pool, user.id, async client => {
                        const { rows } = await client.query("SELECT id,workspace_id FROM jobs WHERE status='queued' OR (status='running' AND lease_until<now()) LIMIT 500");
                        for (const job of rows) await redis.zAdd('cloud:jobs', { score: Date.now(), value: JSON.stringify({ userId: user.id, workspaceId: job.workspace_id, id: job.id }) }, { NX: true });
                    });
                }
                rescanAt = Date.now() + 60000;
            }
            const items = await redis.zRangeByScore('cloud:jobs', 0, Date.now(), { LIMIT: { offset: 0, count: 1 } });
            if (!items.length) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
            const item = items[0];
            const entry = JSON.parse(item);
            await redis.zAdd('cloud:jobs', { score: Date.now() + 240000, value: item }, { XX: true });
            const completed = await processJob(pool, box, entry, input => executeAI(input, config.AI_ALLOWED_BASE_URLS.split(',')));
            if (completed) await redis.zRem('cloud:jobs', item);
            else {
                const status = await tenantTransaction(pool, entry.userId, async client => (await client.query('SELECT status FROM jobs WHERE id=$1 AND workspace_id=$2', [entry.id, entry.workspaceId])).rows[0]?.status);
                if (!status || ['done', 'failed'].includes(status)) await redis.zRem('cloud:jobs', item);
            }
        } catch (error) {
            console.error('Worker iteration failed:', error instanceof Error ? error.name : 'Unknown error');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
} finally { await Promise.all([redis.quit(), pool.end()]); }
