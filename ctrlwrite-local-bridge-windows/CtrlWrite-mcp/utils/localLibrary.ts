import { unzipSync } from 'fflate';
import type { LocalSkill } from '../types/skillTypes';
import { openDB } from './db';
import { assertWorkspaceUser, workspaceKey, workspaceUser } from './workspaceStorage';
import { fileWorkspace, fileWritesPaused, localFileRequest } from './localFiles';

type LibraryEntry = { id: string; name: string; content: string };
export type LibraryBackup = { skills: LibraryEntry[]; constraints: LibraryEntry[] };

const prefix = (kind: 'skill' | 'constraint') => workspaceKey(`library:${kind}:`);

async function entries(kind: 'skill' | 'constraint'): Promise<LibraryEntry[]> {
    if (fileWorkspace()) return (await localFileRequest<{ entries: LibraryEntry[] }>('library/read', { workspace: fileWorkspace(), kind })).entries;
    const actor = workspaceUser();
    const start = prefix(kind);
    const database = await openDB();
    try {
        assertWorkspaceUser(actor);
        const transaction = database.transaction('library', 'readonly');
        const request = transaction.objectStore('library').getAll(IDBKeyRange.bound(start, start + '\uffff'));
        return await new Promise((resolve, reject) => {
            request.onsuccess = () => { try { assertWorkspaceUser(actor); resolve(request.result as LibraryEntry[]); } catch (error) { reject(error); } };
            request.onerror = () => reject(request.error);
        });
    } finally { database.close(); }
}

async function read(kind: 'skill' | 'constraint', name: string): Promise<LibraryEntry | undefined> {
    if (fileWorkspace()) return (await entries(kind)).find(entry => entry.name === name);
    const actor = workspaceUser();
    const key = prefix(kind) + name;
    const database = await openDB();
    try {
        assertWorkspaceUser(actor);
        const request = database.transaction('library', 'readonly').objectStore('library').get(key);
        return await new Promise((resolve, reject) => {
            request.onsuccess = () => { try { assertWorkspaceUser(actor); resolve(request.result as LibraryEntry | undefined); } catch (error) { reject(error); } };
            request.onerror = () => reject(request.error);
        });
    } finally { database.close(); }
}

async function write(kind: 'skill' | 'constraint', name: string, content: string, id?: string): Promise<LibraryEntry> {
    if (fileWritesPaused()) throw new Error('工作区正在切换。');
    if (fileWorkspace()) return localFileRequest<LibraryEntry>('library/write', { workspace: fileWorkspace(), kind, entry: { id: id || crypto.randomUUID(), name, content } });
    const actor = workspaceUser();
    const key = prefix(kind) + name;
    const database = await openDB();
    const entry = { id: id || crypto.randomUUID(), name, content };
    try {
        assertWorkspaceUser(actor);
        const transaction = database.transaction('library', 'readwrite');
        transaction.objectStore('library').put(entry, key);
        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => { try { assertWorkspaceUser(actor); resolve(); } catch (error) { reject(error); } };
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
        return entry;
    } finally { database.close(); }
}

export const listLocalSkills = (): Promise<LocalSkill[]> => entries('skill');
export async function saveLocalSkill(name: string, content: string) {
    const actor = workspaceUser();
    const existing = await read('skill', name);
    assertWorkspaceUser(actor);
    return write('skill', name, content, existing?.id);
}
export async function saveLocalConstraint(name: string, content: string) {
    if (!/^[^/\\:]+\.md$/i.test(name) || !content.trim() || content.length > 50000) throw new Error('请选择小于 50 KB 的 Markdown 约束。');
    return write('constraint', name, content);
}
export async function readLocalConstraint(name: string) { return (await read('constraint', name))?.content; }
export async function exportLocalLibrary(): Promise<LibraryBackup> {
    const [skills, constraints] = await Promise.all([entries('skill'), entries('constraint')]);
    return { skills, constraints };
}
export async function importLocalLibrary(backup: LibraryBackup) {
    const actor = workspaceUser();
    if (!backup || !Array.isArray(backup.skills) || !Array.isArray(backup.constraints) || backup.skills.length + backup.constraints.length > 200) throw new Error('备份中的技能库格式无效或过大。');
    for (const entry of [...backup.skills, ...backup.constraints]) {
        if (typeof entry.name !== 'string' || entry.name.length > 200 || typeof entry.content !== 'string' || entry.content.length > 50000 || typeof entry.id !== 'string' || entry.id.length > 100) throw new Error('备份中的技能或约束格式无效。');
    }
    for (const skill of backup.skills) { assertWorkspaceUser(actor); await write('skill', skill.name, skill.content, skill.id); }
    for (const constraint of backup.constraints) { assertWorkspaceUser(actor); await write('constraint', constraint.name, constraint.content, constraint.id); }
    assertWorkspaceUser(actor);
    window.dispatchEvent(new Event('iamtired:library-imported'));
}

export function skillFromLocalZip(bytes: Uint8Array): { name: string; content: string } {
    if (bytes.length > 10 * 1024 * 1024) throw new Error('技能压缩包超过 10 MB。');
    let count = 0;
    let total = 0;
    let manifest = '';
    const files = unzipSync(bytes, { filter: file => {
        count++;
        total += file.originalSize;
        if (count > 200 || total > 20 * 1024 * 1024 || file.name.split('/').includes('..')) throw new Error('技能压缩包内容不安全或过大。');
        if (!/(^|\/)SKILL\.md$/i.test(file.name)) return false;
        if (manifest || file.originalSize > 50000) throw new Error('每次只能导入一个小于 50 KB 的 SKILL.md。');
        manifest = file.name;
        return true;
    } });
    if (!manifest || !files[manifest]) throw new Error('压缩包中需要 SKILL.md。');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(files[manifest]);
    if (!content.trim()) throw new Error('技能内容为空。');
    const name = content.match(/^name:\s*['"]?([^\r\n'"]+)/m)?.[1]?.trim() || manifest.split('/').slice(-2, -1)[0] || 'Imported skill';
    return { name: name.slice(0, 200), content };
}
