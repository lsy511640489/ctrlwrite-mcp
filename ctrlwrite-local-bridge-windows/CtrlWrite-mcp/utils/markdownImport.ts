import { fromMarkdown } from 'mdast-util-from-markdown';
import type { RootContent } from 'mdast';
import type { CanvasDraft } from '../server/canvasModel';
import type { Tab } from '../types/tabTypes';

type DraftTab = CanvasDraft['tabs'][number];
type DraftNode = DraftTab['nodes'][number];
type ArticleEntry = ArticleSection | { kind: 'body'; content: string };
interface ArticleSection {
    kind: 'section';
    title: string;
    depth: number;
    entries: ArticleEntry[];
}

const textOf = (item: { value?: string; children?: unknown[] }): string =>
    typeof item.value === 'string' ? item.value : (item.children || []).map(child => textOf(child as Parameters<typeof textOf>[0])).join('');

const splitParagraph = (content: string): string[] => {
    const parts: string[] = [];
    let remaining = content;
    while (remaining.length > 600) {
        const prefix = remaining.slice(0, 600);
        const boundary = Math.max(...['。', '！', '？', '；', '.', '!', '?', ';', '\n', ' '].map(separator => prefix.lastIndexOf(separator)));
        let offset = boundary >= 300 ? boundary + 1 : 600;
        if (/[\uD800-\uDBFF]/.test(remaining[offset - 1])) offset--;
        parts.push(remaining.slice(0, offset));
        remaining = remaining.slice(offset);
    }
    if (remaining) parts.push(remaining);
    return parts;
};

const headingOf = (block: RootContent, boldDepth: number): { title: string; depth: number } | undefined => {
    if (block.type === 'heading') return { title: textOf(block).trim(), depth: block.depth };
    if (block.type !== 'paragraph' || block.children.length !== 1 || block.children[0].type !== 'strong') return;
    const title = textOf(block).trim();
    if (!title || title.length > 80 || /[\n。！？.!?；;：:]$/.test(title) || title.includes('\n')) return;
    const numbering = /^(\d+(?:\.\d+)*)(?:[、.)．\s]|$)/.exec(title);
    const depth = numbering ? Math.min(6, numbering[1].split('.').length + 1)
        : /^第[一二三四五六七八九十百零〇\d]+(?:章|篇|部分)/.test(title) || /^[一二三四五六七八九十]+、/.test(title) ? 2
        : /^第[一二三四五六七八九十百零〇\d]+节/.test(title) || /^[（(][一二三四五六七八九十]+[）)]/.test(title) ? 3
        : boldDepth;
    return { title, depth };
};

export function markdownDraft(markdown: string, filename: string): CanvasDraft {
    markdown = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const ast = fromMarkdown(markdown);
    const fallbackTitle = filename.replace(/\.(md|markdown)$/i, '') || 'Imported document';
    const documentHeading = ast.children[0]?.type === 'heading' && ast.children[0].depth === 1 ? ast.children[0] : undefined;
    const tab: DraftTab = { title: documentHeading ? textOf(documentHeading).trim() || fallbackTitle : fallbackTitle, nodes: [], connections: [], skillGroups: [] };
    const nativeHeadings = ast.children.filter(block => block.type === 'heading' && block !== documentHeading);
    const boldDepth = nativeHeadings.length ? Math.min(6, Math.min(...nativeHeadings.map(block => block.type === 'heading' ? block.depth : 6)) + 1) : 2;
    const definitions = ast.children.filter(block => block.type === 'definition')
        .map(block => markdown.slice(block.position!.start.offset, block.position!.end.offset)).join('\n');
    const root: ArticleSection = { kind: 'section', title: tab.title, depth: 0, entries: [] };
    const stack = [root];
    for (let blockIndex = 0; blockIndex < ast.children.length; blockIndex++) {
        const block = ast.children[blockIndex];
        const start = block.position?.start.offset;
        const end = block.position?.end.offset;
        if (start === undefined || end === undefined || block.type === 'definition' || block === documentHeading) continue;
        const heading = headingOf(block, boldDepth);
        if (heading) {
            while (stack.length > 1 && stack.at(-1)!.depth >= heading.depth) stack.pop();
            const section: ArticleSection = { kind: 'section', ...heading, entries: [] };
            stack.at(-1)!.entries.push(section);
            stack.push(section);
            continue;
        }
        let content = markdown.slice(start, end);
        const formula = block.type === 'paragraph'
            ? /^(?:\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])(?=\s*$|[ \t]*\n)/.exec(markdown.slice(start)) : null;
        if (formula) {
            const formulaEnd = start + formula[0].length;
            const overlapsTail = ast.children.some(candidate => {
                const candidateStart = candidate.position?.start.offset;
                const candidateEnd = candidate.position?.end.offset;
                return candidateStart !== undefined && candidateEnd !== undefined && candidateStart < formulaEnd && candidateEnd > formulaEnd;
            });
            if (!overlapsTail && formulaEnd >= end) {
                content = formula[0];
                while (blockIndex + 1 < ast.children.length && ast.children[blockIndex + 1].position!.end.offset! <= formulaEnd) blockIndex++;
            }
        }
        const isPlainParagraph = block.type === 'paragraph' && block.children.every(child => child.type === 'text') && !/[$\\|]/.test(content);
        for (const part of isPlainParagraph ? splitParagraph(content) : [content]) stack.at(-1)!.entries.push({ kind: 'body', content: part });
    }

    const addNode = (type: DraftNode['type'], title: string, content: string, parentKey?: string, omitTitleInMarkdown = false): DraftNode => {
        const node: DraftNode = { key: `node-${tab.nodes.length + 1}`, type, title, content, parentKey, omitTitleInMarkdown,
            width: type === 'group' ? 440 : 380, height: type === 'group' ? 160 : 300 };
        tab.nodes.push(node);
        return node;
    };
    const arrange = (nodes: DraftNode[], group?: DraftNode) => {
        const padding = group ? 28 : 0;
        const top = group ? 76 : 0;
        const availableWidth = group ? 860 : 1800;
        let cursorX = padding;
        let cursorY = top;
        let rowHeight = 0;
        let right = padding;
        for (const node of nodes) {
            if (cursorX > padding && cursorX + node.width! > availableWidth - padding) {
                cursorX = padding;
                cursorY += rowHeight + 40;
                rowHeight = 0;
            }
            node.position = { x: cursorX, y: cursorY };
            right = Math.max(right, cursorX + node.width!);
            rowHeight = Math.max(rowHeight, node.height!);
            cursorX += node.width! + 36;
        }
        if (group) {
            group.width = Math.max(440, right + padding);
            group.height = Math.max(160, cursorY + rowHeight + padding);
        }
    };
    const renderEntries = (entries: ArticleEntry[], parentKey?: string): DraftNode[] => {
        const siblings: DraftNode[] = [];
        for (const entry of entries) {
            if (entry.kind === 'body') {
                siblings.push(addNode('text', '正文', entry.content, parentKey, true));
                continue;
            }
            const hasSubsections = entry.entries.some(child => child.kind === 'section');
            if (hasSubsections || !entry.entries.length) {
                const group = addNode('group', entry.title, '', parentKey);
                const children = renderEntries(entry.entries, group.key);
                arrange(children, group);
                siblings.push(group);
            } else {
                let first: DraftNode | undefined;
                for (const child of entry.entries) {
                    if (child.kind !== 'body') continue;
                    const node = addNode('text', first ? `${entry.title} · 续` : entry.title, child.content, parentKey, !!first);
                    if (first) tab.connections.push({ sourceKey: first.key, targetKey: node.key });
                    else first = node;
                    siblings.push(node);
                }
            }
        }
        return siblings;
    };
    const roots = renderEntries(root.entries);
    if (!roots.length) roots.push(addNode('text', tab.title, documentHeading ? '' : markdown, undefined, true));
    arrange(roots);
    if (definitions) tab.nodes.filter(node => node.content).forEach(node => { node.content += `\n\n${definitions}`; });
    return { tabs: [tab] };
}

export function importMarkdown(markdown: string, filename: string): Tab {
    if (!markdown.replace(/^\uFEFF/, '').trim()) throw new Error('Markdown 文件为空，请选择有内容的文件。');
    const source = markdownDraft(markdown, filename).tabs[0];
    const createId = () => `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ids = new Map(source.nodes.map(node => [node.key, createId()]));
    return {
        id: createId(), title: source.title,
        nodes: source.nodes.map((node, index) => ({
            id: ids.get(node.key)!, type: node.type, title: node.title, content: node.content,
            parentId: node.parentKey ? ids.get(node.parentKey) : undefined,
            position: node.position || { x: 0, y: index * 350 },
            width: node.width || 380, height: node.height || 300,
            omitTitleInMarkdown: node.omitTitleInMarkdown, zIndex: index + 1
        })),
        connections: source.connections.map(connection => ({
            id: createId(), sourceId: ids.get(connection.sourceKey)!, targetId: ids.get(connection.targetKey)!
        })),
        viewport: { x: 80, y: 100, scale: 1 }
    };
}
