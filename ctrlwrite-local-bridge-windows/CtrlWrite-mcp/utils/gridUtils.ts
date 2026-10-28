import React from 'react';
import { Viewport, Position } from '../types';

export const SNAP_SIZE = 20;

export const snap = (val: number): number => {
    return Math.round(val / SNAP_SIZE) * SNAP_SIZE;
};

interface GridBackgroundOptions {
    viewport: Viewport;
    showGrid: boolean;
    isDarkMode: boolean;
}

export const getGridBackground = ({ viewport, showGrid, isDarkMode }: GridBackgroundOptions): React.CSSProperties => {
    const bgSize = SNAP_SIZE * viewport.scale;
    const majorBgSize = (SNAP_SIZE * 5) * viewport.scale;
    const minorAlpha = showGrid ? Math.max(0, Math.min(1, (viewport.scale - 0.5) * 4)) * (isDarkMode ? 0.05 : 0.08) : 0;
    const majorAlpha = showGrid ? (isDarkMode ? 0.08 : 0.12) : 0;
    const gridColor = 'var(--grid-rgb)';

    if (!showGrid) return {};

    return {
        backgroundImage: `
        linear-gradient(to right, rgba(${gridColor}, ${majorAlpha}) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(${gridColor}, ${majorAlpha}) 1px, transparent 1px),
        linear-gradient(to right, rgba(${gridColor}, ${minorAlpha}) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(${gridColor}, ${minorAlpha}) 1px, transparent 1px)
    `,
        backgroundSize: `${majorBgSize}px ${majorBgSize}px, ${majorBgSize}px ${majorBgSize}px, ${bgSize}px ${bgSize}px, ${bgSize}px ${bgSize}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`
    };
};
