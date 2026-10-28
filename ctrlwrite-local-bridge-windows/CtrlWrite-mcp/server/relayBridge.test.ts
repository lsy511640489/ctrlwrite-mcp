import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { relayMiddleware } from './relayBridge';

test('local relay forwards requests and returns actionable upstream errors', async context => {
    const server = createServer((incoming, response) => { void relayMiddleware(incoming, response); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing relay test port.');
    const origin = `http://127.0.0.1:${address.port}`;
    const payload = { baseUrl: 'https://relay.example/custom/v1///', apiKey: 'test-key', model: 'test-model', systemPrompt: 'Instructions', userPrompt: 'Hello' };
    const call = (body: unknown = payload, suppliedOrigin = origin, operation = 'text') => new Promise<{ status: number; data: any }>((resolve, reject) => {
        const outgoing = request(`${origin}/${operation}`, { method: 'POST', agent: false, headers: {
            'Content-Type': 'application/json', Origin: suppliedOrigin
        } }, response => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode!, data: JSON.parse(text) }));
            response.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end(JSON.stringify(body));
    });
    try {
        await context.test('forwards credentials and prompts without browser CORS', async child => {
            const upstream = child.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
                assert.equal(url, 'https://relay.example/custom/v1/chat/completions');
                assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer test-key');
                assert.deepEqual(JSON.parse(options.body as string), { model: 'test-model', messages: [
                    { role: 'system', content: 'Instructions' }, { role: 'user', content: 'Hello' }
                ] });
                return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello back' } }] }));
            });
            assert.deepEqual(await call(), { status: 200, data: { text: 'Hello back' } });
            assert.equal(upstream.mock.callCount(), 1);
        });
        await context.test('rejects foreign origins and invalid settings before contacting upstream', async child => {
            const upstream = child.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected upstream request'); });
            assert.equal((await call(payload, 'https://foreign.example')).status, 403);
            assert.equal((await call({ ...payload, baseUrl: 'file:///tmp' })).status, 400);
            assert.equal((await call(null)).status, 400);
            assert.equal(upstream.mock.callCount(), 0);
        });
        await context.test('preserves upstream HTTP error details', async child => {
            child.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Invalid key' } }), { status: 401 }));
            assert.deepEqual(await call(), { status: 401, data: { error: 'Relay API error 401: Invalid key' } });
        });
        await context.test('reports DNS failures without returning credentials', async child => {
            child.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); });
            const result = await call();
            assert.equal(result.status, 502);
            assert.match(result.data.error, /ENOTFOUND/);
            assert.equal(result.data.error.includes('test-key'), false);
        });
        await context.test('explains an HTML page returned instead of an API response', async child => {
            child.mock.method(globalThis, 'fetch', async () => new Response('<html>Home page</html>'));
            const result = await call();
            assert.equal(result.status, 502);
            assert.match(result.data.error, /Chat Completions/);
        });
        const imagePayload = { baseUrl: 'https://image-relay.example/custom/v1/', apiKey: 'image-key', model: 'other-vendor-artist', prompt: 'Draw a tree', protocol: 'openai' };
        await context.test('images use the configured relay endpoint, vendor model and separate key', async child => {
            child.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
                assert.equal(url, 'https://image-relay.example/custom/v1/images/generations');
                assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer image-key');
                assert.deepEqual(JSON.parse(options.body as string), { model: 'other-vendor-artist', prompt: 'Draw a tree', n: 1, size: '1024x1024' });
                return new Response(JSON.stringify({ data: [{ b64_json: 'dGVzdA==' }] }));
            });
            assert.deepEqual(await call(imagePayload, origin, 'image'), { status: 200, data: { image: 'data:image/png;base64,dGVzdA==' } });
        });
        await context.test('images also accept HTTP image URLs', async child => {
            child.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] })));
            assert.deepEqual(await call(imagePayload, origin, 'image'), { status: 200, data: { image: 'https://cdn.example/image.png' } });
        });
        await context.test('Gemini native image requests use their own path, authentication and response format', async child => {
            child.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
                assert.equal(url, 'https://gemini-relay.example/v1beta/models/vendor-image-model:generateContent');
                assert.equal(new Headers(options.headers).get('x-goog-api-key'), 'image-key');
                assert.equal(new Headers(options.headers).has('Authorization'), false);
                assert.deepEqual(JSON.parse(options.body as string), { contents: [{ parts: [{ text: 'Draw a tree' }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
                return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Here is an image' }, { inlineData: { mimeType: 'image/jpeg', data: '/9j/test' } }] } }] }));
            });
            assert.deepEqual(await call({ ...imagePayload, protocol: 'gemini', baseUrl: 'https://gemini-relay.example/v1beta', model: 'models/vendor-image-model' }, origin, 'image'), {
                status: 200, data: { image: 'data:image/jpeg;base64,/9j/test' }
            });
        });
        await context.test('image errors are reported instead of silently clearing the image', async child => {
            const upstream = child.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Unsupported image model' } }), { status: 400 }));
            assert.match((await call(imagePayload, origin, 'image')).data.error, /Unsupported image model/);
            upstream.mock.mockImplementation(async () => new Response(JSON.stringify({ data: [{ url: 'javascript:alert(1)' }] })));
            assert.equal((await call(imagePayload, origin, 'image')).status, 502);
            upstream.mock.mockImplementation(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'No image generated' }] } }] })));
            assert.equal((await call({ ...imagePayload, protocol: 'gemini' }, origin, 'image')).status, 502);
            assert.equal((await call({ ...imagePayload, protocol: 'unsupported' }, origin, 'image')).status, 400);
        });
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
