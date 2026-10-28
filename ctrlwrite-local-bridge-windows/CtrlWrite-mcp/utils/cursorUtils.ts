import { ToolMode, ResizeDirection } from '../types';

interface CursorParams {
    isDraggingCanvas: boolean;
    isDraggingNode: boolean;
    isDraggingConnection: boolean;
    isResizingNode: boolean;
    isSpacePressed: boolean;
    toolMode: ToolMode;
    resizeDirection: ResizeDirection;
}

export const getCursor = ({
    isDraggingCanvas,
    isDraggingNode,
    isDraggingConnection,
    isResizingNode,
    isSpacePressed,
    toolMode,
    resizeDirection
}: CursorParams): string => {
    if (isDraggingCanvas || isSpacePressed || toolMode === ToolMode.PAN) return 'grab';
    if (toolMode === ToolMode.BOX_SELECT) return 'crosshair';
    if (isDraggingNode) return 'grabbing';
    if (isDraggingConnection) return 'crosshair';

    if (isResizingNode) {
        switch (resizeDirection) {
            case 'n': return 'n-resize';
            case 's': return 's-resize';
            case 'e': return 'e-resize';
            case 'w': return 'w-resize';
            case 'ne': return 'ne-resize';
            case 'nw': return 'nw-resize';
            case 'se': return 'se-resize';
            case 'sw': return 'sw-resize';
        }
    }

    return 'default';
};
