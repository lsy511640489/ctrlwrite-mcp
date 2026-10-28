import Fastify, { type FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RedisClientType } from 'redis';
import { z } from 'zod';
import { AuthError, type AuthUser } from '../authStore';
import { createAuthMiddleware, type AuthBackend } from '../authBridge';
import { applyMutations, mutationsSchema } from '../canvasStore';
import { buildDraft, draftSchema, markdownDraft, validateCanvas } from '../canvasModel';
import { prepareFileImport } from '../fileImport';
import { changeCloudCanvas, readCloudCanvas, tenantTransaction, workspaceFor } from './database';
import { secretBox, digest } from './crypto';
import { aiInputSchema, aiTarget } from './ai';
import { skillFromZip } from './library';
import type { CloudConfig } from './config';
import type { objectStorage } from './storage';

type Context = { user: AuthUser; workspaceId: string; scopes?: string[] };
type Dependencies = { pool: Pool; redis: RedisClientType; auth: AuthBackend; storage: ReturnType<typeof objectStorage> };
const uuid = z.uuid();
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const cookieToken = (request: FastifyRequest) => request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('iamtired_session='))?.slice('iamtired_session='.length);

export function createCloudApp(config: CloudConfig, dependencies: Dependencies) {
    const { pool, redis, auth, storage } = dependencies;
    const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }, bodyLimit: 30 * 1024 * 1024, requestTimeout: 30000, connectionTimeout: 30000, trustProxy: config.TRUST_PROXY ? config.TRUST_PROXY.split(',').map(value => value.trim()) : false });
    const contexts = new WeakMap<FastifyRequest, Context>();
    const box = secretBox(config.APP_ENCRYPTION_KEY);
    const context = (request: FastifyRequest) => {
        const value = contexts.get(request);
        if (!value) throw new AuthError(401, '请先登录。');
        return value;
    };
    const tenant = <T>(request: FastifyRequest, action: (client: PoolClient, workspaceId: string) => Promise<T>) => {
        const { user, workspaceId } = context(request);
        return tenantTransaction(pool, user.id, client => action(client, workspaceId));
    };
    const addresses = new WeakMap<object, string>();
    const authMiddleware = createAuthMiddleware({ store: auth, guard: false, developmentCodes: false, cloud: true, secureCookies: config.PUBLIC_ORIGIN.startsWith('https:'), publicOrigin: config.PUBLIC_ORIGIN, deliveryUrl: config.AUTH_DELIVERY_URL, deliveryToken: config.AUTH_DELIVERY_TOKEN, address: request => addresses.get(request) || 'unknown' });
    app.addContentTypeParser('application/zip', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_request, body, done) => done(null, body));
    app.addHook('onRequest', async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin');
        const pathname = request.url.split('?')[0];
        if (pathname === '/healthz') return;
        if (pathname.startsWith('/api/auth/')) {
            addresses.set(request.raw, request.ip);
            reply.hijack();
            await authMiddleware(request.raw, reply.raw, () => { reply.raw.writeHead(404); reply.raw.end(); });
            return;
        }
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new AuthError(403, '不允许跨站访问。');
        let current: AuthUser | null = null;
        let workspaceId: string;
        let scopes: string[] | undefined;
        const bearer = request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
        if (bearer) {
            if (!pathname.startsWith('/api/canvas-mcp/')) throw new AuthError(403, '此令牌仅能访问画布接口。');
            const userId = uuid.parse(bearer.split('.')[0]);
            const token = await tenantTransaction(pool, userId, async client => (await client.query('SELECT workspace_id,scopes FROM mcp_tokens WHERE hash=$1 AND expires_at>now()', [digest(bearer)])).rows[0]);
            if (!token) throw new AuthError(401, '令牌无效或已过期。');
            current = { id: userId, name: '', createdAt: '' };
            workspaceId = token.workspace_id;
            scopes = token.scopes;
            if (!scopes.includes(request.method === 'GET' ? 'canvas:read' : 'canvas:write')) throw new AuthError(403, '令牌没有此操作权限。');
        } else {
            current = await auth.current(cookieToken(request));
            if (!current) throw new AuthError(401, '请先登录。');
            if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== config.PUBLIC_ORIGIN) throw new AuthError(403, '请从当前网站提交请求。');
            if (request.headers['x-workspace-user'] && request.headers['x-workspace-user'] !== current.id) throw new AuthError(401, '账号已切换，请刷新当前页面。');
            workspaceId = await workspaceFor(pool, current.id);
        }
        await auth.limit('api:' + current.id, 600, 60);
        contexts.set(request, { user: current, workspaceId, scopes });
    });
    app.setErrorHandler((error, request, reply) => {
        if (error instanceof AuthError) {
            if (error.retryAfter) reply.header('Retry-After', error.retryAfter);
            return reply.status(error.status).send({ error: error.message });
        }
        if (error instanceof z.ZodError) return reply.status(400).send({ error: error.issues[0]?.message || '参数无效。' });
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode && statusCode >= 400 && statusCode < 500) return reply.status(statusCode).send({ error: '请求格式错误或内容过大。' });
        request.log.error({ errorName: error instanceof Error ? error.name : 'Unknown error', requestId: request.id }, 'Cloud request failed');
        return reply.status(500).send({ error: '服务暂时不可用，请稍后重试。' });
    });
    app.get('/healthz', async (_request, reply) => {
        try { await Promise.all([pool.query('SELECT 1'), redis.ping()]); return { ok: true }; }
        catch { return reply.status(503).send({ ok: false }); }
    });
    app.all('/api/auth/*', async (_request, reply) => reply.code(404).send({ error: '账号接口不存在。' }));
    app.get('/api/workspace', async request => ({ id: context(request).workspaceId, ownerId: context(request).user.id }));
    app.get('/api/canvas-mcp/state', async request => tenant(request, readCloudCanvas));
    app.get('/api/canvas-mcp/revision', async request => tenant(request, async (client, workspaceId) => ({ revision: Number((await client.query('SELECT revision FROM canvases WHERE workspace_id=$1', [workspaceId])).rows[0]?.revision || 0) })));
    app.post('/api/canvas-mcp/state', async request => {
        const input = z.object({ revision: revisionSchema, state: z.unknown() }).parse(request.body);
        return tenant(request, (client, workspaceId) => changeCloudCanvas(client, workspaceId, input.revision, () => validateCanvas(input.state)));
    });
    app.post('/api/canvas-mcp/mutate', async request => {
        const input = z.object({ revision: revisionSchema, operations: mutationsSchema }).parse(request.body);
        return tenant(request, (client, workspaceId) => changeCloudCanvas(client, workspaceId, input.revision, state => applyMutations(state, input.operations)));
    });
    app.post('/api/canvas-mcp/preview', async request => {
        const input = z.object({ revision: revisionSchema, filename: z.string().max(255).default('Imported document.md'), markdown: z.string().max(20000000).optional(), fileContent: z.string().max(20000000).optional(), draft: draftSchema.optional() }).parse(request.body);
        if ([input.markdown, input.fileContent, input.draft].filter(value => value !== undefined).length !== 1) throw new AuthError(400, '请提交一份 Markdown 或画布内容。');
        const preview = input.fileContent !== undefined ? prepareFileImport(input.fileContent, input.filename) : buildDraft(input.markdown !== undefined ? markdownDraft(input.markdown, input.filename) : input.draft);
        const current = await tenant(request, readCloudCanvas);
        if ((current?.revision || 0) !== input.revision) throw new AuthError(409, '画布版本已变化，请重新预览。');
        const previewId = randomUUID();
        await redis.set(`preview:${context(request).workspaceId}:${previewId}`, JSON.stringify({ revision: input.revision, tabs: preview.tabs }), { EX: 600 });
        return { previewId, summary: preview.summary, outline: preview.tabs.map(tab => ({ title: tab.title, nodes: tab.nodes.map(node => ({ id: node.id, title: node.title, type: node.type, parentId: node.parentId })) })) };
    });
    app.post('/api/canvas-mcp/apply', async request => {
        const input = z.object({ previewId: uuid }).parse(request.body);
        const key = `preview:${context(request).workspaceId}:${input.previewId}`;
        const raw = await redis.get(key);
        if (typeof raw !== 'string') throw new AuthError(404, '预览不存在或已过期。');
        const preview = JSON.parse(raw);
        const result = await tenant(request, (client, workspaceId) => changeCloudCanvas(client, workspaceId, preview.revision, state => validateCanvas({ tabs: [...(state?.tabs || []), ...preview.tabs], activeTabId: preview.tabs[0].id })));
        await redis.del(key);
        return result;
    });
    app.get('/api/settings', async request => tenant(request, async (client, workspaceId) => {
        const { rows } = await client.query('SELECT encrypted FROM settings WHERE workspace_id=$1', [workspaceId]);
        return rows[0] ? box.open(rows[0].encrypted) : { values: {} };
    }));
    app.put('/api/settings', async request => {
        const input = z.object({ values: z.record(z.string().min(1).max(100), z.string().max(100000)) }).parse(request.body);
        if (Object.keys(input.values).length > 100 || JSON.stringify(input).length > 500000) throw new AuthError(413, '设置内容过大。');
        await tenant(request, (client, workspaceId) => client.query('INSERT INTO settings(workspace_id,encrypted) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET encrypted=EXCLUDED.encrypted,updated_at=now()', [workspaceId, box.seal(input)]));
        return { ok: true };
    });
    app.get('/api/skills', async request => ({ skills: (await tenant(request, (client, workspaceId) => client.query("SELECT id,name,content FROM library WHERE workspace_id=$1 AND kind='skill' ORDER BY created_at", [workspaceId]))).rows }));
    app.post('/api/skills', async (request, reply) => {
        if (!Buffer.isBuffer(request.body)) throw new AuthError(415, '请上传 ZIP 技能文件。');
        const skill = await skillFromZip(request.body);
        const result = await tenant(request, async (client, workspaceId) => {
            await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
            const { rows } = await client.query('SELECT count(*) AS count FROM library WHERE workspace_id=$1', [workspaceId]);
            if (Number(rows[0].count) >= 200) throw new AuthError(409, '工作区技能与约束数量已达上限。');
            return client.query("INSERT INTO library(id,workspace_id,kind,name,content) VALUES($1,$2,'skill',$3,$4) ON CONFLICT(workspace_id,kind,name) DO UPDATE SET content=EXCLUDED.content RETURNING id,name,content", [randomUUID(), workspaceId, skill.name, skill.content]);
        });
        return reply.status(201).send({ skill: result.rows[0] });
    });
    app.get('/api/constraints', async request => {
        const input = z.object({ path: z.string().min(1).max(200) }).parse(request.query);
        const { rows } = await tenant(request, (client, workspaceId) => client.query("SELECT content FROM library WHERE workspace_id=$1 AND kind='constraint' AND name=$2", [workspaceId, input.path]));
        if (!rows[0]) throw new AuthError(404, '当前工作区没有这个约束文件，请先上传。');
        return rows[0];
    });
    app.post('/api/constraints', async request => {
        const input = z.object({ name: z.string().min(1).max(200).regex(/^[^/\\:]+\.md$/i), content: z.string().min(1).max(50000) }).parse(request.body);
        await tenant(request, async (client, workspaceId) => {
            await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
            const { rows } = await client.query('SELECT count(*) AS count FROM library WHERE workspace_id=$1', [workspaceId]);
            if (Number(rows[0].count) >= 200) throw new AuthError(409, '工作区技能与约束数量已达上限。');
            await client.query("INSERT INTO library(id,workspace_id,kind,name,content) VALUES($1,$2,'constraint',$3,$4) ON CONFLICT(workspace_id,kind,name) DO UPDATE SET content=EXCLUDED.content", [randomUUID(), workspaceId, input.name, input.content]);
        });
        return { ok: true };
    });
    app.post('/api/assets', async (request, reply) => {
        const input = z.object({ name: z.string().min(1).max(200), mime: z.string().max(100).default('application/octet-stream'), base64: z.string().min(1).max(14000000).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).parse(request.body);
        const bytes = Buffer.from(input.base64, 'base64');
        if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new AuthError(413, '文件需要在 10 MB 以内。');
        const id = randomUUID();
        const key = context(request).workspaceId + '/' + id;
        await auth.limit('upload:' + context(request).user.id, 100, 86400);
        await storage.put(key, bytes, input.mime);
        try { await tenant(request, (client, workspaceId) => client.query('INSERT INTO assets(id,workspace_id,object_key,name,mime,bytes) VALUES($1,$2,$3,$4,$5,$6)', [id, workspaceId, key, input.name, input.mime, bytes.length])); }
        catch (error) { await storage.remove(key).catch(() => undefined); throw error; }
        return reply.status(201).send({ id, url: '/api/assets/' + id });
    });
    app.get('/api/assets/:id', async (request, reply) => {
        const id = uuid.parse((request.params as any).id);
        const { rows } = await tenant(request, (client, workspaceId) => client.query('SELECT * FROM assets WHERE id=$1 AND workspace_id=$2', [id, workspaceId]));
        if (!rows[0]) throw new AuthError(404, '文件不存在。');
        const object = await storage.get(rows[0].object_key);
        reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].name)}`);
        return reply.send(object.Body);
    });
    app.delete('/api/assets/:id', async request => {
        const id = uuid.parse((request.params as any).id);
        const { rows } = await tenant(request, (client, workspaceId) => client.query('SELECT object_key FROM assets WHERE id=$1 AND workspace_id=$2', [id, workspaceId]));
        if (!rows[0]) throw new AuthError(404, '文件不存在。');
        await storage.remove(rows[0].object_key);
        await tenant(request, (client, workspaceId) => client.query('DELETE FROM assets WHERE id=$1 AND workspace_id=$2', [id, workspaceId]));
        return { ok: true };
    });
    app.post('/api/jobs', async (request, reply) => {
        const input = aiInputSchema.parse(request.body);
        aiTarget(input, config.AI_ALLOWED_BASE_URLS.split(','));
        const { user, workspaceId } = context(request);
        await auth.limit('ai:' + user.id, config.AI_DAILY_REQUESTS, 86400);
        const id = randomUUID();
        await tenant(request, async (client, workspace) => {
            await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace]);
            const { rows } = await client.query("SELECT count(*) AS count FROM jobs WHERE workspace_id=$1 AND status IN ('queued','running')", [workspace]);
            if (Number(rows[0].count) >= config.AI_MAX_PENDING) throw new AuthError(429, '你的待处理任务较多，请稍后再试。');
            await client.query('INSERT INTO jobs(id,workspace_id,payload) VALUES($1,$2,$3)', [id, workspace, box.seal(input)]);
            await client.query('INSERT INTO audit_logs(workspace_id,action,resource_id) VALUES($1,$2,$3)', [workspace, 'ai.queued', id]);
        });
        await redis.zAdd('cloud:jobs', { score: Date.now(), value: JSON.stringify({ userId: user.id, workspaceId, id }) }).catch(() => undefined);
        return reply.status(202).send({ id, status: 'queued' });
    });
    app.get('/api/jobs/:id', async request => {
        const id = uuid.parse((request.params as any).id);
        const { rows } = await tenant(request, (client, workspaceId) => client.query('SELECT id,status,result,error,created_at,finished_at FROM jobs WHERE id=$1 AND workspace_id=$2', [id, workspaceId]));
        if (!rows[0]) throw new AuthError(404, '任务不存在。');
        return rows[0];
    });
    app.post('/api/mcp/tokens', async request => {
        const input = z.object({ scopes: z.array(z.enum(['canvas:read', 'canvas:write'])).min(1).default(['canvas:read']), days: z.number().int().min(1).max(90).default(30) }).parse(request.body);
        const token = context(request).user.id + '.' + randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + input.days * 86400000);
        await tenant(request, (client, workspaceId) => client.query('INSERT INTO mcp_tokens(hash,workspace_id,scopes,expires_at) VALUES($1,$2,$3,$4)', [digest(token), workspaceId, input.scopes, expiresAt]));
        return { token, id: digest(token), expiresAt };
    });
    app.delete('/api/mcp/tokens/:id', async request => {
        const id = z.string().regex(/^[a-f0-9]{64}$/).parse((request.params as any).id);
        await tenant(request, (client, workspaceId) => client.query('DELETE FROM mcp_tokens WHERE hash=$1 AND workspace_id=$2', [id, workspaceId]));
        return { ok: true };
    });
    app.all('/api/codex/*', async (_request, reply) => reply.code(403).send({ error: '服务器版本不开放本机 CLI，请选择在线模型服务。' }));
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '接口不存在。' }));
    return app;
}
