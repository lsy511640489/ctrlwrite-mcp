import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { validateAIConfig } from '../services/aiProviders';

const loopbackAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

const send = (response: ServerResponse, status: number, data: unknown) => {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
};

export const relayMiddleware = async (request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host || '';
    let hostname = '';
    try { hostname = new URL(`http://${host}`).hostname; } catch {}
    if (!loopbackAddresses.includes(request.socket.remoteAddress || '') || !loopbackHosts.includes(hostname) ||
        !request.headers.origin || ![`http://${host}`, `https://${host}`].includes(request.headers.origin)) {
        return send(response, 403, { error: 'Local same-origin access only.' });
    }
    if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
    const isImage = request.url === '/image';
    if (request.url !== '/text' && !isImage) return send(response, 404, { error: 'Unknown relay operation.' });
    let body;
    try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size > 120_000) return send(response, 413, { error: 'Relay request is too large.' });
            chunks.push(Buffer.from(chunk));
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body.apiKey !== 'string' || typeof body.model !== 'string' || typeof body.baseUrl !== 'string') {
            return send(response, 400, { error: 'Invalid relay request.' });
        }
        if (isImage ? typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 30_000 :
            typeof body.systemPrompt !== 'string' || typeof body.userPrompt !== 'string' || !body.userPrompt.trim()) {
            return send(response, 400, { error: 'Invalid relay prompt.' });
        }
        const error = validateAIConfig({ provider: 'relay', apiKey: body.apiKey, model: body.model, baseUrl: body.baseUrl });
        if (error) return send(response, 400, { error });
        if (isImage && body.protocol !== undefined && !['openai', 'gemini'].includes(body.protocol)) {
            return send(response, 400, { error: 'Unsupported image API format.' });
        }
    } catch {
        return send(response, 400, { error: 'Invalid relay request JSON.' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), isImage ? 180_000 : 60_000);
    const onClose = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', onClose);
    try {
        const isGemini = isImage && body.protocol === 'gemini';
        const model = body.model.trim();
        const suffix = isGemini ? `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent` : isImage ? '/images/generations' : '/chat/completions';
        const url = body.baseUrl.trim().replace(/\/+$/, '') + suffix;
        const payload = isGemini ? {
            contents: [{ parts: [{ text: body.prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        } : isImage ? { model, prompt: body.prompt, n: 1, size: '1024x1024' } : {
            model: body.model.trim(), messages: [
                { role: 'system', content: body.systemPrompt },
                { role: 'user', content: body.userPrompt }
            ]
        };
        const upstream = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(isGemini ? { 'x-goog-api-key': body.apiKey.trim() } : { Authorization: `Bearer ${body.apiKey.trim()}` }) },
            body: JSON.stringify(payload),
            signal: controller.signal,
            redirect: 'error'
        });
        const raw = await upstream.text();
        let data;
        try { data = JSON.parse(raw); } catch {}
        if (!upstream.ok) {
            const detail = typeof data?.error?.message === 'string' ? data.error.message : raw;
            return send(response, upstream.status, { error: `Relay API error ${upstream.status}: ${detail.slice(0, 2000)}` });
        }
        if (isImage) {
            if (isGemini) {
                for (const candidate of Array.isArray(data?.candidates) ? data.candidates : []) {
                    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
                        const inline = part.inlineData || part.inline_data;
                        const mime = inline?.mimeType || inline?.mime_type;
                        if (typeof inline?.data === 'string' && inline.data.trim() && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) {
                            return send(response, 200, { image: `data:${mime};base64,${inline.data}` });
                        }
                    }
                }
                return send(response, 502, { error: 'Gemini 格式接口未返回图片。请检查图片模型、接口格式和生成限制。' });
            }
            const image = data?.data?.[0];
            if (typeof image?.b64_json === 'string' && image.b64_json.trim()) {
                const mime = image.b64_json.startsWith('/9j/') ? 'image/jpeg' : image.b64_json.startsWith('UklGR') ? 'image/webp' : 'image/png';
                return send(response, 200, { image: `data:${mime};base64,${image.b64_json}` });
            }
            if (typeof image?.url === 'string') {
                try {
                    const imageUrl = new URL(image.url);
                    if (['http:', 'https:'].includes(imageUrl.protocol)) return send(response, 200, { image: imageUrl.href });
                } catch {}
            }
            return send(response, 502, { error: '图片接口未返回有效图片。请确认地址和图片模型支持 /images/generations，并返回 b64_json 或图片 URL。' });
        }
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) {
            return send(response, 502, { error: '中转站未返回有效文字。请确认地址是 API 基础地址，并且模型支持 Chat Completions 接口。' });
        }
        send(response, 200, { text });
    } catch (error) {
        const cause = (error as { cause?: { code?: string } })?.cause;
        const code = typeof cause?.code === 'string' && /^[A-Z_0-9]+$/.test(cause.code) ? ` (${cause.code})` : '';
        const message = controller.signal.aborted ? '中转站请求超时或已取消。' : `本地服务无法连接中转站${code}。请检查地址、网络、代理和证书。`;
        send(response, 502, { error: message });
    } finally {
        clearTimeout(timer);
        response.off('close', onClose);
    }
};

export const relayBridgePlugin = (): Plugin => ({
    name: 'local-relay-bridge',
    configureServer(server) { server.middlewares.use('/api/relay', relayMiddleware); },
    configurePreviewServer(server) { server.middlewares.use('/api/relay', relayMiddleware); }
});
