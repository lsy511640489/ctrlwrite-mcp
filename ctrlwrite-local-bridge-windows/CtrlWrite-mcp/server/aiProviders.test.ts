import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateWithOpenAI, validateAIConfig } from '../services/aiProviders';
import { configureAI, generateArticleContent, generateImageForArticle, testAIConnection } from '../services/geminiService';
import { imageConfiguration } from '../services/imageConfig';
import type { AIConfig } from '../types';

const relay: AIConfig = {
    provider: 'relay',
    apiKey: 'test-relay-key',
    model: 'relay-model',
    baseUrl: 'https://relay.example/custom/v1///'
};

test('relay requires a key, model and HTTP API base URL', () => {
    assert.equal(validateAIConfig(relay), null);
    assert.equal(validateAIConfig({ ...relay, apiKey: ' ' }), 'Enter an API key.');
    assert.equal(validateAIConfig({ ...relay, model: '' }), 'Enter a model name.');
    assert.equal(validateAIConfig({ ...relay, baseUrl: '' }), 'Enter the relay API base URL.');
    assert.equal(validateAIConfig({ ...relay, baseUrl: 'invalid' }), 'Enter a valid endpoint URL.');
    assert.equal(validateAIConfig({ ...relay, baseUrl: 'file:///tmp/relay' }), 'Use an HTTP or HTTPS endpoint.');
});

test('relay connection test and article generation use the configured endpoint and credentials', async context => {
    const requests: { url: string; body: any }[] = [];
    context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        requests.push({ url, body });
        return new Response(JSON.stringify({ text: requests.length === 1 ? 'OK' : 'Relay article' }), {
            headers: { 'Content-Type': 'application/json' }
        });
    });
    await testAIConnection(relay);
    configureAI(relay);
    try {
        assert.equal(await generateArticleContent('Test topic'), 'Relay article');
        assert.equal(requests.length, 2);
        for (const request of requests) {
            assert.equal(request.url, '/api/relay/text');
            assert.equal(request.body.model, 'relay-model');
            assert.equal(request.body.apiKey, relay.apiKey);
            assert.equal(request.body.baseUrl, relay.baseUrl);
            assert.equal(typeof request.body.systemPrompt, 'string');
        }
        assert.match(requests[1].body.userPrompt, /Test topic/);
    } finally {
        configureAI({ provider: 'gemini', apiKey: '' });
    }
});

test('relay surfaces API errors', async context => {
    context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'API Error 401: Invalid relay key' }), { status: 401 }));
    await assert.rejects(generateWithOpenAI('Instructions', 'Request', relay), /API Error 401: Invalid relay key/);
});

test('relay explains missing local backend and network failures', async context => {
    const fetch = context.mock.method(globalThis, 'fetch', async () => new Response('<html>Static page</html>'));
    await assert.rejects(generateWithOpenAI('Instructions', 'Request', relay), /本地中转接口不可用/);
    fetch.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(generateWithOpenAI('Instructions', 'Request', relay), /无法连接本地中转服务/);
});

test('image configuration inherits or overrides endpoint and credentials without restricting model vendor', () => {
    const config = { ...relay, imageModel: 'another-vendor-image-model' };
    assert.deepEqual(imageConfiguration(config), {
        protocol: 'openai', baseUrl: relay.baseUrl, apiKey: relay.apiKey, model: 'another-vendor-image-model'
    });
    assert.deepEqual(imageConfiguration({ ...config, imageBaseUrl: 'https://images.example/v1beta', imageApiKey: 'image-key', imageProtocol: 'gemini' }), {
        protocol: 'gemini', baseUrl: 'https://images.example/v1beta', apiKey: 'image-key', model: 'another-vendor-image-model'
    });
    assert.throws(() => imageConfiguration(relay), /图片模型名称/);
    assert.throws(() => imageConfiguration({ ...config, imageBaseUrl: 'file:///images' }), /HTTP/);
    assert.throws(() => imageConfiguration({ ...config, provider: 'codex', baseUrl: '' }), /图片 API 基础地址/);
    assert.throws(() => imageConfiguration({ ...config, provider: 'openai', baseUrl: '', imageProtocol: 'gemini' }), /图片 API 基础地址/);
    assert.equal(validateAIConfig({ ...config, imageBaseUrl: 'not-a-url' }), 'Enter a valid image API base URL.');
});

test('image generation uses independent settings for every text provider including Codex without CLI login', async context => {
    const image = 'data:image/png;base64,dGVzdA==';
    const requests: any[] = [];
    context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
        assert.equal(url, '/api/relay/image');
        const body = JSON.parse(options.body as string);
        requests.push(body);
        assert.equal(body.baseUrl, 'https://different-image-service.example/v1');
        assert.equal(body.apiKey, 'image-key');
        assert.equal(body.model, 'vendor-artist');
        assert.match(body.prompt, /User image description/);
        assert.match(body.prompt, /Article context/);
        assert.match(body.prompt, /Use blue/);
        return new Response(JSON.stringify({ image }));
    });
    try {
        for (const provider of ['relay', 'codex', 'claude', 'gemini', 'openai'] as const) {
            configureAI({ ...relay, provider, imageBaseUrl: 'https://different-image-service.example/v1', imageApiKey: 'image-key', imageModel: 'vendor-artist', imageProtocol: 'openai' });
            assert.equal(await generateImageForArticle('Title', 'Article context', async () => 'Use blue', 'User image description'), image);
        }
        assert.equal(requests.length, 5);
    } finally {
        configureAI({ provider: 'gemini', apiKey: '' });
    }
});

test('missing image configuration fails before making network requests', async context => {
    const upstream = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
    configureAI(relay);
    try {
        await assert.rejects(generateImageForArticle('Title'), /图片模型名称/);
        assert.equal(upstream.mock.callCount(), 0);
    } finally {
        configureAI({ provider: 'gemini', apiKey: '' });
    }
});
