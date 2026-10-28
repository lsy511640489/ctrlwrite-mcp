import { Connection, WikiNode } from '../types';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { strToU8, zipSync } from 'fflate';
import { getAbsolutePosition } from './nodeUtils';

export interface MarkdownOutlineItem {
    node: WikiNode;
    images: WikiNode[];
    children: MarkdownOutlineItem[];
}

export const buildMarkdownOutline = (nodes: WikiNode[], connections: Connection[] = []): MarkdownOutlineItem[] => {
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const parentById = new Map<string, string | undefined>(nodes.map(node => [node.id, nodeById.get(node.parentId || '')?.type === 'group' ? node.parentId : undefined]));
    const assignedTargets = new Set<string>();
    const visited = new Set<string>();
    const positions = new Map(nodes.map(node => [node.id, getAbsolutePosition(node, nodes)]));
    const sortByPosition = (a: WikiNode, b: WikiNode) =>
        positions.get(a.id)!.y - positions.get(b.id)!.y || positions.get(a.id)!.x - positions.get(b.id)!.x;
    const imageTargetById = new Map<string, string>();
    connections.forEach(connection => {
        const source = nodeById.get(connection.sourceId);
        const target = nodeById.get(connection.targetId);
        if (source?.type === 'image' && target?.type === 'text' && !imageTargetById.has(source.id)) {
            imageTargetById.set(source.id, target.id);
        }
    });

    const createsCycle = (childId: string, parentId: string): boolean => {
        let ancestorId: string | undefined = parentId;
        while (ancestorId && ancestorId !== childId) ancestorId = parentById.get(ancestorId);
        return ancestorId === childId;
    };

    connections.forEach(connection => {
        const source = nodeById.get(connection.sourceId);
        const target = nodeById.get(connection.targetId);
        if (!source || !target || source.id === target.id || assignedTargets.has(target.id)) return;
        if (source.type === 'image' && target.type === 'text') return;
        if (source.type === 'title' && target.type === 'title') return;

        if (target.parentId && nodeById.get(target.parentId)?.type === 'group') {
            let ancestor: WikiNode | undefined = source;
            while (ancestor && ancestor.id !== target.parentId) ancestor = nodeById.get(ancestor.parentId || '');
            if (!ancestor) return;
        }
        if (createsCycle(target.id, source.id)) return;
        parentById.set(target.id, source.id);
        assignedTargets.add(target.id);
    });

    const orderSiblings = (siblings: WikiNode[]): WikiNode[] => {
        const ordered = [...siblings].sort(sortByPosition);
        const siblingIds = new Set(ordered.map(node => node.id));
        const outgoing = new Map(ordered.map(node => [node.id, new Set<string>()]));
        const indegrees = new Map(ordered.map(node => [node.id, 0]));

        connections.forEach(connection => {
            if (!siblingIds.has(connection.sourceId) || !siblingIds.has(connection.targetId)) return;
            if (nodeById.get(connection.sourceId)?.type !== 'title' || nodeById.get(connection.targetId)?.type !== 'title') return;
            if (connection.sourceId !== connection.targetId && !outgoing.get(connection.sourceId)!.has(connection.targetId)) {
                outgoing.get(connection.sourceId)!.add(connection.targetId);
                indegrees.set(connection.targetId, indegrees.get(connection.targetId)! + 1);
            }
        });

        const result: WikiNode[] = [];
        const remaining = new Set(ordered.map(node => node.id));
        while (remaining.size) {
            const available = ordered.filter(node => remaining.has(node.id) && indegrees.get(node.id) === 0);
            const next = (available.length ? available : ordered.filter(node => remaining.has(node.id)))[0];
            result.push(next);
            remaining.delete(next.id);
            outgoing.get(next.id)!.forEach(targetId => indegrees.set(targetId, indegrees.get(targetId)! - 1));
        }
        return result;
    };

    const build = (node: WikiNode): MarkdownOutlineItem => {
        visited.add(node.id);
        const images = nodes.filter(image => imageTargetById.get(image.id) === node.id).sort(sortByPosition);
        const children = orderSiblings(nodes.filter(child => !imageTargetById.has(child.id) && parentById.get(child.id) === node.id && !visited.has(child.id)))
            .filter(child => !visited.has(child.id)).map(build);
        return { node, images, children };
    };

    const roots = orderSiblings(nodes.filter(node => !imageTargetById.has(node.id) && !parentById.get(node.id)))
        .map(node => visited.has(node.id) ? null : build(node))
        .filter((item): item is MarkdownOutlineItem => item !== null);

    orderSiblings(nodes.filter(node => !imageTargetById.has(node.id) && !visited.has(node.id))).forEach(node => {
        if (!visited.has(node.id)) roots.push(build(node));
    });
    return roots;
};

export const findMarkdownItem = (outline: MarkdownOutlineItem[], id: string): MarkdownOutlineItem | undefined => {
    for (const item of outline) {
        if (item.node.id === id) return item;
        const image = item.images.find(image => image.id === id);
        if (image) return { node: image, images: [], children: [] };
        const child = findMarkdownItem(item.children, id);
        if (child) return child;
    }
};

const escapeHeading = (title: string) => title.replace(/\s+/g, ' ').replace(/([\\`*_{}\[\]<>#+.!|])/g, '\\$1').trim();

const shiftBodyHeadings = (content: string, parentDepth: number): string => {
    const headings = fromMarkdown(content).children.filter(node => node.type === 'heading');
    let result = content;

    for (const heading of headings.reverse()) {
        const start = heading.position?.start.offset;
        const end = heading.position?.end.offset;
        if (start === undefined || end === undefined) continue;
        const original = content.slice(start, end);
        const level = '#'.repeat(Math.min(6, parentDepth + heading.depth));
        const atx = original.match(/^( {0,3})#{1,6}(?=[ \t]|$)/);
        const replacement = atx
            ? original.replace(/^( {0,3})#{1,6}(?=[ \t]|$)/, `$1${level}`)
            : `${level} ${original.replace(/\r?\n[ \t]*[=-]+[ \t]*$/, '').replace(/\r?\n/g, ' ')}`;
        result = result.slice(0, start) + replacement + result.slice(end);
    }
    return result;
};

export const renderMarkdown = (outline: MarkdownOutlineItem[], documentTitle?: string, imageSource: (node: WikiNode) => string | undefined = node => node.coverImage): string => {
    const parts: string[] = [];
    if (documentTitle) parts.push(`# ${escapeHeading(documentTitle)}`);

    const render = (item: MarkdownOutlineItem, depth: number) => {
        const { node } = item;
        const includeTitle = node.type === 'title' || !node.omitTitleInMarkdown;
        if (includeTitle && node.title.trim()) parts.push(`${'#'.repeat(Math.min(depth, 6))} ${escapeHeading(node.title)}`);
        const coverImage = imageSource(node);
        if (coverImage) {
            parts.push(`![${node.title.replace(/([\\\]])/g, '\\$1')}](<${coverImage.replace(/>/g, '%3E')}>)`);
        }
        item.images.forEach(image => {
            const source = imageSource(image);
            if (source) {
                parts.push(`![${image.title.replace(/([\\\]])/g, '\\$1')}](<${source.replace(/>/g, '%3E')}>)`);
            }
        });
        if (node.content.trim()) parts.push(shiftBodyHeadings(node.content.trim(), includeTitle ? depth : depth - 1));
        item.children.forEach(child => render(child, depth + 1));
    };

    let insideTitleSection = false;
    outline.forEach(item => {
        if (documentTitle && item.node.type === 'title') insideTitleSection = true;
        render(item, documentTitle ? (insideTitleSection && item.node.type !== 'title' ? 3 : 2) : 1);
    });
    return parts.join('\n\n') + '\n';
};

export const hasEmbeddedImages = (outline: MarkdownOutlineItem[]): boolean => outline.some(item =>
    !!item.node.coverImage?.startsWith('data:') || item.images.some(image => !!image.coverImage?.startsWith('data:')) || hasEmbeddedImages(item.children)
);

export const createMarkdownDownload = (outline: MarkdownOutlineItem[], filename: string, documentTitle?: string): { blob: Blob; filename: string } => {
    const safeName = filename.replace(/\.(md|zip)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim() || 'article';
    const assets: Record<string, Uint8Array> = {};
    const imagePaths = new Map<string, string>();
    const addImage = (node: WikiNode) => {
        const source = node.coverImage;
        if (!source?.startsWith('data:')) return;
        const match = /^data:(image\/[^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(source);
        if (!match) throw new Error(`Unsupported embedded image: ${node.title || node.id}`);
        const mime = match[1].toLowerCase();
        const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/svg+xml' ? 'svg' : mime.split('/')[1].replace(/[^a-z0-9]/g, '') || 'img';
        const path = `images/image-${Object.keys(assets).length + 1}.${extension}`;
        assets[path] = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
        imagePaths.set(node.id, path);
    };
    const collect = (items: MarkdownOutlineItem[]) => items.forEach(item => {
        addImage(item.node);
        item.images.forEach(addImage);
        collect(item.children);
    });
    collect(outline);

    const content = renderMarkdown(outline, documentTitle, node => imagePaths.get(node.id) || node.coverImage);
    if (Object.keys(assets).length) {
        const archive = zipSync({ [`${safeName}.md`]: strToU8(content), ...assets }, { level: 0 });
        return { blob: new Blob([archive], { type: 'application/zip' }), filename: `${safeName}.zip` };
    }
    return { blob: new Blob([content], { type: 'text/markdown;charset=utf-8' }), filename: `${safeName}.md` };
};

export const downloadMarkdown = (outline: MarkdownOutlineItem[], filename: string, documentTitle?: string): string => {
    const download = createMarkdownDownload(outline, filename, documentTitle);
    const url = URL.createObjectURL(download.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = download.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return download.filename;
};
