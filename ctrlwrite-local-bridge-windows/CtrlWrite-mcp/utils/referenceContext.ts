import { WikiNode } from '../types';

export const buildReferenceContext = (nodes: WikiNode[], sourceIds: string[], includeGroupChildren: boolean): string => {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const visited = new Set<string>();
    const references: WikiNode[] = [];

    const append = (id: string) => {
        const node = byId.get(id);
        if (!node || visited.has(id)) return;
        visited.add(id);
        references.push(node);
        if (includeGroupChildren && node.type === 'group') {
            nodes.filter(child => child.parentId === id)
                .sort((first, second) => first.position.y - second.position.y || first.position.x - second.position.x)
                .forEach(child => append(child.id));
        }
    };

    sourceIds.forEach(append);
    return references.map((node, index) => {
        const label = node.type === 'image' ? 'Image caption' : node.type;
        return `[${index + 1}] ${label}: ${node.title || 'Untitled'}\n${node.content.trim().slice(0, 4000)}`;
    }).join('\n\n').slice(0, 20000);
};
