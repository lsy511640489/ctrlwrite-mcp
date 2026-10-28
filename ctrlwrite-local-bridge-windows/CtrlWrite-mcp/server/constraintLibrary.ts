import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { workspaceDirectory } from './workspaceContext';

const MAX_CONSTRAINT_BYTES = 50000;

const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const respond = (response: ServerResponse, status: number, body: object) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
};

export const constraintLibraryPlugin = (): Plugin => {
    const middleware = async (request: IncomingMessage, response: ServerResponse) => {
        const constraintRoot = workspaceDirectory(path.resolve(process.cwd(), 'constraint'));
        const address = request.socket.remoteAddress;
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || '')) return respond(response, 403, { error: 'Local access only.' });
        if (request.method !== 'GET') return respond(response, 405, { error: 'Method not allowed.' });
        try {
            const filename = new URL(request.url || '/', 'http://localhost').searchParams.get('path') || '';
            if (!filename || !/\.md$/i.test(filename) || path.isAbsolute(filename) || filename.includes(':')) throw new Error('Choose a .md path inside the constraint folder.');
            await mkdir(constraintRoot, { recursive: true });
            const root = await realpath(constraintRoot);
            const candidate = path.resolve(constraintRoot, filename);
            if (!inside(constraintRoot, candidate)) throw new Error('The path must stay inside the constraint folder.');
            const resolved = await realpath(candidate);
            if (!inside(root, resolved)) throw new Error('The path must stay inside the constraint folder.');
            const file = await stat(resolved);
            if (!file.isFile() || file.size > MAX_CONSTRAINT_BYTES) throw new Error('Choose a .md file smaller than 50 KB.');
            const content = await readFile(resolved, 'utf8');
            if (!content.trim()) throw new Error('The Markdown constraint is empty.');
            return respond(response, 200, { content });
        } catch (error) {
            return respond(response, 400, { error: error instanceof Error ? error.message : 'Could not read Markdown constraint.' });
        }
    };
    return {
        name: 'local-constraint-library',
        configureServer(server) { server.middlewares.use('/api/constraints', middleware); },
        configurePreviewServer(server) { server.middlewares.use('/api/constraints', middleware); }
    };
};
