import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export type AuthUser = { id: string; name: string; email?: string; phone?: string; createdAt: string };
type StoredUser = AuthUser & { password: string };
type Session = { hash: string; userId: string; expiresAt: number };
type McpToken = Session & { scopes: string[] };
type Challenge = { hash: string; salt: string; expiresAt: number; attempts: number };
type Purpose = 'register' | 'login' | 'reset';
type State = { users: StoredUser[]; sessions: Session[]; mcpTokens: McpToken[] };

export class AuthError extends Error {
    constructor(public status: number, message: string, public retryAfter?: number) { super(message); }
}

export const accountSchema = z.string().trim().max(254).transform(value => /^1[3-9]\d{9}$/.test(value) ? '+86' + value : value.toLowerCase())
    .refine(value => z.email().safeParse(value).success || /^\+[1-9]\d{7,14}$/.test(value), '请输入有效的邮箱或含国家区号的手机号。');
export const passwordSchema = z.string().min(8, '密码至少需要 8 个字符。').max(128, '密码不能超过 128 个字符。');
const stateSchema = z.object({ users: z.array(z.object({ id: z.string(), name: z.string(), email: z.string().optional(), phone: z.string().optional(), createdAt: z.string(), password: z.string() })), sessions: z.array(z.object({ hash: z.string(), userId: z.string(), expiresAt: z.number() })), mcpTokens: z.array(z.object({ hash: z.string(), userId: z.string(), expiresAt: z.number(), scopes: z.array(z.string()) })).default([]) });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const publicUser = ({ password, ...user }: StoredUser): AuthUser => user;

export async function passwordHash(password: string, salt = randomBytes(16).toString('hex')) {
    const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
    return salt + ':' + key.toString('hex');
}

export class AuthStore {
    private pending: Promise<unknown> = Promise.resolve();
    private challenges = new Map<string, Challenge>();
    private limits = new Map<string, { count: number; expiresAt: number }>();
    private dummyPassword = passwordHash(randomBytes(32).toString('hex'));
    constructor(private directory: string) {}

    private async read(): Promise<State> {
        try { return stateSchema.parse(JSON.parse(await readFile(path.join(this.directory, 'accounts.json'), 'utf8'))); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { users: [], sessions: [], mcpTokens: [] };
            throw error;
        }
    }

    private async write(state: State) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(this.directory, randomUUID() + '.tmp');
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await rename(temporary, path.join(this.directory, 'accounts.json'));
    }

    private serialize<T>(action: () => Promise<T>): Promise<T> {
        const result = this.pending.then(action);
        this.pending = result.catch(() => undefined);
        return result;
    }

    limit(key: string, maximum: number, seconds: number) {
        const now = Date.now();
        for (const [entryKey, entry] of this.limits) if (entry.expiresAt <= now) this.limits.delete(entryKey);
        const entry = this.limits.get(key) || { count: 0, expiresAt: now + seconds * 1000 };
        if (entry.count >= maximum) throw new AuthError(429, '操作过于频繁，请稍后再试。', Math.ceil((entry.expiresAt - now) / 1000));
        if (!this.limits.has(key) && this.limits.size >= 10000) throw new AuthError(429, '请求较多，请稍后再试。', 60);
        entry.count++;
        this.limits.set(key, entry);
    }

    private find(state: State, account: string) { return state.users.find(user => user.email === account || user.phone === account); }
    async hasAccount(account: string) { return !!this.find(await this.read(), account); }

    issueCode(account: string, purpose: Purpose) {
        const now = Date.now();
        for (const [key, entry] of this.challenges) if (entry.expiresAt <= now) this.challenges.delete(key);
        const key = purpose + ':' + account;
        if (this.challenges.size >= 5000 && !this.challenges.has(key)) throw new AuthError(429, '请求较多，请稍后再试。', 60);
        const code = randomInt(0, 1000000).toString().padStart(6, '0');
        const salt = randomBytes(16).toString('hex');
        this.challenges.set(key, { hash: digest(salt + code), salt, expiresAt: now + 300000, attempts: 0 });
        return code;
    }

    removeCode(account: string, purpose: Purpose) { this.challenges.delete(purpose + ':' + account); }

    private verifyCode(account: string, purpose: Purpose, code: string) {
        const key = purpose + ':' + account;
        const challenge = this.challenges.get(key);
        if (!challenge || challenge.expiresAt <= Date.now() || challenge.attempts >= 5) throw new AuthError(400, '验证码无效或已过期，请重新获取。');
        challenge.attempts++;
        if (!timingSafeEqual(Buffer.from(challenge.hash, 'hex'), Buffer.from(digest(challenge.salt + code), 'hex'))) throw new AuthError(400, '验证码错误，请重新输入。');
        this.challenges.delete(key);
    }

    private session(state: State, user: StoredUser, remember: boolean, previousToken?: string) {
        const token = randomBytes(32).toString('base64url');
        const now = Date.now();
        state.sessions = state.sessions.filter(entry => entry.expiresAt > now && entry.hash !== digest(previousToken || ''));
        const userSessions = state.sessions.filter(entry => entry.userId === user.id);
        if (userSessions.length >= 10) {
            const removed = new Set(userSessions.slice(0, userSessions.length - 9).map(entry => entry.hash));
            state.sessions = state.sessions.filter(entry => !removed.has(entry.hash));
        }
        state.sessions.push({ hash: digest(token), userId: user.id, expiresAt: now + (remember ? 30 * 24 : 12) * 3600000 });
        return { user: publicUser(user), token };
    }

    async current(token: string | undefined): Promise<AuthUser | null> {
        if (!token || token.length > 100) return null;
        await this.pending;
        const state = await this.read();
        const session = state.sessions.find(entry => entry.hash === digest(token) && entry.expiresAt > Date.now());
        const user = session && state.users.find(entry => entry.id === session.userId);
        return user ? publicUser(user) : null;
    }

    register(account: string, name: string, password: string, code: string, previousToken?: string) {
        return this.serialize(async () => {
            this.verifyCode(account, 'register', code);
            const state = await this.read();
            if (this.find(state, account)) throw new AuthError(409, '该账号已注册，请直接登录。');
            const user: StoredUser = { id: randomUUID(), name, createdAt: new Date().toISOString(), password: await passwordHash(password), ...(account.includes('@') ? { email: account } : { phone: account }) };
            state.users.push(user);
            const session = this.session(state, user, false, previousToken);
            await this.write(state);
            return session;
        });
    }

    login(account: string, password: string, remember: boolean, previousToken?: string) {
        return this.serialize(async () => {
            const state = await this.read();
            const user = this.find(state, account);
            const expected = user?.password || await this.dummyPassword;
            const [salt] = expected.split(':');
            const actual = await passwordHash(password, salt);
            if (!timingSafeEqual(Buffer.from(expected), Buffer.from(actual)) || !user) throw new AuthError(401, '账号或密码错误，请检查后重试。');
            const session = this.session(state, user, remember, previousToken);
            await this.write(state);
            return session;
        });
    }

    loginWithCode(account: string, code: string, remember: boolean, previousToken?: string) {
        return this.serialize(async () => {
            this.verifyCode(account, 'login', code);
            const state = await this.read();
            const user = this.find(state, account);
            if (!user) throw new AuthError(401, '该手机号尚未注册，请先创建账号。');
            const session = this.session(state, user, remember, previousToken);
            await this.write(state);
            return session;
        });
    }

    resetPassword(account: string, code: string, password: string) {
        return this.serialize(async () => {
            this.verifyCode(account, 'reset', code);
            const state = await this.read();
            const user = this.find(state, account);
            if (!user) throw new AuthError(400, '无法重置此账号，请确认账号或重新获取验证码。');
            user.password = await passwordHash(password);
            state.sessions = state.sessions.filter(entry => entry.userId !== user.id);
            state.mcpTokens = state.mcpTokens.filter(entry => entry.userId !== user.id);
            await this.write(state);
        });
    }

    issueMcpToken(userId: string, scopes: string[], days: number) {
        return this.serialize(async () => {
            const state = await this.read();
            if (!state.users.some(user => user.id === userId)) throw new AuthError(401, '请先登录。');
            const token = userId + '.' + randomBytes(32).toString('base64url');
            const expiresAt = Date.now() + days * 86400000;
            state.mcpTokens = state.mcpTokens.filter(entry => entry.expiresAt > Date.now());
            state.mcpTokens.push({ hash: digest(token), userId, scopes, expiresAt });
            await this.write(state);
            return { token, id: digest(token), expiresAt: new Date(expiresAt).toISOString() };
        });
    }

    async currentMcpToken(token: string) {
        if (token.length > 150) return null;
        await this.pending;
        const state = await this.read();
        const entry = state.mcpTokens.find(item => item.hash === digest(token) && item.expiresAt > Date.now());
        const user = entry && state.users.find(item => item.id === entry.userId);
        return entry && user ? { user: publicUser(user), scopes: entry.scopes } : null;
    }

    revokeMcpToken(userId: string, hash: string) {
        return this.serialize(async () => {
            const state = await this.read();
            state.mcpTokens = state.mcpTokens.filter(entry => entry.userId !== userId || entry.hash !== hash);
            await this.write(state);
        });
    }

    logout(token?: string) {
        return this.serialize(async () => {
            const state = await this.read();
            state.sessions = state.sessions.filter(entry => entry.hash !== digest(token || '') && entry.expiresAt > Date.now());
            await this.write(state);
        });
    }
}
