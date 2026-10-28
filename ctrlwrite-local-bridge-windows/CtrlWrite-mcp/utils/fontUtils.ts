import { WikiNode } from '../types';

/**
 * Resolves the effective font style for a node by traversing up the parent hierarchy.
 */
export const resolveFont = (
    style: 'sans' | 'serif' | 'mono' | 'global' | undefined,
    node: WikiNode,
    allNodes: WikiNode[],
    globalHeaderFont: 'sans' | 'serif' | 'mono',
    globalBodyFont: 'sans' | 'serif' | 'mono',
    globalCaptionFont: 'sans' | 'serif' | 'mono',
    targetType: 'header' | 'body' | 'caption' = 'body'
): 'sans' | 'serif' | 'mono' => {
    // 1. Explicit global override
    if (style === 'global') {
        if (targetType === 'header') return globalHeaderFont;
        if (targetType === 'caption') return globalCaptionFont;
        return globalBodyFont;
    }
    
    // 2. Explicit style set on this node
    if (style === 'sans' || style === 'serif' || style === 'mono') return style;

    // 3. Inherit (undefined): Check if this node is inside a Group
    if (node.parentId) {
        const parent = allNodes.find(n => n.id === node.parentId);
        if (parent) {
            if (targetType === 'header') {
                // Headers inherit from Parent's "Group Headings" setting (stored in fontStyle)
                return resolveFont(parent.fontStyle, parent, allNodes, globalHeaderFont, globalBodyFont, globalCaptionFont, 'header');
            } else if (targetType === 'caption') {
                // Captions inherit from body settings usually unless specifically handled? 
                // For now, let's say they inherit from parent body style similar to body
                const parentStyle = parent.bodyFontStyle || parent.fontStyle;
                return resolveFont(parentStyle, parent, allNodes, globalHeaderFont, globalBodyFont, globalCaptionFont, 'caption');
            } else {
                // Bodies inherit from Parent's "Group Body" setting (stored in bodyFontStyle)
                // Fallback to fontStyle for backwards compatibility
                const parentBodyStyle = parent.bodyFontStyle || parent.fontStyle;
                return resolveFont(parentBodyStyle, parent, allNodes, globalHeaderFont, globalBodyFont, globalCaptionFont, 'body');
            }
        }
    }

    // 4. Root level or disconnected: Fallback to global
    if (targetType === 'header') return globalHeaderFont;
    if (targetType === 'caption') return globalCaptionFont;
    return globalBodyFont;
};

/**
 * Resolves the effective color for a node property.
 */
export const resolveColor = (
    color: string | undefined,
    node: WikiNode,
    allNodes: WikiNode[],
    globalColor: string, // This acts as Body Color
    globalHeaderColor: string,
    globalCaptionColor: string,
    targetType: 'header' | 'body' | 'caption' = 'body'
): string => {
    if (color) return color;

    if (node.parentId) {
        const parent = allNodes.find(n => n.id === node.parentId);
        if (parent) {
            if (targetType === 'header') {
                return resolveColor(parent.captionColor, parent, allNodes, globalColor, globalHeaderColor, globalCaptionColor, 'header');
            } else if (targetType === 'caption') {
                return resolveColor(parent.captionColor, parent, allNodes, globalColor, globalHeaderColor, globalCaptionColor, 'caption');
            } else {
                return resolveColor(parent.bodyColor, parent, allNodes, globalColor, globalHeaderColor, globalCaptionColor, 'body');
            }
        }
    }

    if (targetType === 'header') return globalHeaderColor;
    if (targetType === 'caption') return globalCaptionColor;
    return globalColor;
};

/**
 * Resolves the effective font size for a node property.
 */
export const resolveFontSize = (
    size: number | undefined,
    node: WikiNode,
    allNodes: WikiNode[],
    defaultSize: number,
    targetType: 'header' | 'body' | 'caption' = 'body'
): number => {
    if (size) return size;

    if (node.parentId) {
        const parent = allNodes.find(n => n.id === node.parentId);
        if (parent) {
            if (targetType === 'header') {
                return resolveFontSize(parent.fontSize, parent, allNodes, defaultSize, 'header');
            } else if (targetType === 'caption') {
                return resolveFontSize(parent.captionFontSize, parent, allNodes, defaultSize, 'caption');
            } else {
                return resolveFontSize(parent.bodyFontSize, parent, allNodes, defaultSize, 'body');
            }
        }
    }

    return defaultSize;
};