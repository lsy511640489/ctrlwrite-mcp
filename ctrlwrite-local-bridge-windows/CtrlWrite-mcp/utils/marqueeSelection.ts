import type { Position, Viewport, WikiNode } from '../types';
import { getAbsolutePosition } from './nodeUtils';

export interface MarqueeBox {
    start: Position;
    end: Position;
}

export const getMarqueeSelection = (nodes: WikiNode[], viewport: Viewport, box: MarqueeBox, initialIds: string[] = []): string[] => {
    const selected = new Set(initialIds);
    const minX = (Math.min(box.start.x, box.end.x) - viewport.x) / viewport.scale;
    const maxX = (Math.max(box.start.x, box.end.x) - viewport.x) / viewport.scale;
    const minY = (Math.min(box.start.y, box.end.y) - viewport.y) / viewport.scale;
    const maxY = (Math.max(box.start.y, box.end.y) - viewport.y) / viewport.scale;
    const hasArea = maxX > minX && maxY > minY && Math.hypot(box.end.x - box.start.x, box.end.y - box.start.y) >= 4;
    if (hasArea) {
        for (const node of nodes) {
            const position = getAbsolutePosition(node, nodes);
            const right = position.x + node.width;
            const bottom = position.y + node.height;
            const hit = node.type === 'group'
                ? position.x >= minX && right <= maxX && position.y >= minY && bottom <= maxY
                : position.x < maxX && right > minX && position.y < maxY && bottom > minY;
            if (hit) selected.add(node.id);
        }
    }
    const byId = new Map(nodes.map(node => [node.id, node]));
    return nodes.filter(node => {
        if (!selected.has(node.id)) return false;
        let parentId = node.parentId;
        const visited = new Set<string>();
        while (parentId && !visited.has(parentId)) {
            if (selected.has(parentId)) return false;
            visited.add(parentId);
            parentId = byId.get(parentId)?.parentId;
        }
        return true;
    }).map(node => node.id);
};
