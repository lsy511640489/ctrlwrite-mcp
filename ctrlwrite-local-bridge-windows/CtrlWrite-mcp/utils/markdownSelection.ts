import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Element as HastElement, Root, RootContent } from 'hast';
import type { TextRange } from './textSelection';

export const rehypeSelectionPositions = () => (tree: Root) => {
    const visit = (parent: Root | HastElement) => {
        parent.children = parent.children.map(child => {
            if (child.type === 'element') {
                if (child.properties['data-markdown-math']) return child;
                visit(child);
                if (child.position && ['strong', 'em', 'del', 'a', 'code'].includes(child.tagName)) {
                    child.properties['data-markdown-inline-start'] = child.position.start.offset;
                    child.properties['data-markdown-inline-end'] = child.position.end.offset;
                }
            }
            const position = child.position || (parent.type === 'element' && parent.tagName === 'code' ? parent.position : undefined);
            if (child.type !== 'text' || position?.start.offset === undefined || position.end.offset === undefined) return child;
            return {
                type: 'element', tagName: 'span',
                properties: {
                    'data-markdown-text': true,
                    'data-markdown-start': position.start.offset,
                    'data-markdown-end': position.end.offset
                },
                children: [child]
            } satisfies HastElement;
        }) as RootContent[];
    };
    visit(tree);
};

export const mapMarkdownTextOffset = (source: string, rendered: string, offset: number): number | null => {
    if (offset < 0 || offset > rendered.length) return null;
    if (source === rendered) return offset;
    let decoded = '';
    const boundaries = [0];
    for (let index = 0; index < source.length;) {
        let length = 1;
        let value = source[index];
        if (value === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(source[index + 1] || '')) {
            length = 2;
            value = source[index + 1];
        } else if (value === '&') {
            const entity = source.slice(index).match(/^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);/);
            if (entity) {
                const paragraph = fromMarkdown(entity[0]).children[0];
                const text = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
                if (text?.type === 'text') {
                    length = entity[0].length;
                    value = text.value;
                }
            }
        } else if (value === '\r') {
            length = source[index + 1] === '\n' ? 2 : 1;
            value = '\n';
        }
        decoded += value;
        for (let unit = 1; unit <= value.length; unit++) {
            boundaries.push(unit === value.length ? index + length : index);
        }
        index += length;
    }
    if (decoded === rendered) return boundaries[offset];
    const exact = source.indexOf(rendered);
    return rendered && exact >= 0 && source.indexOf(rendered, exact + 1) < 0 ? exact + offset : null;
};

export const getMarkdownSelectionRange = (root: HTMLElement, selection: Selection, content: string): TextRange | null => {
    if (selection.isCollapsed || !selection.rangeCount) return null;
    const selected = selection.getRangeAt(0);
    if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) return null;
    let start: number | undefined;
    let end: number | undefined;
    for (const span of root.querySelectorAll<HTMLElement>('[data-markdown-text], [data-markdown-math]')) {
        if (!selected.intersectsNode(span)) continue;
        const spanRange = document.createRange();
        spanRange.selectNodeContents(span);
        const overlap = selected.cloneRange();
        if (overlap.compareBoundaryPoints(Range.START_TO_START, spanRange) < 0) overlap.setStart(span, 0);
        if (overlap.compareBoundaryPoints(Range.END_TO_END, spanRange) > 0) overlap.setEnd(span, span.childNodes.length);
        if (overlap.collapsed) continue;
        if (span.hasAttribute('data-markdown-math')) {
            start ??= Number(span.dataset.markdownStart);
            end = Number(span.dataset.markdownEnd);
            continue;
        }
        const prefix = document.createRange();
        prefix.selectNodeContents(span);
        prefix.setEnd(overlap.startContainer, overlap.startOffset);
        const from = prefix.toString().length;
        prefix.setEnd(overlap.endContainer, overlap.endOffset);
        const to = prefix.toString().length;
        const sourceStart = Number(span.dataset.markdownStart);
        const sourceEnd = Number(span.dataset.markdownEnd);
        const source = content.slice(sourceStart, sourceEnd);
        const rendered = span.textContent || '';
        const mappedStart = mapMarkdownTextOffset(source, rendered, from);
        const mappedEnd = mapMarkdownTextOffset(source, rendered, to);
        if (mappedStart === null || mappedEnd === null) return null;
        start ??= sourceStart + mappedStart;
        end = sourceStart + mappedEnd;
    }
    if (start === undefined || end === undefined || start >= end) return null;
    for (const inline of root.querySelectorAll<HTMLElement>('[data-markdown-inline-start]')) {
        const inlineStart = Number(inline.dataset.markdownInlineStart);
        const inlineEnd = Number(inline.dataset.markdownInlineEnd);
        if (start >= inlineStart && end <= inlineEnd) continue;
        const inlineRange = document.createRange();
        inlineRange.selectNodeContents(inline);
        if (selected.compareBoundaryPoints(Range.START_TO_START, inlineRange) <= 0 && selected.compareBoundaryPoints(Range.END_TO_END, inlineRange) >= 0) {
            start = Math.min(start, inlineStart);
            end = Math.max(end, inlineEnd);
        }
    }
    return { start, end };
};
