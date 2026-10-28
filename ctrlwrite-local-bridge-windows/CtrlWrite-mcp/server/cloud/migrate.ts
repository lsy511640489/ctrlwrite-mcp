import { readFile } from 'node:fs/promises';
import { createPool } from './database';

const admin = createPool(process.env.DATABASE_ADMIN_URL || '');
const runtime = createPool(process.env.DATABASE_URL || '');
try {
    const role = (await runtime.query('SELECT current_user AS name')).rows[0].name as string;
    const adminRole = (await admin.query('SELECT current_user AS name')).rows[0].name;
    if (role === adminRole) throw new Error('Use separate migration and runtime database roles.');
    const client = await admin.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ctrlwrite.schema.v1'))");
        await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
        const quoted = '"' + role.replace(/"/g, '""') + '"';
        await client.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
        await client.query(`REVOKE SELECT,INSERT,UPDATE,DELETE ON canvases,settings,assets,library,jobs,mcp_tokens FROM ${quoted}`);
        await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON users,workspaces,audit_logs TO ${quoted}`);
        await client.query(`GRANT USAGE,SELECT ON SEQUENCE audit_logs_id_seq TO ${quoted}`);
        await client.query('COMMIT');
        console.log('Database migration complete.');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
} finally { await Promise.all([admin.end(), runtime.end()]); }
