import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import type { AuthBackend } from '../authBridge';
import { authOnlyConfigSchema, createAuthOnlyApp } from './authOnly';

test('auth-only server exposes sessions but rejects workspace content', async () => {
    const config = authOnlyConfigSchema.parse({ DATABASE_URL: 'postgresql://test', REDIS_URL: 'redis://test', PUBLIC_ORIGIN: 'https://write.test' });
    const pool = { query: async () => ({ rows: [{ '?column?': 1 }] }) } as unknown as Pool;
    const redis = { ping: async () => 'PONG' } as unknown as RedisClientType;
    const auth = { current: async () => null } as unknown as AuthBackend;
    const app = createAuthOnlyApp(config, { pool, redis, auth });
    try {
        const session = await app.inject({ method: 'GET', url: '/api/auth/session' });
        assert.equal(session.statusCode, 200);
        assert.equal(session.json().localOnly, true);
        assert.equal(session.json().cloud, false);
        const health = await app.inject({ method: 'GET', url: '/healthz' });
        assert.equal(health.statusCode, 200);
        for (const url of ['/api/canvas-mcp/state', '/api/settings', '/api/skills', '/api/assets', '/api/jobs']) {
            const response = await app.inject({ method: 'GET', url });
            assert.equal(response.statusCode, 404, url);
        }
    } finally { await app.close(); }
});
