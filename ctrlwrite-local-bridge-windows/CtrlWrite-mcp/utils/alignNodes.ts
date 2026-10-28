import type { WikiNode } from '../types';
import { getAbsolutePosition } from './nodeUtils';

type NodeSize = { width: number; height: number };

export const getAlignmentUpdates = (
    nodes: WikiNode[],
    action: string,
    measuredSizes: Map<string, NodeSize> = new Map()
): { id: string; updates: Partial<WikiNode> }[] => {
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const selectedIds = new Set(nodes.filter(node => node.selected).map(node => node.id));
    const movable = nodes.filter(node => {
        if (!selectedIds.has(node.id)) return false;
        let parentId = node.parentId;
        const visited = new Set<string>();
        while (parentId && !visited.has(parentId)) {
            if (selectedIds.has(parentId)) return false;
            visited.add(parentId);
            parentId = nodeById.get(parentId)?.parentId;
        }
        return true;
    });
    if (movable.length < 2) return [];

    const bounds = movable.map(node => {
        const position = getAbsolutePosition(node, nodes);
        const size = measuredSizes.get(node.id) ?? node;
        return { node, position, width: size.width, height: size.height };
    });
    const left = Math.min(...bounds.map(item => item.position.x));
    const right = Math.max(...bounds.map(item => item.position.x + item.width));
    const top = Math.min(...bounds.map(item => item.position.y));
    const bottom = Math.max(...bounds.map(item => item.position.y + item.height));

    return bounds.flatMap(({ node, position, width, height }) => {
        let x = position.x;
        let y = position.y;
        switch (action) {
            case 'align-left': x = left; break;
            case 'align-right': x = right - width; break;
            case 'align-h-center': x = (left + right - width) / 2; break;
            case 'align-top': y = top; break;
            case 'align-bottom': y = bottom - height; break;
            case 'align-v-center': y = (top + bottom - height) / 2; break;
            default: return [];
        }
        if (x === position.x && y === position.y) return [];
        const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
        const parentPosition = parent ? getAbsolutePosition(parent, nodes) : { x: 0, y: 0 };
        return [{ id: node.id, updates: { position: { x: x - parentPosition.x, y: y - parentPosition.y } } }];
    });
};
