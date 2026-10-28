import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { buildDraft } from './canvasModel';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('local development also isolates accounts, previews, MCP tokens and private files', { timeout: 60000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ctrlwrite-workspaces-'));
    const project = fileURLToPath(new URL('..', import.meta.url));
    process.env.AUTH_DATA_DIR = path.join(directory, 'accounts');
    process.env.IAMTIRED_CANVAS_DATA_DIR = path.join(directory, 'canvases');
    process.env.AUTH_DEV_CODES = 'true';
    const vite = await createServer({ configFile: path.join(project, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, fs: { allow: [project, directory] } } });
    try {
        await vite.listen();
        const address = vite.httpServer!.address();
        assert.ok(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}`;
        const call = async (route: string, cookie = '', data?: unknown, extra: Record<string, string> = {}, method?: string) => {
            const response = await fetch(base + route, { method: method || (data === undefined ? 'GET' : 'POST'), headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
            return { response, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
        };
        const register = async (account: string) => {
            const issued = await call('/api/auth/code', '', { account, purpose: 'register' });
            const result = await call('/api/auth/register', '', { account, name: '测试用户', password: 'Long-Test-Password!', code: issued.data.developmentCode });
            assert.equal(result.response.status, 201, JSON.stringify(result.data));
            return { cookie: result.cookie, user: result.data.user };
        };
        const alice = await register('local-alice@example.com');
        const bob = await register('local-bob@example.com');
        const draft = buildDraft({ tabs: [{ title: 'Local Alice private', nodes: [{ key: 'note', type: 'text', title: 'Private', content: 'Alice only' }] }] });
        const state = { tabs: draft.tabs, activeTabId: draft.tabs[0].id };
        assert.equal((await call('/api/canvas-mcp/state', alice.cookie, { revision: 0, state })).response.status, 200);
        assert.equal((await call('/api/canvas-mcp/state', bob.cookie)).data, null);
        assert.equal((await call('/api/canvas-mcp/state', bob.cookie, undefined, { 'X-Workspace-User': alice.user.id })).response.status, 401);
        const preview = await call('/api/canvas-mcp/preview', alice.cookie, { revision: 1, markdown: '# Secret preview\n\nPrivate' });
        assert.equal((await call('/api/canvas-mcp/apply', bob.cookie, { previewId: preview.data.previewId })).response.status, 400);
        const issued = await call('/api/mcp/tokens', alice.cookie, { scopes: ['canvas:read'], days: 1 });
        const headers = { Authorization: 'Bearer ' + issued.data.token };
        assert.equal((await call('/api/canvas-mcp/state', '', undefined, headers)).data.state.tabs[0].title, 'Local Alice private');
        assert.equal((await call('/api/canvas-mcp/state', '', { revision: 1, state }, headers)).response.status, 403);
        assert.equal((await call('/api/mcp/tokens/' + issued.data.id, bob.cookie, undefined, {}, 'DELETE')).response.status, 200);
        assert.equal((await call('/api/canvas-mcp/state', '', undefined, headers)).response.status, 200);
        assert.equal((await call('/api/mcp/tokens/' + issued.data.id, alice.cookie, undefined, {}, 'DELETE')).response.status, 200);
        assert.equal((await call('/api/canvas-mcp/state', '', undefined, headers)).response.status, 401);
        const stored = JSON.parse(await readFile(path.join(directory, 'canvases', 'users', alice.user.id, 'canvas.json'), 'utf8'));
        assert.equal(stored.state.tabs[0].title, 'Local Alice private');
        const legacyFile = path.join(directory, 'legacy.json');
        await writeFile(legacyFile, JSON.stringify({ revision: 1, state }));
        const execute = promisify(execFile);
        const args = ['--import', 'tsx', path.join(project, 'server/importLocalWorkspace.ts'), '--account', 'local-alice@example.com', '--canvas', legacyFile];
        await assert.rejects(execute(process.execPath, args, { cwd: project, env: process.env }), /Target canvas already exists/);
        await execute(process.execPath, [...args, '--append'], { cwd: project, env: process.env });
        const migrated = (await call('/api/canvas-mcp/state', alice.cookie)).data;
        assert.equal(migrated.state.tabs.length, 2);
        assert.equal(migrated.state.tabs[0].id, stored.state.tabs[0].id);
        assert.notEqual(migrated.state.tabs[1].id, stored.state.tabs[0].id);
        assert.equal((await call('/api/canvas-mcp/state', bob.cookie)).data, null);
        const privateUrl = '/@fs/' + path.join(directory, 'canvases', 'users', alice.user.id, 'canvas.json').replace(/\\/g, '/');
        assert.equal((await fetch(base + privateUrl)).status, 403);
        await mkdir(path.join(directory, 'accounts'), { recursive: true });
        assert.equal((await fetch(base + '/@fs/' + path.join(directory, 'accounts', 'accounts.json').replace(/\\/g, '/'))).status, 403);
    } finally {
        await vite.close();
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('ctrlwrite-workspaces-'));
        await rm(directory, { recursive: true, force: true });
    }
});
