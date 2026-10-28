import { Position, WikiNode, HandlePosition } from '../types';
import { getAbsolutePosition } from './nodeUtils';

export const getHandlePosition = (node: WikiNode, handle: HandlePosition, allNodes?: WikiNode[]): Position => {
  const { x, y } = allNodes ? getAbsolutePosition(node, allNodes) : node.position;
  const { width, height } = node;

  switch (handle) {
    case 'top':
      return { x: x + width / 2, y: y };
    case 'right':
      return { x: x + width, y: y + height / 2 };
    case 'bottom':
      return { x: x + width / 2, y: y + height };
    case 'left':
      return { x: x, y: y + height / 2 };
    default:
      return { x: x + width / 2, y: y + height / 2 };
  }
};

export const getClosestHandle = (node: WikiNode, point: Position, allNodes?: WikiNode[]): HandlePosition => {
  const handles: HandlePosition[] = ['top', 'right', 'bottom', 'left'];
  let closestHandle: HandlePosition = 'top';
  let minDistance = Infinity;

  handles.forEach(h => {
    const pos = getHandlePosition(node, h, allNodes);
    const dist = Math.sqrt(Math.pow(pos.x - point.x, 2) + Math.pow(pos.y - point.y, 2));
    if (dist < minDistance) {
      minDistance = dist;
      closestHandle = h;
    }
  });

  return closestHandle;
};

export const getLabelPosition = (
  start: Position,
  end: Position,
  nodes: WikiNode[],
  labelWidth: number = 120,
  labelHeight: number = 40
): Position => {
  // Check if a point (plus label dimensions) overlaps with any node
  const isOverlapping = (p: Position) => {
    const lx = p.x - labelWidth / 2;
    const ly = p.y - labelHeight / 2;
    const rw = labelWidth;
    const rh = labelHeight;

    return nodes.some(node => {
      // Add a small buffer around nodes
      const buffer = 10;
      const absPos = getAbsolutePosition(node, nodes);
      return (
        lx < absPos.x + node.width + buffer &&
        lx + rw > absPos.x - buffer &&
        ly < absPos.y + node.height + buffer &&
        ly + rh > absPos.y - buffer
      );
    });
  };

  // Try more points along the line for extreme space constraints:
  // Starts from 0.5 and radiates outwards with 0.05 increments
  const tValues = [0.5];
  for (let i = 1; i <= 9; i++) {
    const delta = i * 0.05;
    tValues.push(0.5 - delta);
    tValues.push(0.5 + delta);
  }
  
  for (const t of tValues) {
    const p = {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t
    };
    if (!isOverlapping(p)) {
      return p;
    }
  }

  // Fallback to midpoint if no empty space found
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2
  };
};