import { randomUUID } from 'node:crypto';
export { markdownDraft } from '../utils/markdownImport';
import { z } from 'zod';
import type { Connection, WikiNode } from '../types';
import type { SkillGroup, Tab, TabState } from '../types/tabTypes';

const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const viewportSchema = z.object({ x: z.number().finite(), y: z.number().finite(), scale: z.number().positive().finite() });
const nodeSchema = z.object({
    id: z.string().min(1), type: z.enum(['text', 'title', 'group', 'image']), title: z.string(), content: z.string(),
    position: positionSchema, width: z.number().positive().finite(), height: z.number().positive().finite(),
    parentId: z.string().optional(), skillGroupId: z.string().optional(), coverImage: z.string().optional()
}).passthrough();
const connectionSchema = z.object({ id: z.string().min(1), sourceId: z.string().min(1), targetId: z.string().min(1) }).passthrough();
const skillGroupSchema = z.object({
    id: z.string().min(1), name: z.string(), resources: z.array(z.object({ id: z.string(), name: z.string(), content: z.string(), kind: z.enum(['file', 'skill']) })),
    skillIds: z.array(z.string()).optional()
});
const tabSchema = z.object({ id: z.string().min(1), title: z.string(), nodes: z.array(nodeSchema), connections: z.array(connectionSchema), skillGroups: z.array(skillGroupSchema).optional(), viewport: viewportSchema });
export const tabStateSchema = z.object({ tabs: z.array(tabSchema).min(1), activeTabId: z.string().min(1) });

export type CanvasDraft = z.infer<typeof draftSchema>;
export const draftSchema = z.object({ tabs: z.array(z.object({
    title: z.string().min(1),
    nodes: z.array(z.object({
        key: z.string().min(1), type: z.enum(['text', 'title', 'group', 'image']), title: z.string(),
        content: z.string().default(''), parentKey: z.string().optional(),
        position: positionSchema.optional(), width: z.number().positive().optional(), height: z.number().positive().optional(),
        coverImage: z.string().optional(), omitTitleInMarkdown: z.boolean().optional()
    })),
    connections: z.array(z.object({ sourceKey: z.string(), targetKey: z.string() })).default([]),
    skillGroups: z.array(z.object({ key: z.string(), name: z.string(), members: z.array(z.string()),
        resources: z.array(z.object({ name: z.string(), content: z.string() })).default([]), skillIds: z.array(z.string()).default([]) })).default([])
})).min(1) });

const unique = (items: string[], label: string) => {
    if (new Set(items).size !== items.length) throw new Error(`Duplicate ${label}.`);
};

export function validateCanvas(state: unknown): TabState {
    const parsed = tabStateSchema.parse(state) as TabState;
    unique(parsed.tabs.map(tab => tab.id), 'tab IDs');
    if (!parsed.tabs.some(tab => tab.id === parsed.activeTabId)) throw new Error('Active tab does not exist.');
    for (const tab of parsed.tabs) {
        unique(tab.nodes.map(node => node.id), 'node IDs');
        unique(tab.connections.map(connection => connection.id), 'connection IDs');
        unique((tab.skillGroups || []).map(group => group.id), 'skill group IDs');
        const nodes = new Map(tab.nodes.map(node => [node.id, node]));
        const groups = new Set((tab.skillGroups || []).map(group => group.id));
        for (const node of tab.nodes) {
            if (node.parentId && nodes.get(node.parentId)?.type !== 'group') throw new Error(`Invalid group parent for ${node.id}.`);
            if (node.skillGroupId && !groups.has(node.skillGroupId)) throw new Error(`Missing skill group for ${node.id}.`);
            const visited = new Set([node.id]);
            let parent = node.parentId;
            while (parent) {
                if (visited.has(parent)) throw new Error('Group containment cycle.');
                visited.add(parent);
                parent = nodes.get(parent)?.parentId;
            }
        }
        for (const connection of tab.connections) {
            if (!nodes.has(connection.sourceId) || !nodes.has(connection.targetId) || connection.sourceId === connection.targetId) throw new Error(`Invalid connection ${connection.id}.`);
        }
    }
    return parsed;
}

export function cleanCanvas(state: TabState): TabState {
    return { ...state, tabs: state.tabs.map(tab => ({ ...tab,
        nodes: tab.nodes.map(({ selected, isGenerating, activeAIPanel, ...node }) => node),
        connections: tab.connections.map(({ selected, isEditing, ...connection }) => connection)
    })) };
}

export function buildDraft(value: unknown): { tabs: Tab[]; summary: { title: string; nodes: number; connections: number }[] } {
    const draft = draftSchema.parse(value);
    const tabs = draft.tabs.map((source): Tab => {
        unique(source.nodes.map(node => node.key), 'draft node keys');
        unique(source.skillGroups.map(group => group.key), 'draft skill group keys');
        const ids = new Map(source.nodes.map(node => [node.key, randomUUID()]));
        const groupIds = new Map(source.skillGroups.map(group => [group.key, randomUUID()]));
        const nodes: WikiNode[] = source.nodes.map((node, index) => {
            if (node.parentKey && source.nodes.find(candidate => candidate.key === node.parentKey)?.type !== 'group') throw new Error(`Unknown group parent: ${node.parentKey}.`);
            const dimensions = node.type === 'title' ? [400, 80] : node.type === 'group' ? [500, 400] : [350, 300];
            const siblingIndex = source.nodes.slice(0, index).filter(item => item.parentKey === node.parentKey).length;
            return { id: ids.get(node.key)!, type: node.type, title: node.title, content: node.content,
                position: node.position || (node.parentKey
                    ? { x: 24, y: 56 + siblingIndex * 340 }
                    : { x: (index % 3) * 520, y: Math.floor(index / 3) * 420 }),
                width: node.width || dimensions[0], height: node.height || dimensions[1],
                parentId: node.parentKey ? ids.get(node.parentKey) : undefined, coverImage: node.coverImage,
                omitTitleInMarkdown: node.omitTitleInMarkdown };
        });
        for (const group of nodes.filter(node => node.type === 'group')) {
            const children = nodes.filter(node => node.parentId === group.id);
            if (children.length) {
                group.height = Math.max(group.height, ...children.map(child => child.position.y + child.height + 40));
                group.width = Math.max(group.width, ...children.map(child => child.position.x + child.width + 24));
            }
        }
        const connections: Connection[] = source.connections.map(connection => {
            if (!ids.has(connection.sourceKey) || !ids.has(connection.targetKey)) throw new Error('Connection references an unknown key.');
            return { id: randomUUID(), sourceId: ids.get(connection.sourceKey)!, targetId: ids.get(connection.targetKey)! };
        });
        const skillGroups: SkillGroup[] = source.skillGroups.map(group => ({ id: groupIds.get(group.key)!, name: group.name,
            resources: group.resources.map(resource => ({ id: randomUUID(), name: resource.name, content: resource.content, kind: 'file' as const })), skillIds: group.skillIds }));
        for (const group of source.skillGroups) for (const key of group.members) {
            const node = nodes.find(item => item.id === ids.get(key));
            if (!node) throw new Error(`Skill group references unknown key: ${key}.`);
            node.skillGroupId = groupIds.get(group.key);
        }
        return { id: randomUUID(), title: source.title, nodes, connections, skillGroups, viewport: { x: 100, y: 100, scale: 1 } };
    });
    validateCanvas({ tabs, activeTabId: tabs[0].id });
    return { tabs, summary: tabs.map(tab => ({ title: tab.title, nodes: tab.nodes.length, connections: tab.connections.length })) };
}
