import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { buildDraft, cleanCanvas, draftSchema, markdownDraft, validateCanvas } from './canvasModel';
import type { Tab } from '../types/tabTypes';

const MAX_IMPORT_BYTES = 20_000_000;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export async function readImportFile(filePath: string): Promise<{ filename: string; fileContent: string }> {
    if (!path.isAbsolute(filePath)) throw new Error('Provide the absolute path of the user-specified file.');
    if (!/\.(md|markdown|json)$/i.test(filePath)) throw new Error('Convert this document to UTF-8 Markdown (.md) or canvas JSON first. PDF, DOCX and images cannot be imported as raw binary.');
    const handle = await open(filePath, 'r');
    try {
        const information = await handle.stat();
        if (!information.isFile()) throw new Error('Import requires a regular file.');
        if (information.size > MAX_IMPORT_BYTES) throw new Error('Import file exceeds 20 MB. Split it into smaller documents.');
        const bytes = await handle.readFile();
        if (bytes.length > MAX_IMPORT_BYTES) throw new Error('Import file exceeds 20 MB.');
        let fileContent: string;
        try { fileContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error('Save the converted document as UTF-8 before importing.'); }
        return { filename: path.basename(filePath), fileContent };
    } finally {
        await handle.close();
    }
}

export function prepareFileImport(fileContent: string, filename: string) {
    const content = fileContent.replace(/^\uFEFF/, '');
    if (!content.trim()) throw new Error('Import file is empty.');
    if (/\.(md|markdown)$/i.test(filename)) return buildDraft(markdownDraft(content, filename));
    if (!/\.json$/i.test(filename)) throw new Error('Supported import formats: .md, .markdown and .json.');
    let value: unknown;
    try { value = JSON.parse(content); }
    catch { throw new Error('Invalid JSON. Provide a canvas draft or an exported canvas backup.'); }
    const draft = draftSchema.safeParse(isRecord(value) && value.draft !== undefined ? value.draft : value);
    if (draft.success) return buildDraft(draft.data);
    let source = isRecord(value) ? value.tabState ?? value.state ?? value : undefined;
    if (!isRecord(source)) throw new Error('JSON must contain a canvas draft, tab state or canvas backup.');
    if (Array.isArray(source.nodes)) {
        const tab = { ...source, id: typeof source.id === 'string' ? source.id : randomUUID(),
            title: typeof source.title === 'string' ? source.title : filename.replace(/\.json$/i, ''),
            connections: source.connections || [], viewport: source.viewport || { x: 100, y: 100, scale: 1 } };
        source = { tabs: [tab], activeTabId: tab.id };
    }
    if (!isRecord(source) || !Array.isArray(source.tabs) || !source.tabs.length) throw new Error('JSON must contain a non-empty tabs array or a legacy canvas backup.');
    const firstTab = source.tabs[0];
    const state = cleanCanvas(validateCanvas({ ...source, activeTabId: source.activeTabId ?? (isRecord(firstTab) ? firstTab.id : undefined) }));
    const tabs = state.tabs.map((tab): Tab => {
        const nodeIds = new Map(tab.nodes.map(node => [node.id, randomUUID()]));
        const groupIds = new Map((tab.skillGroups || []).map(group => [group.id, randomUUID()]));
        return { ...tab, id: randomUUID(),
            nodes: tab.nodes.map(node => ({ ...node, id: nodeIds.get(node.id)!,
                parentId: node.parentId ? nodeIds.get(node.parentId) : undefined,
                skillGroupId: node.skillGroupId ? groupIds.get(node.skillGroupId) : undefined })),
            connections: tab.connections.map(connection => ({ ...connection, id: randomUUID(),
                sourceId: nodeIds.get(connection.sourceId)!, targetId: nodeIds.get(connection.targetId)! })),
            skillGroups: tab.skillGroups?.map(group => ({ ...group, id: groupIds.get(group.id)!,
                resources: group.resources.map(resource => ({ ...resource, id: randomUUID() })) }))
        };
    });
    validateCanvas({ tabs, activeTabId: tabs[0].id });
    return { tabs, summary: tabs.map(tab => ({ title: tab.title, nodes: tab.nodes.length, connections: tab.connections.length })) };
}
