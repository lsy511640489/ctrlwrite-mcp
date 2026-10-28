import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAuthMiddleware } from './authBridge';
import { AuthError, AuthStore } from './authStore';
import type { CodeMessage } from './codeDelivery';

const password = 'My-Creative-Canvas-2026!';

async function withServer(run: (context: { directory: string; request: (action: string, body?: unknown, cookie?: string, origin?: string) => Promise<{ response: Response; data: any; cookie: string }> }) => Promise<void>, developmentCodes = true, delivery?: { available: (channel: CodeMessage['channel']) => boolean; send: (message: CodeMessage) => Promise<void> }) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'iamtired-auth-test-'));
    const middleware = createAuthMiddleware({ directory, developmentCodes, delivery });
    const server = createServer((request, response) => { void middleware(request, response, () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"protected":true}'); }); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
        await run({ directory, request: async (action, body, cookie, origin = base) => {
            const response = await fetch(base + (action.startsWith('/api/') ? action : '/api/auth/' + action), { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            return { response, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
        } });
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('iamtired-auth-test-'));
        await rm(directory, { recursive: true, force: true });
    }
}

async function seed(directory: string, account: string) {
    const store = new AuthStore(directory);
    const code = store.issueCode(account, 'register');
    return store.register(account, '测试用户', password, code);
}

test('verified registration, remembered password login, session persistence and logout protect workspace APIs', async () => withServer(async ({ directory, request }) => {
    assert.equal((await request('/api/workspace')).response.status, 401);
    const sent = await request('code', { account: 'reader@example.com', purpose: 'register' });
    assert.match(sent.data.developmentCode, /^\d{6}$/);
    const registered = await request('register', { account: 'Reader@Example.com', name: '阅读者', password, code: sent.data.developmentCode });
    assert.equal(registered.response.status, 201);
    assert.equal(registered.data.user.email, 'reader@example.com');
    assert.equal(registered.data.user.password, undefined);
    assert.match(registered.response.headers.get('set-cookie') || '', /HttpOnly; SameSite=Strict/);
    assert.equal((await request('/api/workspace', undefined, registered.cookie)).data.protected, true);
    const stored = await readFile(path.join(directory, 'accounts.json'), 'utf8');
    assert.equal(stored.includes(password), false);
    assert.equal(stored.includes(registered.cookie.split('=')[1]), false);
    const restored = await new AuthStore(directory).current(registered.cookie.split('=')[1]);
    assert.equal(restored?.id, registered.data.user.id);
    const unknown = await request('login', { account: 'unknown@example.com', password: 'incorrect' });
    const wrong = await request('login', { account: 'reader@example.com', password: 'incorrect' });
    assert.equal(wrong.response.status, 401);
    assert.equal(unknown.data.error, wrong.data.error);
    const loggedIn = await request('login', { account: 'reader@example.com', password, remember: true });
    assert.equal(loggedIn.response.status, 200);
    assert.match(loggedIn.response.headers.get('set-cookie') || '', /Max-Age=2592000/);
    assert.equal((await request('session', undefined, loggedIn.cookie)).data.user.name, '阅读者');
    await request('logout', {}, loggedIn.cookie);
    assert.equal((await request('session', undefined, loggedIn.cookie)).data.user, null);
    assert.equal((await request('/api/workspace', undefined, loggedIn.cookie)).response.status, 401);
}));

test('phone codes work once, are purpose-bound, and enforce resend cooldown', async () => withServer(async ({ directory, request }) => {
    await seed(directory, '+8613812345678');
    const sent = await request('code', { account: '13812345678', purpose: 'login' });
    assert.match(sent.data.developmentCode, /^\d{6}$/);
    const wrongPurpose = await request('reset-password', { account: '+8613812345678', code: sent.data.developmentCode, password: 'Another-Password-2026' });
    assert.equal(wrongPurpose.response.status, 400);
    const loggedIn = await request('phone-login', { account: '+8613812345678', code: sent.data.developmentCode });
    assert.equal(loggedIn.response.status, 200);
    assert.equal(loggedIn.data.user.phone, '+8613812345678');
    assert.equal((await request('phone-login', { account: '+8613812345678', code: sent.data.developmentCode })).response.status, 400);
    const resend = await request('code', { account: '+8613812345678', purpose: 'reset' });
    assert.equal(resend.response.status, 429);
    assert.ok(Number(resend.response.headers.get('retry-after')) > 0);
}));

test('password reset invalidates every existing session and only accepts the new password', async () => withServer(async ({ directory, request }) => {
    const initial = await seed(directory, 'recover@example.com');
    const extra = await request('login', { account: 'recover@example.com', password });
    const sent = await request('code', { account: 'recover@example.com', purpose: 'reset' });
    const changed = await request('reset-password', { account: 'recover@example.com', code: sent.data.developmentCode, password: 'New-Secret-2026!' });
    assert.equal(changed.response.status, 200);
    assert.equal((await request('session', undefined, 'iamtired_session=' + initial.token)).data.user, null);
    assert.equal((await request('session', undefined, extra.cookie)).data.user, null);
    assert.equal((await request('login', { account: 'recover@example.com', password })).response.status, 401);
    assert.equal((await request('login', { account: 'recover@example.com', password: 'New-Secret-2026!' })).response.status, 200);
}));

test('cross-origin, invalid input and oversized requests are rejected', async () => withServer(async ({ request }) => {
    assert.equal((await request('login', { account: 'reader@example.com', password }, undefined, 'https://untrusted.example')).response.status, 403);
    assert.equal((await request('register', { account: 'not-an-email', name: '名字', password: 'short', code: '123456' })).response.status, 400);
    assert.equal((await request('login', { payload: 'x'.repeat(9000) })).response.status, 413);
    assert.equal((await request('phone-login', { account: 'reader@example.com', code: '123456' })).response.status, 400);
    assert.equal((await request('session')).response.headers.get('cache-control'), 'no-store');
}));

test('production mode never returns test codes and refuses an unconfigured delivery service', async () => withServer(async ({ request }) => {
    assert.equal((await request('session')).data.developmentCodes, false);
    const result = await request('code', { account: 'reader@example.com', purpose: 'register' });
    assert.equal(result.response.status, 503);
    assert.equal(result.data.developmentCode, undefined);
}, false));

test('production codes use the matching delivery channel without exposing the code', async () => {
    const sent: CodeMessage[] = [];
    await withServer(async ({ request }) => {
        const email = await request('code', { account: 'reader@example.com', purpose: 'register' });
        const phone = await request('code', { account: '13812345678', purpose: 'register' });
        assert.equal(email.response.status, 200);
        assert.equal(phone.response.status, 200);
        assert.equal(email.data.developmentCode, undefined);
        assert.deepEqual(sent.map(message => [message.channel, message.recipient, message.expiresIn]), [
            ['email', 'reader@example.com', 300], ['sms', '+8613812345678', 300]
        ]);
        assert.equal((await request('register', { account: 'reader@example.com', name: '邮箱用户', password, code: sent[0].code })).response.status, 201);
        assert.equal((await request('register', { account: '13812345678', name: '手机用户', password, code: sent[1].code })).response.status, 201);
    }, false, { available: () => true, send: async message => { sent.push(message); } });
});

test('production rejects an unavailable channel and invalidates a failed delivery', async () => {
    let failedCode = '';
    await withServer(async ({ request }) => {
        const missing = await request('code', { account: '13812345678', purpose: 'register' });
        assert.equal(missing.response.status, 503);
        assert.match(missing.data.error, /短信/);
        const failed = await request('code', { account: 'fail@example.com', purpose: 'register' });
        assert.equal(failed.response.status, 502);
        assert.equal((await request('register', { account: 'fail@example.com', name: '失败用户', password, code: failedCode })).response.status, 400);
    }, false, { available: channel => channel === 'email', send: async message => { failedCode = message.code; throw new Error('provider failed'); } });
});

test('five incorrect attempts exhaust a challenge even when the next code is correct', async () => withServer(async ({ directory }) => {
    const store = new AuthStore(directory);
    const code = store.issueCode('attempt@example.com', 'register');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(store.register('attempt@example.com', '测试者', password, wrong), AuthError);
    await assert.rejects(store.register('attempt@example.com', '测试者', password, code), /无效或已过期/);
}));

test('password guessing is rate limited', async () => withServer(async ({ request }) => {
    for (let attempt = 0; attempt < 10; attempt++) assert.equal((await request('login', { account: 'guess@example.com', password: 'incorrect' })).response.status, 401);
    assert.equal((await request('login', { account: 'guess@example.com', password: 'incorrect' })).response.status, 429);
}));

test('verification codes expire after five minutes and unremembered sessions after twelve hours', async context => withServer(async ({ directory }) => {
    const store = new AuthStore(directory);
    const started = Date.now();
    const code = store.issueCode('expired@example.com', 'register');
    const clock = context.mock.method(Date, 'now', () => started + 300001);
    await assert.rejects(store.register('expired@example.com', '测试者', password, code), /无效或已过期/);
    clock.mock.restore();
    const valid = store.issueCode('session@example.com', 'register');
    const session = await store.register('session@example.com', '测试者', password, valid);
    context.mock.method(Date, 'now', () => started + 12 * 3600000 + 60000);
    assert.equal(await store.current(session.token), null);
}));
