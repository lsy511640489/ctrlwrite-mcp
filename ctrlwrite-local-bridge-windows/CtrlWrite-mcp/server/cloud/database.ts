import { Pool, type PoolClient } from 'pg';
import { AuthError } from '../authStore';
import { cleanCanvas, validateCanvas } from '../canvasModel';
import type { TabState } from '../../types/tabTypes';

export function createPool(connectionString: string) {
    if (!connectionString) throw new Error('DATABASE_URL is required.');
    return new Pool({ connectionString, max: 12, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 30000 });
}

export async function assertRestrictedRole(pool: Pool) {
    const { rows } = await pool.query("SELECT rolsuper, rolbypassrls, EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename IN ('workspaces','canvases','settings','assets','jobs','library','mcp_tokens','audit_logs') AND tableowner=current_user) AS owns_tables FROM pg_roles WHERE rolname=current_user");
    if (!rows[0] || rows[0].rolsuper || rows[0].rolbypassrls || rows[0].owns_tables) throw new Error('Runtime database role must not own tenant tables, be superuser, or bypass RLS. Run db:migrate with separate admin credentials.');
}

export async function tenantTransaction<T>(pool: Pool, userId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        const result = await action(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}

export async function workspaceFor(pool: Pool, userId: string) {
    return tenantTransaction(pool, userId, async client => {
        const { rows } = await client.query('SELECT id FROM workspaces WHERE owner_id=$1', [userId]);
        if (!rows[0]) throw new AuthError(404, '工作区不存在。');
        return rows[0].id as string;
    });
}

export async function readCloudCanvas(client: PoolClient, workspaceId: string) {
    const { rows } = await client.query('SELECT revision, document FROM canvases WHERE workspace_id=$1', [workspaceId]);
    return rows[0]?.document ? { revision: Number(rows[0].revision), state: validateCanvas(rows[0].document) } : null;
}

export async function changeCloudCanvas(client: PoolClient, workspaceId: string, revision: number, change: (state: TabState | null) => TabState) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new AuthError(400, '无效的画布版本。');
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
    const current = await readCloudCanvas(client, workspaceId);
    if ((current?.revision || 0) !== revision) throw new AuthError(409, '画布已在其他页面修改，请先导出本页内容，再刷新页面。');
    let state: TabState;
    try { state = cleanCanvas(validateCanvas(change(current?.state || null))); }
    catch (error) { throw new AuthError(400, error instanceof Error ? error.message : '画布内容无效。'); }
    await client.query('INSERT INTO canvases(workspace_id,revision,document) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET revision=EXCLUDED.revision,document=EXCLUDED.document,updated_at=now()', [workspaceId, revision + 1, JSON.stringify(state)]);
    return { revision: revision + 1, state };
}
