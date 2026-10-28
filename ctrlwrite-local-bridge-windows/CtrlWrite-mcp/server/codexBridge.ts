import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import type { Plugin } from 'vite';

const MAX_REQUEST_BYTES = 120_000;
const MAX_OUTPUT_BYTES = 2_000_000;
let activeTextRequests = 0;

const send = (response: ServerResponse, status: number, data: unknown) => {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
};

const readBody = async (request: IncomingMessage): Promise<any> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) throw new Error('Request is too large.');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

export const lastCodexMessage = (output: string): string => {
    let message = '';
    for (const line of output.split(/\r?\n/)) {
        try {
            const event = JSON.parse(line);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text || '';
        } catch { /* Ignore non-JSON diagnostics. */ }
    }
    return message.trim();
};

export const codexInvocation = (model: string, environment: NodeJS.ProcessEnv = process.env) => {
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', tmpdir()];
    if (model) args.push('--model', model);
    args.push('-');
    const env: NodeJS.ProcessEnv = { ...environment, HOME: environment.HOME || environment.USERPROFILE || homedir() };
    return { args, env };
};

const runCodex = (systemPrompt: string, userPrompt: string, model: string, response: ServerResponse): Promise<string> => new Promise((resolve, reject) => {
    const { args, env } = codexInvocation(model);
    const child = spawn(process.platform === 'win32' ? 'codex.exe' : 'codex', args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let diagnostic = '';
    let settled = false;
    const finish = (error?: Error, text?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        response.off('close', onClose);
        if (error) reject(error);
        else resolve(text || '');
    };
    const onClose = () => { if (!response.writableEnded) child.kill(); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Codex timed out after 3 minutes.')); }, 180_000);
    response.on('close', onClose);
    child.on('error', error => finish(new Error(`Could not start Codex CLI: ${error.message}`)));
    child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.length > MAX_OUTPUT_BYTES) { child.kill(); finish(new Error('Codex response is too large.')); }
    });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2_000); });
    child.on('close', code => {
        const text = lastCodexMessage(output);
        finish(code === 0 && text ? undefined : new Error(diagnostic.trim() || 'Codex returned no text. Check its login and model settings.'), text);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`Follow the writing instructions below and return only the requested answer. Do not inspect files or run tools.\n\nInstructions:\n${systemPrompt}\n\nRequest:\n${userPrompt}`);
});

export const codexBridgePlugin = (): Plugin => {
    const middleware = async (request: IncomingMessage, response: ServerResponse) => {
        const address = request.socket.remoteAddress;
        const host = request.headers.host || '';
        const origin = request.headers.origin;
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || '') ||
            !origin || (origin !== `http://${host}` && origin !== `https://${host}`)) return send(response, 403, { error: 'Local same-origin access only.' });
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        try {
            const body = await readBody(request);
            if (request.url === '/text') {
                const { systemPrompt, userPrompt, model = '' } = body;
                if (typeof systemPrompt !== 'string' || typeof userPrompt !== 'string' || !userPrompt.trim() ||
                    typeof model !== 'string' || (model && !/^[\w.:-]{1,100}$/.test(model))) throw new Error('Invalid Codex text request.');
                if (activeTextRequests >= 2) return send(response, 429, { error: 'Codex is busy. Try again shortly.' });
                activeTextRequests++;
                try { return send(response, 200, { text: await runCodex(systemPrompt, userPrompt, model, response) }); }
                finally { activeTextRequests--; }
            }
            return send(response, 404, { error: 'Unknown Codex operation.' });
        } catch (error) {
            send(response, 400, { error: error instanceof Error ? error.message : 'Codex request failed.' });
        }
    };
    return {
        name: 'local-codex-bridge',
        configureServer(server) { server.middlewares.use('/api/codex', middleware); },
        configurePreviewServer(server) { server.middlewares.use('/api/codex', middleware); }
    };
};
