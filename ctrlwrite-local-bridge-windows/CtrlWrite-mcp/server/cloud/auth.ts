import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { AuthError, passwordHash, type AuthUser } from '../authStore';
import { digest } from './crypto';
import { tenantTransaction } from './database';

type Purpose = 'register' | 'login' | 'reset';
type UserRow = { id: string; name: string; email: string | null; phone: string | null; password_hash: string; auth_version: number; created_at: Date };
const publicUser = (row: UserRow): AuthUser => ({ id: row.id, name: row.name, ...(row.email ? { email: row.email } : {}), ...(row.phone ? { phone: row.phone } : {}), createdAt: row.created_at.toISOString() });
const challengeKey = (account: string, purpose: Purpose) => 'auth:code:' + digest(purpose + ':' + account);

export class CloudAuthStore {
    private dummy = passwordHash(randomBytes(32).toString('hex'));
    constructor(private pool: Pool, private redis: RedisClientType) {}

    async limit(key: string, maximum: number, seconds: number) {
        const result = await this.redis.eval("local count=redis.call('INCR',KEYS[1]); if count==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return {count,redis.call('TTL',KEYS[1])}", { keys: ['auth:limit:' + digest(key)], arguments: [String(seconds)] }) as number[];
        if (Number(result[0]) > maximum) throw new AuthError(429, '操作过于频繁，请稍后再试。', Math.max(1, Number(result[1])));
    }

    async hasAccount(account: string) { return !!(await this.pool.query('SELECT 1 FROM users WHERE email=$1 OR phone=$1', [account])).rowCount; }

    async issueCode(account: string, purpose: Purpose) {
        const code = randomInt(0, 1000000).toString().padStart(6, '0');
        const salt = randomBytes(16).toString('hex');
        await this.redis.eval("redis.call('HSET',KEYS[1],'salt',ARGV[1],'hash',ARGV[2],'attempts',0); redis.call('EXPIRE',KEYS[1],300); return 1", { keys: [challengeKey(account, purpose)], arguments: [salt, digest(salt + code)] });
        return code;
    }

    async removeCode(account: string, purpose: Purpose) { await this.redis.del(challengeKey(account, purpose)); }

    private async verify(account: string, purpose: Purpose, code: string) {
        const key = challengeKey(account, purpose);
        const salt = await this.redis.hGet(key, 'salt');
        if (typeof salt !== 'string') throw new AuthError(400, '验证码无效或已过期。');
        const result = await this.redis.eval("local values=redis.call('HMGET',KEYS[1],'salt','hash','attempts'); if not values[1] or values[1]~=ARGV[1] or tonumber(values[3])>=5 then return 0 end; redis.call('HINCRBY',KEYS[1],'attempts',1); if values[2]==ARGV[2] then redis.call('DEL',KEYS[1]); return 1 end; return 0", { keys: [key], arguments: [salt, digest(salt + code)] });
        if (Number(result) !== 1) throw new AuthError(400, '验证码错误或已过期。');
    }

    private async session(user: UserRow, remember: boolean, previous?: string) {
        const token = randomBytes(32).toString('base64url');
        const session = JSON.stringify({ userId: user.id, version: user.auth_version });
        await this.redis.set('auth:session:' + digest(token), session, { EX: (remember ? 30 * 24 : 12) * 3600 });
        if (previous) await this.logout(previous);
        return { user: publicUser(user), token };
    }

    async current(token?: string): Promise<AuthUser | null> {
        if (!token || token.length > 100) return null;
        const value = await this.redis.get('auth:session:' + digest(token));
        if (typeof value !== 'string') return null;
        const session = JSON.parse(value);
        const { rows } = await this.pool.query('SELECT * FROM users WHERE id=$1 AND auth_version=$2', [session.userId, session.version]);
        return rows[0] ? publicUser(rows[0]) : null;
    }

    async register(account: string, name: string, password: string, code: string, previous?: string) {
        await this.verify(account, 'register', code);
        const userId = randomUUID();
        const passwordValue = await passwordHash(password);
        let user: UserRow;
        try {
            user = await tenantTransaction(this.pool, userId, async client => {
                const { rows } = await client.query('INSERT INTO users(id,name,email,phone,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING *', [userId, name, account.includes('@') ? account : null, account.includes('@') ? null : account, passwordValue]);
                const workspaceId = randomUUID();
                await client.query('INSERT INTO workspaces(id,owner_id) VALUES($1,$2)', [workspaceId, userId]);
                await client.query('INSERT INTO audit_logs(workspace_id,action) VALUES($1,$2)', [workspaceId, 'account.register']);
                return rows[0];
            });
        } catch (error) {
            if ((error as { code?: string }).code === '23505') throw new AuthError(409, '该账号已注册。');
            throw error;
        }
        return this.session(user, false, previous);
    }

    async login(account: string, password: string, remember: boolean, previous?: string) {
        const { rows } = await this.pool.query('SELECT * FROM users WHERE email=$1 OR phone=$1', [account]);
        const user: UserRow | undefined = rows[0];
        const expected = user?.password_hash || await this.dummy;
        const actual = await passwordHash(password, expected.split(':')[0]);
        if (!timingSafeEqual(Buffer.from(expected), Buffer.from(actual)) || !user) throw new AuthError(401, '账号或密码错误。');
        return this.session(user, remember, previous);
    }

    async loginWithCode(account: string, code: string, remember: boolean, previous?: string) {
        await this.verify(account, 'login', code);
        const { rows } = await this.pool.query('SELECT * FROM users WHERE phone=$1', [account]);
        if (!rows[0]) throw new AuthError(401, '该手机号尚未注册。');
        return this.session(rows[0], remember, previous);
    }

    async resetPassword(account: string, code: string, password: string) {
        await this.verify(account, 'reset', code);
        const result = await this.pool.query('UPDATE users SET password_hash=$2,auth_version=auth_version+1 WHERE email=$1 OR phone=$1 RETURNING id', [account, await passwordHash(password)]);
        if (!result.rowCount) throw new AuthError(400, '账号不存在。');
        await tenantTransaction(this.pool, result.rows[0].id, client => client.query('DELETE FROM mcp_tokens'));
    }

    async logout(token?: string) { if (token) await this.redis.del('auth:session:' + digest(token)); }
}
