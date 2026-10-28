import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { accessToken, applyMutations, changeCanvas, mutationsSchema, readCanvas } from './canvasStore';
import { buildDraft, draftSchema, markdownDraft, validateCanvas } from './canvasModel';
import { prepareFileImport } from './fileImport';
import type { Tab } from '../types/tabTypes';
import { localWorkspaceId } from './workspaceContext';

const drafts = new Map<string, { owner: string; revision: number; tabs: Tab[]; created: number }>();

async function readJson(request: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 50_000_000) throw new Error('Request exceeds 50 MB.');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response: ServerResponse, status: number, data: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
}

export function canvasBridgePlugin(): Plugin {
    return {
        name: 'canvas-mcp-bridge',
        configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
                const url = request.url?.split('?')[0];
                if (!url?.startsWith('/api/canvas-mcp/')) return next();
                try {
                    const host = request.headers.host || '';
                    const origin = request.headers.origin;
                    const sameOrigin = (origin === `http://${host}` || origin === `https://${host}`)
                        || (request.headers['sec-fetch-site'] === 'same-origin' && !origin);
                    const token = request.headers.authorization === `Bearer ${await accessToken()}` || (!!request.headers.authorization?.startsWith('Bearer ') && localWorkspaceId() !== 'legacy');
                    if (!sameOrigin && !token) return send(response, 403, { error: 'Canvas bridge authorization required.' });
                    if (request.method === 'GET' && url === '/api/canvas-mcp/revision') return send(response, 200, { revision: (await readCanvas())?.revision || 0 });
                    if (request.method === 'GET' && url === '/api/canvas-mcp/state') return send(response, 200, await readCanvas());
                    if (request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) return send(response, 405, { error: 'JSON POST required.' });
                    const input = await readJson(request);
                    if (url === '/api/canvas-mcp/state') {
                        if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('Invalid revision.');
                        const state = validateCanvas(input.state);
                        return send(response, 200, await changeCanvas(input.revision, () => state));
                    }
                    if (url === '/api/canvas-mcp/mutate') {
                        const operations = mutationsSchema.parse(input.operations);
                        return send(response, 200, await changeCanvas(input.revision, current => applyMutations(current, operations)));
                    }
                    if (url === '/api/canvas-mcp/preview') {
                        if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('Invalid revision.');
                        const preview = input.fileContent !== undefined
                            ? prepareFileImport(String(input.fileContent), String(input.filename || 'Imported document.md'))
                            : buildDraft(input.markdown !== undefined
                                ? markdownDraft(String(input.markdown), String(input.filename || 'Imported document.md'))
                                : draftSchema.parse(input.draft));
                        if (((await readCanvas())?.revision || 0) !== input.revision) throw new Error('Revision changed. Reload before previewing.');
                        const id = randomUUID();
                        drafts.set(id, { owner: localWorkspaceId(), revision: input.revision, tabs: preview.tabs, created: Date.now() });
                        for (const [key, value] of drafts) if (Date.now() - value.created > 600000) drafts.delete(key);
                        return send(response, 200, { previewId: id, summary: preview.summary,
                            outline: preview.tabs.map(tab => ({ title: tab.title, nodes: tab.nodes.map(node => ({ id: node.id, title: node.title, type: node.type, parentId: node.parentId })) })) });
                    }
                    if (url === '/api/canvas-mcp/apply') {
                        const preview = drafts.get(String(input.previewId));
                        if (!preview || preview.owner !== localWorkspaceId() || Date.now() - preview.created > 600000) throw new Error('Preview expired. Create a fresh preview.');
                        const result = await changeCanvas(preview.revision, current => validateCanvas({
                            tabs: [...(current?.tabs || []), ...preview.tabs], activeTabId: preview.tabs[0].id
                        }));
                        drafts.delete(String(input.previewId));
                        return send(response, 200, result);
                    }
                    return send(response, 404, { error: 'Unknown canvas operation.' });
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Canvas operation failed.';
                    send(response, /conflict|Revision changed/i.test(message) ? 409 : 400, { error: message });
                }
            });
        }
    };
}
