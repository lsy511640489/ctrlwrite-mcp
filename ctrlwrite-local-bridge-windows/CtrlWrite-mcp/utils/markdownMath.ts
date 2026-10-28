import type { Root as MarkdownRoot, RootContent as MarkdownContent } from 'mdast';
import type { Element, Root as HtmlRoot, RootContent as HtmlContent } from 'hast';
import type { VFile } from 'vfile';

export const remarkDisplayMath = () => (tree: MarkdownRoot, file: VFile) => {
    const source = String(file);
    const visit = (node: MarkdownRoot | MarkdownContent) => {
        if (node.type === 'inlineMath' && node.position) {
            const original = source.slice(node.position.start.offset, node.position.end.offset);
            if (original.startsWith('$$') && original.endsWith('$$')) {
                node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ['language-math', 'math-display'] } };
            }
        }
        if ('children' in node) node.children.forEach(visit);
    };
    visit(tree);
};

const isMath = (node: HtmlContent): node is Element => node.type === 'element'
    && Array.isArray(node.properties.className)
    && node.properties.className.some(name => ['language-math', 'math-inline', 'math-display'].includes(String(name)));

export const rehypeMathSource = () => (tree: HtmlRoot) => {
    const visit = (parent: HtmlRoot | Element) => {
        parent.children = parent.children.map(child => {
            if (child.type !== 'element') return child;
            const math = isMath(child) || (child.tagName === 'pre' && child.children.some(isMath));
            const position = child.position;
            if (math && position?.start.offset !== undefined && position.end.offset !== undefined) {
                return {
                    type: 'element', tagName: 'span',
                    properties: {
                        className: ['markdown-math'],
                        'data-markdown-math': true,
                        'data-markdown-start': position.start.offset,
                        'data-markdown-end': position.end.offset
                    },
                    children: [child]
                } satisfies Element;
            }
            visit(child);
            return child;
        }) as HtmlContent[];
    };
    visit(tree);
};
