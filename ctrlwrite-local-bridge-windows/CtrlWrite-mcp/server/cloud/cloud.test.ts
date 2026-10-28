import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import RedisMock from 'ioredis-mock';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { zipSync, strToU8 } from 'fflate';
import { CloudAuthStore } from './auth';
import { configSchema } from './config';
import { createCloudApp } from './app';
import { assertRestrictedRole, tenantTransaction, workspaceFor } from './database';
import { secretBox } from './crypto';
import { aiInputSchema, aiTarget, publicAddress } from './ai';
import { buildDraft } from '../canvasModel';
import { processJob } from './jobProcessor';

async function harness() {
    const database = new PGlite();
    await database.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await database.exec('CREATE ROLE app NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO app; SET ROLE app;');
    let pending = Promise.resolve();
    const connect = async () => {
        const previous = pending;
        let release!: () => void;
        pending = new Promise<void>(resolve => { release = resolve; });
        await previous;
        return { query: async (text: string, parameters?: unknown[]) => { const result = await database.query(text, parameters); return { ...result, rowCount: result.affectedRows ?? result.rows.length }; }, release };
    };
    const pool = { connect, query: async (text: string, parameters?: unknown[]) => { const client = await connect(); try { return await client.query(text, parameters); } finally { client.release(); } } } as unknown as Pool;
    const mock = new RedisMock();
    const redis = {
        get: (key: string) => mock.get(key),
        hGet: (key: string, field: string) => mock.hget(key, field),
        set: (key: string, value: string, options?: { EX: number }) => options ? mock.set(key, value, 'EX', options.EX) : mock.set(key, value),
        del: (key: string) => mock.del(key),
        ping: () => mock.ping(),
        eval: (script: string, options: { keys: string[]; arguments: string[] }) => mock.eval(script, options.keys.length, ...options.keys, ...options.arguments),
        zAdd: (key: string, entry: { score: number; value: string }) => mock.zadd(key, entry.score, entry.value)
    } as unknown as RedisClientType;
    const objects = new Map<string, Buffer>();
    const storage = {
        put: async (key: string, bytes: Buffer) => { objects.set(key, bytes); return {}; },
        get: async (key: string) => ({ Body: Readable.from([objects.get(key)!]) }),
        remove: async (key: string) => { objects.delete(key); return {}; },
        close() {}
    } as any;
    const config = configSchema.parse({ DATABASE_URL: 'postgresql://test', REDIS_URL: 'redis://test', PUBLIC_ORIGIN: 'https://write.test', APP_ENCRYPTION_KEY: 'ab'.repeat(32), S3_ENDPOINT: 'https://objects.test', S3_BUCKET: 'test', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test' });
    const auth = new CloudAuthStore(pool, redis);
    const app = createCloudApp(config, { pool, redis, auth, storage });
    await app.ready();
    return { database, pool, redis, auth, app, config, close: async () => { await app.close(); mock.disconnect(); await database.close(); } };
}

test('cloud accounts and all workspace resources are isolated through API and PostgreSQL RLS', { timeout: 90000 }, async suite => {
    const setup = await harness();
    const { app, auth, pool } = setup;
    const request = (method: any, url: string, cookie = '', payload?: any, extra: Record<string, string> = {}) => app.inject({ method, url, headers: { host: 'write.test', origin: 'https://write.test', ...(cookie ? { cookie } : {}), ...extra }, ...(payload === undefined ? {} : { payload }) });
    const register = async (account: string) => {
        const code = await auth.issueCode(account, 'register');
        const response = await request('POST', '/api/auth/register', '', { account, name: '测试用户', password: 'Long-Password-2026!', code });
        assert.equal(response.statusCode, 201, response.body);
        assert.match(String(response.headers['set-cookie']), /HttpOnly; SameSite=Strict; Secure/);
        return { user: response.json().user, cookie: String(response.headers['set-cookie']).split(';')[0] };
    };
    try {
        await assertRestrictedRole(pool);
        const alice = await register('alice@example.com');
        const bob = await register('bob@example.com');
        const aliceWorkspace = await workspaceFor(pool, alice.user.id);
        const bobWorkspace = await workspaceFor(pool, bob.user.id);
        assert.notEqual(aliceWorkspace, bobWorkspace);
        await suite.test('anonymous, cross-site and stale account requests are rejected', async () => {
            assert.equal((await request('GET', '/api/canvas-mcp/state')).statusCode, 401);
            assert.equal((await request('POST', '/api/canvas-mcp/state', alice.cookie, {}, { origin: 'https://evil.test' })).statusCode, 403);
            assert.equal((await request('GET', '/api/workspace', bob.cookie, undefined, { 'x-workspace-user': alice.user.id })).statusCode, 401);
            const session = await request('GET', '/api/auth/session', alice.cookie);
            assert.equal(session.json().cloud, true);
            assert.equal(session.json().developmentCodes, false);
        });
        await suite.test('canvas saves are private and concurrent stale revisions return 409', async () => {
            const draft = buildDraft({ tabs: [{ title: 'Alice secret', nodes: [{ key: 'note', type: 'text', title: 'Private', content: 'Only Alice' }] }] });
            const state = { tabs: draft.tabs, activeTabId: draft.tabs[0].id };
            assert.equal((await request('POST', '/api/canvas-mcp/state', alice.cookie, { revision: 0, state })).statusCode, 200);
            assert.equal((await request('GET', '/api/canvas-mcp/state', bob.cookie)).json(), null);
            const results = await Promise.all([request('POST', '/api/canvas-mcp/state', alice.cookie, { revision: 1, state }), request('POST', '/api/canvas-mcp/state', alice.cookie, { revision: 1, state })]);
            assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
            assert.equal((await request('GET', '/api/canvas-mcp/state', alice.cookie)).json().revision, 2);
        });
        await suite.test('preview IDs cannot be applied by another user', async () => {
            const response = await request('POST', '/api/canvas-mcp/preview', alice.cookie, { revision: 2, markdown: '# Private preview\n\nContent' });
            assert.equal(response.statusCode, 200, response.body);
            const previewId = response.json().previewId;
            assert.equal((await request('POST', '/api/canvas-mcp/apply', bob.cookie, { previewId })).statusCode, 404);
            assert.equal((await request('POST', '/api/canvas-mcp/apply', alice.cookie, { previewId })).statusCode, 200);
            assert.equal((await request('POST', '/api/canvas-mcp/apply', alice.cookie, { previewId })).statusCode, 404);
        });
        await suite.test('preferences and model keys are private and encrypted at rest', async () => {
            const values = { iamtired_ai_config: JSON.stringify({ apiKey: 'alice-private-api-key' }) };
            assert.equal((await request('PUT', '/api/settings', alice.cookie, { values })).statusCode, 200);
            assert.deepEqual((await request('GET', '/api/settings', alice.cookie)).json(), { values });
            assert.deepEqual((await request('GET', '/api/settings', bob.cookie)).json(), { values: {} });
            const encrypted = await tenantTransaction(pool, alice.user.id, async client => (await client.query('SELECT encrypted FROM settings')).rows[0].encrypted);
            assert.ok(!encrypted.includes('alice-private-api-key'));
        });
        await suite.test('files cannot be read or deleted by another account', async () => {
            const response = await request('POST', '/api/assets', alice.cookie, { name: 'secret.txt', base64: Buffer.from('Alice file').toString('base64') });
            assert.equal(response.statusCode, 201, response.body);
            const url = response.json().url;
            assert.equal((await request('GET', url, bob.cookie)).statusCode, 404);
            assert.equal((await request('DELETE', url, bob.cookie)).statusCode, 404);
            assert.equal((await request('GET', url, alice.cookie)).body, 'Alice file');
        });
        await suite.test('uploaded skills and constraints belong only to their workspace', async () => {
            const zip = Buffer.from(zipSync({ 'writing/SKILL.md': strToU8('---\nname: Alice writing\n---\nPrivate writing rules') }));
            const response = await request('POST', '/api/skills', alice.cookie, zip, { 'content-type': 'application/zip' });
            assert.equal(response.statusCode, 201, response.body);
            assert.equal((await request('GET', '/api/skills', alice.cookie)).json().skills.length, 1);
            assert.equal((await request('GET', '/api/skills', bob.cookie)).json().skills.length, 0);
            assert.equal((await request('POST', '/api/constraints', alice.cookie, { name: 'rules.md', content: 'Private rules' })).statusCode, 200);
            assert.equal((await request('GET', '/api/constraints?path=rules.md', bob.cookie)).statusCode, 404);
            assert.equal((await request('GET', '/api/constraints?path=rules.md', alice.cookie)).json().content, 'Private rules');
            assert.equal((await request('GET', '/api/constraints?path=C%3A%2FWindows%2Fsecret.md', alice.cookie)).statusCode, 404);
        });
        await suite.test('AI jobs are private, encrypted, bounded and cannot execute local CLI', async () => {
            const payload = { operation: 'text', config: { provider: 'openai', apiKey: 'alice-job-key', model: 'test-model' }, userPrompt: 'Private prompt' };
            const response = await request('POST', '/api/jobs', alice.cookie, payload);
            assert.equal(response.statusCode, 202, response.body);
            const id = response.json().id;
            assert.equal((await request('GET', '/api/jobs/' + id, bob.cookie)).statusCode, 404);
            const status = await request('GET', '/api/jobs/' + id, alice.cookie);
            assert.equal(status.statusCode, 200);
            assert.ok(!status.body.includes('alice-job-key'));
            const encrypted = await tenantTransaction(pool, alice.user.id, async client => (await client.query('SELECT payload FROM jobs WHERE id=$1', [id])).rows[0].payload);
            assert.ok(!encrypted.includes('Private prompt'));
            assert.equal((await request('POST', '/api/jobs', alice.cookie, payload)).statusCode, 202);
            assert.equal((await request('POST', '/api/jobs', alice.cookie, payload)).statusCode, 202);
            assert.equal((await request('POST', '/api/jobs', alice.cookie, payload)).statusCode, 429);
            assert.equal((await request('POST', '/api/codex/generate', alice.cookie, {})).statusCode, 403);
            assert.equal((await request('POST', '/api/jobs', bob.cookie, { ...payload, config: { ...payload.config, baseUrl: 'https://internal.test/v1' } })).statusCode, 400);
        });
        await suite.test('MCP tokens restrict operations and can be revoked', async () => {
            const issued = await request('POST', '/api/mcp/tokens', alice.cookie, { scopes: ['canvas:read'], days: 1 });
            assert.equal(issued.statusCode, 200, issued.body);
            const { token, id } = issued.json();
            const headers = { authorization: 'Bearer ' + token };
            assert.equal((await request('GET', '/api/canvas-mcp/state', '', undefined, headers)).json().state.tabs[0].title, 'Alice secret');
            assert.equal((await request('POST', '/api/canvas-mcp/mutate', '', {}, headers)).statusCode, 403);
            assert.equal((await request('GET', '/api/settings', '', undefined, headers)).statusCode, 403);
            assert.equal((await request('DELETE', '/api/mcp/tokens/' + id, bob.cookie)).statusCode, 200);
            assert.equal((await request('GET', '/api/canvas-mcp/state', '', undefined, headers)).statusCode, 200);
            assert.equal((await request('DELETE', '/api/mcp/tokens/' + id, alice.cookie)).statusCode, 200);
            assert.equal((await request('GET', '/api/canvas-mcp/state', '', undefined, headers)).statusCode, 401);
        });
        await suite.test('workers cannot execute another workspace job and complete a job only once', async () => {
            const job = await tenantTransaction(pool, alice.user.id, async client => (await client.query('SELECT id FROM jobs ORDER BY created_at LIMIT 1')).rows[0]);
            const box = secretBox(setup.config.APP_ENCRYPTION_KEY);
            let executions = 0;
            const execute = async () => { executions++; return { text: 'Alice result' }; };
            assert.equal(await processJob(pool, box, { userId: bob.user.id, workspaceId: aliceWorkspace, id: job.id }, execute), false);
            assert.equal(executions, 0);
            assert.equal(await processJob(pool, box, { userId: alice.user.id, workspaceId: aliceWorkspace, id: job.id }, execute), true);
            assert.equal(await processJob(pool, box, { userId: alice.user.id, workspaceId: aliceWorkspace, id: job.id }, execute), false);
            assert.equal(executions, 1);
            assert.deepEqual((await request('GET', '/api/jobs/' + job.id, alice.cookie)).json().result, { text: 'Alice result' });
            const stored = await tenantTransaction(pool, alice.user.id, async client => (await client.query('SELECT payload FROM jobs WHERE id=$1', [job.id])).rows[0].payload);
            assert.deepEqual(box.open(stored), {});
        });
        await suite.test('RLS blocks direct cross-workspace SQL and pooled contexts do not leak', async () => {
            await tenantTransaction(pool, bob.user.id, async client => {
                for (const table of ['canvases', 'settings', 'assets', 'library', 'jobs', 'audit_logs']) {
                    assert.equal((await client.query(`SELECT * FROM ${table} WHERE workspace_id=$1`, [aliceWorkspace])).rowCount, 0, table);
                }
                assert.equal((await client.query('SELECT * FROM workspaces WHERE id=$1', [aliceWorkspace])).rowCount, 0);
            });
            await assert.rejects(tenantTransaction(pool, bob.user.id, client => client.query("INSERT INTO library(id,workspace_id,kind,name,content) VALUES($1,$2,'skill','attack','secret')", [randomUUID(), aliceWorkspace])), /row-level security/i);
            assert.equal((await pool.query('SELECT * FROM workspaces')).rowCount, 0);
            assert.equal((await pool.query('SELECT * FROM canvases')).rowCount, 0);
            assert.equal((await workspaceFor(pool, alice.user.id)), aliceWorkspace);
            assert.equal((await workspaceFor(pool, bob.user.id)), bobWorkspace);
        });
        await suite.test('OTP guesses are capped, consumed once, and reset revokes all sessions', async () => {
            const code = await auth.issueCode('bob@example.com', 'reset');
            await auth.resetPassword('bob@example.com', code, 'New-Password-2026!');
            assert.equal(await auth.current(bob.cookie.split('=')[1]), null);
            assert.equal((await request('POST', '/api/auth/login', '', { account: 'bob@example.com', password: 'Long-Password-2026!' })).statusCode, 401);
            assert.equal((await request('POST', '/api/auth/login', '', { account: 'bob@example.com', password: 'New-Password-2026!' })).statusCode, 200);
            await assert.rejects(auth.resetPassword('bob@example.com', code, 'Another-Password-2026!'));
            const limited = await auth.issueCode('bob@example.com', 'reset');
            const wrong = limited === '000000' ? '111111' : '000000';
            for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(auth.resetPassword('bob@example.com', wrong, 'Another-Password-2026!'));
            await assert.rejects(auth.resetPassword('bob@example.com', limited, 'Another-Password-2026!'));
        });
    } finally { await setup.close(); }
});

test('model allowlist and DNS address filters reject local and special networks', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(address), false, address);
    assert.equal(publicAddress('8.8.8.8'), true);
    assert.equal(publicAddress('2606:4700:4700::1111'), true);
    const input = aiInputSchema.parse({ operation: 'text', config: { provider: 'openai', model: 'test', apiKey: 'test' }, userPrompt: 'test' });
    assert.equal(aiTarget(input, ['https://api.openai.com/v1']), 'https://api.openai.com/v1');
    assert.throws(() => aiTarget({ ...input, config: { ...input.config, baseUrl: 'https://api.openai.com.evil.test/v1' } }, ['https://api.openai.com/v1']));
});

test('encrypted secrets cannot be decrypted after tampering or with a different key', () => {
    const box = secretBox('ab'.repeat(32));
    const encrypted = box.seal({ apiKey: 'private-secret' });
    assert.deepEqual(box.open(encrypted), { apiKey: 'private-secret' });
    const bytes = Buffer.from(encrypted, 'base64');
    bytes[bytes.length - 1] ^= 1;
    assert.throws(() => box.open(bytes.toString('base64')));
    assert.throws(() => secretBox('cd'.repeat(32)).open(encrypted));
});
