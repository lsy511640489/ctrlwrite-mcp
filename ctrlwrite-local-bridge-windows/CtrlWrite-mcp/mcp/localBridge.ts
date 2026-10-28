import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { accessToken, applyMutations, mutationsSchema, type StoredCanvas } from '../server/canvasStore';
import { buildDraft, draftSchema, markdownDraft, validateCanvas, cleanCanvas } from '../server/canvasModel';
import { prepareFileImport } from '../server/fileImport';
import type { Tab } from '../types/tabTypes';
import { LocalWorkspaceStore } from '../server/localWorkspaceStore';
import { selectWorkspaceDirectory } from '../server/localFolderPicker';

const port = Number(process.env.IAMTIRED_LOCAL_MCP_PORT || 39173);
const siteOrigin = process.env.IAMTIRED_SITE_ORIGIN?.replace(/\/$/, '');
if (!siteOrigin || new URL(siteOrigin).origin !== siteOrigin) throw new Error('Set IAMTIRED_SITE_ORIGIN to the exact website origin.');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid IAMTIRED_LOCAL_MCP_PORT.');
const token = await accessToken();
const files = new LocalWorkspaceStore(process.env.CTRLWRITE_CONFIG_DIR);
let session: { id: string; seen: number; canvas: StoredCanvas | null } | null = null;
const drafts = new Map<string, { sessionId: string; revision: number; tabs: Tab[]; created: number }>();
const liveSession = () => session && Date.now() - session.seen < 20_000 ? session : null;

function send(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 50_000_000) throw new Error('Request exceeds 50 MB.');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function route(request: IncomingMessage, response: ServerResponse, browser: boolean) {
    const url = request.url?.split('?')[0];
    if (url?.startsWith('/local/files/')) {
        if (!browser) return send(response, 403, { error: 'Workspace files require the paired website.' });
        if (url === '/local/files/browse') {
            if (request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) return send(response, 405, { error: 'JSON POST required.' });
            const input = await body(request);
            return send(response, 200, { directory: await selectWorkspaceDirectory(input.directory) });
        }
        return files.run(async () => {
            if (url === '/local/files/status' && request.method === 'GET') return send(response, 200, await files.status());
            if (request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) return send(response, 405, { error: 'JSON POST required.' });
            const input = await body(request);
            if (url === '/local/files/config') { await files.saveSecrets(input.values); return send(response, 200, {}); }
            if (url === '/local/files/activate') {
                const result = await files.activate(input.directory, input.migrate);
                session = null; drafts.clear();
                return send(response, 200, result);
            }
            if (url === '/local/files/detach') { await files.detach(); session = null; drafts.clear(); return send(response, 200, {}); }
            const root = await files.assertRoot(input.workspace);
            if (url === '/local/files/canvas/read') return send(response, 200, await files.document(root, 'canvases/canvas.json'));
            if (url === '/local/files/canvas/write') return send(response, 200, await files.saveCanvas(root, input.revision, input.value));
            if (url === '/local/files/settings/read') return send(response, 200, await files.document(root, 'settings.json'));
            if (url === '/local/files/settings/write') return send(response, 200, await files.saveSettings(root, input.revision, input.value));
            if (!['skill', 'constraint'].includes(input.kind)) throw new Error('Invalid library kind.');
            if (url === '/local/files/library/read') return send(response, 200, { entries: await files.library(root, input.kind) });
            if (url === '/local/files/library/write') return send(response, 200, await files.writeLibrary(root, input.kind, input.entry));
            return send(response, 404, { error: 'Unknown workspace operation.' });
        });
    }
    if (url === '/local/connect' && request.method === 'POST' && browser) {
        const id = (await body(request)).sessionId;
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid browser session.');
        if (liveSession() && session!.id !== id) return send(response, 409, { error: 'Another browser tab is connected. Close it before connecting here.' });
        session = { id, seen: Date.now(), canvas: null };
        drafts.clear();
        return send(response, 200, { connected: true });
    }
    if (url === '/local/disconnect' && request.method === 'POST' && browser) {
        if (session?.id === request.headers['x-canvas-session']) { session = null; drafts.clear(); }
        return send(response, 200, {});
    }
    const active = liveSession();
    if (!active) return send(response, 503, { error: 'Open the website and connect its local MCP bridge in Data settings.' });
    if (browser && request.headers['x-canvas-session'] !== active.id) return send(response, 403, { error: 'Browser session changed.' });
    if (url === '/local/heartbeat' && request.method === 'POST' && browser) {
        active.seen = Date.now();
        return send(response, 200, { connected: true });
    }
    if (browser) active.seen = Date.now();
    if (url === '/api/canvas-mcp/revision' && request.method === 'GET') return send(response, 200, { revision: active.canvas?.revision || 0 });
    if (url === '/api/canvas-mcp/state' && request.method === 'GET') return send(response, 200, active.canvas);
    if (request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) return send(response, 405, { error: 'JSON POST required.' });
    const input = await body(request);
    if (url === '/api/canvas-mcp/state' && browser) {
        if (input.revision !== (active.canvas?.revision || 0)) return send(response, 409, { error: 'Revision conflict. Reload before applying changes.' });
        active.canvas = { revision: input.revision + 1, state: cleanCanvas(validateCanvas(input.state)) };
        return send(response, 200, active.canvas);
    }
    if (url === '/api/canvas-mcp/mutate' && !browser) {
        if (input.revision !== (active.canvas?.revision || 0)) return send(response, 409, { error: 'Revision conflict. Reload before applying changes.' });
        active.canvas = { revision: input.revision + 1, state: cleanCanvas(applyMutations(active.canvas?.state || null, mutationsSchema.parse(input.operations))) };
        return send(response, 200, active.canvas);
    }
    if (url === '/api/canvas-mcp/preview' && !browser) {
        if (input.revision !== (active.canvas?.revision || 0)) return send(response, 409, { error: 'Revision changed. Reload before previewing.' });
        const preview = input.fileContent !== undefined
            ? prepareFileImport(String(input.fileContent), String(input.filename || 'Imported document.md'))
            : buildDraft(input.markdown !== undefined
                ? markdownDraft(String(input.markdown), String(input.filename || 'Imported document.md'))
                : draftSchema.parse(input.draft));
        const id = randomUUID();
        drafts.set(id, { sessionId: active.id, revision: input.revision, tabs: preview.tabs, created: Date.now() });
        for (const [key, value] of drafts) if (Date.now() - value.created > 600_000) drafts.delete(key);
        return send(response, 200, { previewId: id, summary: preview.summary,
            outline: preview.tabs.map(tab => ({ title: tab.title, nodes: tab.nodes.map(node => ({ id: node.id, title: node.title, type: node.type, parentId: node.parentId })) })) });
    }
    if (url === '/api/canvas-mcp/apply' && !browser) {
        const preview = drafts.get(String(input.previewId));
        if (!preview || preview.sessionId !== active.id || Date.now() - preview.created > 600_000) throw new Error('Preview expired. Create a fresh preview.');
        if (preview.revision !== (active.canvas?.revision || 0)) return send(response, 409, { error: 'Revision changed. Create a fresh preview.' });
        active.canvas = { revision: preview.revision + 1, state: cleanCanvas(validateCanvas({
            tabs: [...(active.canvas?.state.tabs || []), ...preview.tabs], activeTabId: preview.tabs[0].id
        })) };
        drafts.delete(String(input.previewId));
        return send(response, 200, active.canvas);
    }
    return send(response, 404, { error: 'Unknown local canvas operation.' });
}

const server = createServer(async (request, response) => {
    try {
        if (!/^(127\.0\.0\.1|localhost):\d+$/.test(request.headers.host || '')) return send(response, 403, { error: 'Loopback host required.' });
        const origin = request.headers.origin;
        if (origin && origin !== siteOrigin) return send(response, 403, { error: 'Website origin not allowed.' });
        if (origin === siteOrigin) {
            response.setHeader('Access-Control-Allow-Origin', siteOrigin);
            response.setHeader('Vary', 'Origin');
            response.setHeader('Access-Control-Allow-Private-Network', 'true');
            response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Canvas-Session');
        }
        if (request.method === 'OPTIONS') return send(response, origin === siteOrigin ? 200 : 403, {});
        const supplied = request.headers.authorization?.replace(/^Bearer /, '') || '';
        if (supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return send(response, 401, { error: 'Invalid local MCP token.' });
        await route(request, response, origin === siteOrigin);
    } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Local canvas operation failed.' });
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Local MCP bridge listening on http://127.0.0.1:${port}`);
    console.log(`Website origin: ${siteOrigin}`);
    console.log(`Pairing token (enter in website Data settings): ${token}`);
});
