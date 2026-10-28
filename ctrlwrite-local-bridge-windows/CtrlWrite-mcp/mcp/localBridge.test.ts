import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildDraft } from '../server/canvasModel';

async function freePort() {
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('No test port.');
    await new Promise<void>(resolve => listener.close(() => resolve()));
    return address.port;
}

test('local MCP bridge pairs one browser and never serves a disconnected canvas', { timeout: 30000 }, async () => {
    const project = fileURLToPath(new URL('..', import.meta.url));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ctrlwrite-local-mcp-'));
    const port = await freePort();
    const origin = 'https://write.example.com';
    const env = { ...process.env, IAMTIRED_CANVAS_DATA_DIR: directory, IAMTIRED_SITE_ORIGIN: origin,
        CTRLWRITE_CONFIG_DIR: path.join(directory, 'config'),
        IAMTIRED_LOCAL_MCP_PORT: String(port), IAMTIRED_CANVAS_URL: `http://127.0.0.1:${port}` } as Record<string, string>;
    const cli = path.join(project, 'node_modules/tsx/dist/cli.mjs');
    let bridge: ChildProcess | undefined;
    let client: Client | undefined;
    try {
        const bridgeArguments = process.env.CTRLWRITE_TEST_BRIDGE_ENTRY ? [process.env.CTRLWRITE_TEST_BRIDGE_ENTRY] : [cli, path.join(project, 'mcp/localBridge.ts')];
        bridge = spawn(process.execPath, bridgeArguments, { cwd: project, env });
        const token = await new Promise<string>((resolve, reject) => {
            let stdout = '';
            const timeout = setTimeout(() => reject(new Error('Bridge did not start.')), 10000);
            bridge!.stdout!.on('data', chunk => {
                stdout += chunk.toString();
                const match = stdout.match(/Pairing token .*: ([a-f0-9]{64})/);
                if (match) { clearTimeout(timeout); resolve(match[1]); }
            });
            bridge!.on('exit', code => { clearTimeout(timeout); reject(new Error(`Bridge exited (${code}).`)); });
        });
        const browser = (route: string, data?: unknown, sessionId = '11111111-1111-4111-8111-111111111111', websiteOrigin = origin, secret = token) => fetch(`http://127.0.0.1:${port}/${route}`, {
            method: data === undefined ? 'GET' : 'POST',
            headers: { Origin: websiteOrigin, Authorization: `Bearer ${secret}`, 'X-Canvas-Session': sessionId,
                ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data)
        });
        assert.equal((await browser('local/connect', { sessionId: '11111111-1111-4111-8111-111111111111' }, undefined, origin, 'wrong')).status, 401);
        assert.equal((await browser('local/connect', { sessionId: '11111111-1111-4111-8111-111111111111' }, undefined, 'https://other.example.com')).status, 403);
        const preflight = await fetch(`http://127.0.0.1:${port}/local/connect`, { method: 'OPTIONS', headers: {
            Origin: origin, 'Access-Control-Request-Private-Network': 'true', 'Access-Control-Request-Method': 'POST'
        } });
        assert.equal(preflight.status, 200);
        assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
        assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
        assert.equal((await browser('local/files/status', undefined, undefined, origin, 'wrong')).status, 401);
        assert.equal((await browser('local/files/browse', { directory: '' }, undefined, origin, 'wrong')).status, 401);
        assert.equal((await browser('local/files/browse', { directory: '' }, undefined, 'https://other.example.com')).status, 403);
        assert.equal((await browser('local/files/browse')).status, 405);
        assert.equal((await fetch(`http://127.0.0.1:${port}/local/files/status`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
        const fileStatus = await (await browser('local/files/status')).json();
        assert.equal(fileStatus.configPath, path.join(directory, 'config', 'config.json'));
        const workspace = path.join(directory, 'files');
        assert.equal((await browser('local/files/activate', { directory: workspace })).status, 200);
        assert.equal((await browser('local/files/settings/write', { workspace, revision: null, value: { iamtired_global_md_path: 'rules.md' } })).status, 200);
        assert.equal((await (await browser('local/files/settings/read', { workspace })).json()).value.iamtired_global_md_path, 'rules.md');
        assert.equal((await browser('local/files/settings/read', { workspace: path.join(directory, 'wrong') })).status, 400);
        assert.equal((await browser('local/files/detach', {})).status, 200);
        assert.equal((await browser('local/connect', { sessionId: '11111111-1111-4111-8111-111111111111' })).status, 200);
        assert.equal((await browser('local/connect', { sessionId: '22222222-2222-4222-8222-222222222222' }, '22222222-2222-4222-8222-222222222222')).status, 409);
        const tab = buildDraft({ tabs: [{ title: 'Local', nodes: [{ key: 'body', type: 'text', title: 'Intro', content: 'On this PC' }] }] }).tabs[0];
        const state = { tabs: [tab], activeTabId: tab.id };
        assert.equal((await browser('api/canvas-mcp/state', { revision: 0, state })).status, 200);
        const transport = new StdioClientTransport({ command: process.execPath, args: [cli, path.join(project, 'mcp/server.ts')], cwd: project, env, stderr: 'pipe' });
        client = new Client({ name: 'local-test', version: '1.0.0' });
        await client.connect(transport);
        const call = async (name: string, args: Record<string, unknown>) => {
            const result = await client!.callTool({ name, arguments: args });
            const parsed = JSON.parse((result.content as { text: string }[])[0].text);
            if (result.isError) throw new Error(parsed.error);
            return parsed;
        };
        assert.equal((await call('list_tabs', {})).revision, 1);
        assert.equal((await call('get_object', { tabId: tab.id, nodeId: tab.nodes[0].id })).node.content, 'On this PC');
        assert.equal((await call('edit_canvas', { revision: 1, operations: [
            { kind: 'update_node', tabId: tab.id, nodeId: tab.nodes[0].id, changes: { content: 'Changed locally' } }
        ] })).revision, 2);
        assert.equal((await (await browser('api/canvas-mcp/state')).json()).state.tabs[0].nodes[0].content, 'Changed locally');
        assert.equal((await browser('api/canvas-mcp/state', { revision: 1, state })).status, 409);
        const preview = await call('preview_markdown', { revision: 2, markdown: '# New\n\n## Body\n\nSome text.' });
        assert.equal((await call('apply_preview', { previewId: preview.previewId })).revision, 3);
        assert.equal((await browser('local/disconnect', {})).status, 200);
        assert.equal((await browser('api/canvas-mcp/state')).status, 503);
        const missing = await client.callTool({ name: 'list_tabs', arguments: {} });
        assert.equal(missing.isError, true);
    } finally {
        await client?.close();
        bridge?.kill();
        await rm(directory, { recursive: true, force: true });
    }
});
