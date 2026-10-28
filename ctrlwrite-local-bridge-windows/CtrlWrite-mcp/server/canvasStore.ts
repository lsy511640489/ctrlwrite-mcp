import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { TabState } from '../types/tabTypes';
import type { Connection, WikiNode } from '../types';
import { buildDraft, cleanCanvas, validateCanvas } from './canvasModel';
import { workspaceDirectory } from './workspaceContext';

const root = process.env.IAMTIRED_CANVAS_DATA_DIR
    ? path.resolve(process.env.IAMTIRED_CANVAS_DATA_DIR)
    : path.resolve(fileURLToPath(new URL('..', import.meta.url)), '.canvas-mcp');
const tokenFile = path.join(root, 'token');
export type StoredCanvas = { revision: number; state: TabState };

const mutationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create_node'), tabId: z.string(), node: z.object({ type: z.enum(['text', 'title', 'group', 'image']), title: z.string(), content: z.string().default(''), parentId: z.string().optional(), skillGroupId: z.string().optional(), position: z.object({ x: z.number(), y: z.number() }), width: z.number().positive().optional(), height: z.number().positive().optional() }) }),
    z.object({ kind: z.literal('update_node'), tabId: z.string(), nodeId: z.string(), changes: z.object({ title: z.string().optional(), content: z.string().optional(), parentId: z.string().nullable().optional(), skillGroupId: z.string().nullable().optional(), position: z.object({ x: z.number(), y: z.number() }).optional(), width: z.number().positive().optional(), height: z.number().positive().optional(), omitTitleInMarkdown: z.boolean().optional() }).strict() }),
    z.object({ kind: z.literal('delete_node'), tabId: z.string(), nodeId: z.string() }),
    z.object({ kind: z.literal('connect'), tabId: z.string(), sourceId: z.string(), targetId: z.string() }),
    z.object({ kind: z.literal('set_skill_group'), tabId: z.string(), name: z.string(), groupId: z.string().optional(), memberIds: z.array(z.string()).min(1), resources: z.array(z.object({ name: z.string(), content: z.string().max(50000) })).default([]), skillIds: z.array(z.string()).default([]) })
]);
export const mutationsSchema = z.array(mutationSchema).min(1).max(100);
export type CanvasMutation = z.infer<typeof mutationSchema>;

let pending: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work);
    pending = result.catch(() => undefined);
    return result;
}

export async function accessToken(): Promise<string> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    try { return (await readFile(tokenFile, 'utf8')).trim(); }
    catch {
        const token = randomBytes(32).toString('hex');
        await writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 }).catch(() => undefined);
        return (await readFile(tokenFile, 'utf8')).trim();
    }
}

export async function readCanvas(): Promise<StoredCanvas | null> {
    const stateFile = path.join(workspaceDirectory(root), 'canvas.json');
    try {
        const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as StoredCanvas;
        if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 1) throw new Error('Invalid canvas revision.');
        return { revision: parsed.revision, state: validateCanvas(parsed.state) };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

async function writeCanvas(canvas: StoredCanvas): Promise<void> {
    const directory = workspaceDirectory(root);
    const stateFile = path.join(directory, 'canvas.json');
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(canvas));
    await rename(temporary, stateFile);
}

export async function changeCanvas(expectedRevision: number, change: (current: TabState | null) => TabState): Promise<StoredCanvas> {
    return serialized(async () => {
        const current = await readCanvas();
        if ((current?.revision || 0) !== expectedRevision) throw new Error(`Revision conflict: current revision is ${current?.revision || 0}. Reload before applying changes.`);
        const state = cleanCanvas(validateCanvas(change(current?.state || null)));
        const next = { revision: expectedRevision + 1, state };
        await writeCanvas(next);
        return next;
    });
}

export function applyMutations(state: TabState | null, operations: CanvasMutation[]): TabState {
    if (!state) throw new Error('No canvas exists yet. Open the app or import a draft first.');
    const next = structuredClone(state);
    for (const operation of operations) {
        const tab = next.tabs.find(item => item.id === operation.tabId);
        if (!tab) throw new Error(`Tab does not exist: ${operation.tabId}.`);
        const node = 'nodeId' in operation ? tab.nodes.find(item => item.id === operation.nodeId) : undefined;
        if ('nodeId' in operation && !node) throw new Error(`Node does not exist: ${operation.nodeId}.`);
        switch (operation.kind) {
            case 'create_node': {
                const dimensions = operation.node.type === 'title' ? [400, 80] : operation.node.type === 'group' ? [500, 400] : [350, 300];
                tab.nodes.push({ ...operation.node, id: randomUUID(), width: operation.node.width || dimensions[0], height: operation.node.height || dimensions[1] } as WikiNode);
                break;
            }
            case 'update_node': {
                Object.assign(node!, operation.changes);
                if (operation.changes.parentId === null) delete node!.parentId;
                if (operation.changes.skillGroupId === null) delete node!.skillGroupId;
                break;
            }
            case 'delete_node': {
                const removed = new Set([operation.nodeId]);
                let changed = true;
                while (changed) {
                    const count = removed.size;
                    tab.nodes.forEach(item => { if (item.parentId && removed.has(item.parentId)) removed.add(item.id); });
                    changed = removed.size !== count;
                }
                tab.nodes = tab.nodes.filter(item => !removed.has(item.id));
                tab.connections = tab.connections.filter(item => !removed.has(item.sourceId) && !removed.has(item.targetId));
                break;
            }
            case 'connect': {
                if (tab.connections.some(item => item.sourceId === operation.sourceId && item.targetId === operation.targetId)) throw new Error('Connection already exists.');
                tab.connections.push({ id: randomUUID(), sourceId: operation.sourceId, targetId: operation.targetId } as Connection);
                break;
            }
            case 'set_skill_group': {
                const groupId = operation.groupId || randomUUID();
                const groups = tab.skillGroups || (tab.skillGroups = []);
                const previous = groups.find(item => item.id === groupId);
                if (operation.groupId && !previous) throw new Error('Skill group does not exist.');
                const memberIds = new Set(operation.memberIds);
                if (operation.memberIds.some(id => !tab.nodes.some(item => item.id === id))) throw new Error('Skill group member does not exist.');
                const group = { id: groupId, name: operation.name, skillIds: operation.skillIds,
                    resources: operation.resources.map(resource => ({ id: randomUUID(), kind: 'file' as const, ...resource })) };
                if (previous) Object.assign(previous, group);
                else groups.push(group);
                tab.nodes.forEach(item => {
                    if (memberIds.has(item.id)) item.skillGroupId = groupId;
                    else if (item.skillGroupId === groupId) delete item.skillGroupId;
                });
            }
        }
    }
    return validateCanvas(next);
}

export function appendDraft(state: TabState | null, draft: unknown): TabState {
    const generated = buildDraft(draft).tabs;
    return validateCanvas({ tabs: [...(state?.tabs || []), ...generated], activeTabId: generated[0].id });
}
