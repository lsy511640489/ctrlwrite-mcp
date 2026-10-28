import { WikiNode, Position } from '../types';

export const getAbsolutePosition = (node: WikiNode, allNodes: WikiNode[]): Position => {
    if (!node.parentId) {
        return node.position;
    }
    const parent = allNodes.find(n => n.id === node.parentId);
    if (!parent) {
        return node.position;
    }
    const parentPos = getAbsolutePosition(parent, allNodes);
    return {
        x: parentPos.x + node.position.x,
        y: parentPos.y + node.position.y
    };
};