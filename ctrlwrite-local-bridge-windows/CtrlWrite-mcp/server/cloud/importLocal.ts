import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createPool, assertRestrictedRole, tenantTransaction, changeCloudCanvas, readCloudCanvas } from './database';
import { accountSchema } from '../authStore';
import { validateCanvas } from '../canvasModel';
import { prepareFileImport } from '../fileImport';

const args = process.argv.slice(2);
const argument = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const account = accountSchema.parse(argument('--account'));
const canvasPath = argument('--canvas');
if (!canvasPath) throw new Error('Usage: npm run db:import-local -- --account EMAIL_OR_PHONE --canvas CANVAS_JSON [--accounts .auth/accounts.json]');
const source = JSON.parse(await readFile(resolve(canvasPath), 'utf8'));
const state = validateCanvas(source.state || source.tabState || source);
const imported = prepareFileImport(JSON.stringify({ state }), 'Imported workspace.json');
const pool = createPool(process.env.DATABASE_URL || '');
try {
    await assertRestrictedRole(pool);
    let user = (await pool.query('SELECT id FROM users WHERE email=$1 OR phone=$1', [account])).rows[0];
    if (!user) {
        const accountPath = argument('--accounts');
        if (!accountPath) throw new Error('Create the target account first, or provide --accounts with the local accounts.json.');
        const sourceAccounts = JSON.parse(await readFile(resolve(accountPath), 'utf8'));
        const owner = z.object({ name: z.string().min(1), password: z.string().regex(/^[a-f0-9]{32}:[a-f0-9]{128}$/), email: z.string().optional(), phone: z.string().optional() }).parse(sourceAccounts.users?.find((entry: any) => entry.email === account || entry.phone === account));
        const id = randomUUID();
        user = await tenantTransaction(pool, id, async client => {
            const { rows } = await client.query('INSERT INTO users(id,name,email,phone,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING id', [id, owner.name, owner.email || null, owner.phone || null, owner.password]);
            await client.query('INSERT INTO workspaces(id,owner_id) VALUES($1,$2)', [randomUUID(), id]);
            return rows[0];
        });
    }
    await tenantTransaction(pool, user.id, async client => {
        const workspace = (await client.query('SELECT id FROM workspaces WHERE owner_id=$1', [user.id])).rows[0];
        if (!workspace) throw new Error('Target workspace does not exist.');
        await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace.id]);
        const current = await readCloudCanvas(client, workspace.id);
        if (current && !args.includes('--append')) throw new Error('Target canvas already exists. Use --append to import as additional tabs without overwriting existing tabs.');
        await changeCloudCanvas(client, workspace.id, current?.revision || 0, previous => ({ tabs: [...(previous?.tabs || []), ...imported.tabs], activeTabId: imported.tabs[0].id }));
        await client.query('INSERT INTO audit_logs(workspace_id,action) VALUES($1,$2)', [workspace.id, 'canvas.import-local']);
    });
    console.log('Canvas imported into the specified private workspace. Existing tabs were preserved.');
} finally { await pool.end(); }
