import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { Plugin } from 'vite';
import { z } from 'zod';
import { accountSchema, AuthError, AuthStore, passwordSchema } from './authStore';
import { accessToken } from './canvasStore';
import { localWorkspace } from './workspaceContext';
import type { CodeMessage } from './codeDelivery';

export type AuthBackend = { [Key in keyof Pick<AuthStore, 'current' | 'register' | 'login' | 'loginWithCode' | 'resetPassword' | 'logout' | 'hasAccount' | 'limit' | 'issueCode' | 'removeCode'>]: (...args: Parameters<AuthStore[Key]>) => ReturnType<AuthStore[Key]> | Promise<Awaited<ReturnType<AuthStore[Key]>>> };
type Options = { directory?: string; developmentCodes?: boolean; deliveryUrl?: string; deliveryToken?: string; delivery?: { available: (channel: CodeMessage['channel']) => boolean; send: (message: CodeMessage) => Promise<void> }; secureCookies?: boolean; store?: AuthBackend; guard?: boolean; publicOrigin?: string; address?: (request: IncomingMessage) => string; cloud?: boolean; localOnly?: boolean };
const codeSchema = z.string().regex(/^\d{6}$/, '请输入 6 位数字验证码。');
const purposeSchema = z.enum(['register', 'login', 'reset']);
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const hash = (value: string) => createHash('sha256').update(value).digest();
const cookieName = 'iamtired_session';
const sessionToken = (request: IncomingMessage) => request.headers.cookie?.split(';').map(cookie => cookie.trim()).find(cookie => cookie.startsWith(cookieName + '='))?.slice(cookieName.length + 1);

function send(response: ServerResponse, status: number, data: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(data));
}

async function readBody(request: IncomingMessage) {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new AuthError(415, '请使用 JSON 格式提交。');
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        length += chunk.length;
        if (length > 8192) throw new AuthError(413, '提交的内容过长。');
        chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AuthError(400, '提交内容无法识别，请重试。'); }
}

export function createAuthMiddleware(options: Options = {}) {
    const store = options.store || new AuthStore(options.directory || path.resolve('.auth'));
    const isDevelopment = (request: IncomingMessage) => !!options.developmentCodes && loopback.has(request.socket.remoteAddress || '') && ['localhost', '127.0.0.1', '[::1]'].includes((request.headers.host || '').replace(/:\d+$/, ''));
    const setCookie = (request: IncomingMessage, response: ServerResponse, token: string, remember: boolean, clear = false) => {
        const secure = options.secureCookies || !!(request.socket as { encrypted?: boolean }).encrypted;
        response.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${clear ? '; Max-Age=0' : remember ? '; Max-Age=2592000' : ''}`);
    };
    return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
        const pathname = (request.url || '').split('?')[0];
        if (!pathname.startsWith('/api/')) return next();
        try {
            if (request.headers['sec-fetch-site'] === 'cross-site') throw new AuthError(403, '不允许跨站访问。');
            const token = sessionToken(request);
            if (!pathname.startsWith('/api/auth/')) {
                if (options.guard === false) return next();
                if (pathname.startsWith('/api/canvas-mcp/') && request.headers.authorization?.startsWith('Bearer ')) {
                    const bearer = request.headers.authorization.slice(7);
                    if (store instanceof AuthStore) {
                        const access = await store.currentMcpToken(bearer);
                        if (access) {
                            if (!access.scopes.includes(request.method === 'GET' ? 'canvas:read' : 'canvas:write')) throw new AuthError(403, '令牌没有此操作权限。');
                            return localWorkspace.run(access.user.id, next);
                        }
                    }
                    if (timingSafeEqual(hash(bearer), hash(await accessToken()))) return next();
                    throw new AuthError(401, '令牌无效或已过期。');
                }
                const user = await store.current(token);
                if (!user) throw new AuthError(401, '请先登录后再使用工作区。');
                if (request.headers['x-workspace-user'] && request.headers['x-workspace-user'] !== user.id) throw new AuthError(401, '账号已切换，请刷新当前页面。');
                if (store instanceof AuthStore && (pathname === '/api/mcp/tokens' || pathname.startsWith('/api/mcp/tokens/'))) {
                    if (![`http://${request.headers.host}`, `https://${request.headers.host}`].includes(request.headers.origin || '')) throw new AuthError(403, '请从当前网站提交请求。');
                    store.limit('mcp-tokens:' + user.id, 20, 3600);
                    if (pathname === '/api/mcp/tokens' && request.method === 'POST') {
                        const input = z.object({ scopes: z.array(z.enum(['canvas:read', 'canvas:write'])).min(1).default(['canvas:read']), days: z.number().int().min(1).max(90).default(30) }).parse(await readBody(request));
                        return send(response, 200, await store.issueMcpToken(user.id, input.scopes, input.days));
                    }
                    if (request.method === 'DELETE') {
                        await store.revokeMcpToken(user.id, z.string().regex(/^[a-f0-9]{64}$/).parse(pathname.split('/').pop()));
                        return send(response, 200, { ok: true });
                    }
                    throw new AuthError(405, '不支持此操作。');
                }
                return localWorkspace.run(user.id, next);
            }
            if (pathname === '/api/auth/session' && request.method === 'GET') return send(response, 200, { user: await store.current(token), developmentCodes: isDevelopment(request), cloud: !!options.cloud, localOnly: !!options.localOnly });
            if (request.method !== 'POST') throw new AuthError(405, '不支持此请求方式。');
            if (!request.headers.origin || !(options.publicOrigin ? [options.publicOrigin] : [`http://${request.headers.host}`, `https://${request.headers.host}`]).includes(request.headers.origin)) throw new AuthError(403, '请从当前网站提交请求。');
            const address = options.address?.(request) || request.socket.remoteAddress || 'unknown';
            await store.limit('requests:' + address, 120, 900);
            const body = await readBody(request);
            if (pathname === '/api/auth/logout') {
                await store.logout(token);
                setCookie(request, response, '', false, true);
                return send(response, 200, { ok: true });
            }
            if (pathname === '/api/auth/code') {
                const input = z.object({ account: accountSchema, purpose: purposeSchema }).parse(body);
                await store.limit('code-account:' + input.account, 1, 60);
                await store.limit('codes:' + address, 12, 3600);
                const development = isDevelopment(request);
                const channel = input.account.includes('@') ? 'email' : 'sms';
                const builtInDelivery = options.delivery?.available(channel);
                if (!development && !builtInDelivery && !options.deliveryUrl) throw new AuthError(503, `${channel === 'email' ? '邮箱' : '短信'}验证码发送服务尚未配置，请联系管理员。`);
                if (!development && !builtInDelivery && options.deliveryUrl && new URL(options.deliveryUrl).protocol !== 'https:') throw new AuthError(503, '验证码发送服务需要使用 HTTPS。');
                const exists = await store.hasAccount(input.account);
                const eligible = input.purpose === 'register' ? !exists : exists;
                let code: string | undefined;
                if (eligible) {
                    code = await store.issueCode(input.account, input.purpose);
                    if (!development) {
                        try {
                            const message: CodeMessage = { recipient: input.account, channel, purpose: input.purpose, code, expiresIn: 300 };
                            if (builtInDelivery) await options.delivery!.send(message);
                            else {
                                const delivery = await fetch(options.deliveryUrl!, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.deliveryToken ? { Authorization: 'Bearer ' + options.deliveryToken } : {}) }, body: JSON.stringify(message), signal: AbortSignal.timeout(15000), redirect: 'error' });
                                if (!delivery.ok) throw new Error('Delivery failed');
                            }
                        } catch {
                            await store.removeCode(input.account, input.purpose);
                            throw new AuthError(502, '验证码发送失败，请稍后重试。');
                        }
                    }
                }
                return send(response, 200, { ok: true, retryAfter: 60, message: '如账号符合条件，验证码将发送至该邮箱或手机，5 分钟内有效。', ...(development && code ? { developmentCode: code } : {}) });
            }
            if (pathname === '/api/auth/register') {
                const input = z.object({ account: accountSchema, name: z.string().trim().min(2, '昵称至少需要 2 个字符。').max(32, '昵称不能超过 32 个字符。'), password: passwordSchema, code: codeSchema }).parse(body);
                await store.limit('register:' + address, 10, 900);
                const result = await store.register(input.account, input.name, input.password, input.code, token);
                setCookie(request, response, result.token, false);
                return send(response, 201, { user: result.user });
            }
            if (pathname === '/api/auth/login' || pathname === '/api/auth/phone-login') {
                const input = z.object({ account: accountSchema, password: z.string().min(1).max(128).optional(), code: codeSchema.optional(), remember: z.boolean().default(false) }).parse(body);
                await store.limit('login:' + address + ':' + input.account, 10, 900);
                await store.limit('logins:' + address, 40, 900);
                const result = pathname.endsWith('/phone-login')
                    ? await store.loginWithCode(z.string().regex(/^\+[1-9]\d{7,14}$/, '请输入有效的手机号。').parse(input.account), codeSchema.parse(input.code), input.remember, token)
                    : await store.login(input.account, z.string().min(1, '请输入密码。').max(128).parse(input.password), input.remember, token);
                setCookie(request, response, result.token, input.remember);
                return send(response, 200, { user: result.user });
            }
            if (pathname === '/api/auth/reset-password') {
                const input = z.object({ account: accountSchema, code: codeSchema, password: passwordSchema }).parse(body);
                await store.limit('reset:' + address, 10, 900);
                await store.resetPassword(input.account, input.code, input.password);
                setCookie(request, response, '', false, true);
                return send(response, 200, { ok: true });
            }
            throw new AuthError(404, '此账号接口不存在。');
        } catch (error) {
            if (error instanceof z.ZodError) return send(response, 400, { error: error.issues[0]?.message || '请检查输入内容。' });
            if (error instanceof AuthError) {
                if (error.retryAfter) response.setHeader('Retry-After', error.retryAfter);
                return send(response, error.status, { error: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
            }
            console.error('[auth]', error instanceof Error ? error.message : 'Unknown error');
            return send(response, 500, { error: '账号服务暂时不可用，请稍后重试。' });
        }
    };
}

export const authBridgePlugin = (options: Options = {}): Plugin => ({
    name: 'local-auth-bridge',
    configureServer(server) { server.middlewares.use(createAuthMiddleware({ ...options, developmentCodes: options.developmentCodes ?? !server.config.isProduction })); },
    configurePreviewServer(server) { server.middlewares.use(createAuthMiddleware({ ...options, developmentCodes: false })); }
});
