import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { accountSchema } from './authStore';
import { prepareFileImport } from './fileImport';
import { changeCanvas, readCanvas } from './canvasStore';
import { localWorkspace } from './workspaceContext';

const args = process.argv.slice(2);
const argument = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const account = accountSchema.parse(argument('--account'));
const filename = argument('--canvas');
if (!filename) throw new Error('Usage: npm run workspace:import-local -- --account EMAIL_OR_PHONE --canvas CANVAS_JSON');
const accounts = JSON.parse(await readFile(path.resolve(process.env.AUTH_DATA_DIR || '.auth', 'accounts.json'), 'utf8'));
const userId = z.uuid().parse(accounts.users?.find((user: any) => user.email === account || user.phone === account)?.id);
const imported = prepareFileImport(await readFile(path.resolve(filename), 'utf8'), 'Imported workspace.json');
await localWorkspace.run(userId, async () => {
    const current = await readCanvas();
    if (current && !args.includes('--append')) throw new Error('Target canvas already exists. Use --append to import as additional tabs without overwriting existing tabs.');
    await changeCanvas(current?.revision || 0, previous => ({ tabs: [...(previous?.tabs || []), ...imported.tabs], activeTabId: imported.tabs[0].id }));
});
console.log('Canvas imported into the specified private workspace. Existing tabs were preserved.');
