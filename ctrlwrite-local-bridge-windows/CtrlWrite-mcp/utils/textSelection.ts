export interface TextRange {
    start: number;
    end: number;
}

export const resolveEditorTextSelection = (content: string, editorValue: string, range: TextRange): TextRange | null => {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > editorValue.length) return null;
    if (content.replace(/\r\n?/g, '\n') !== editorValue) return null;
    let sourceOffset = 0;
    let start = 0;
    for (let editorOffset = 0; editorOffset < range.end; editorOffset++) {
        if (editorOffset === range.start) start = sourceOffset;
        sourceOffset += content[sourceOffset] === '\r' && content[sourceOffset + 1] === '\n' ? 2 : 1;
    }
    return { start, end: sourceOffset };
};

export const resolveTextSelection = (content: string, text: string, range?: TextRange): TextRange | null => {
    if (!text.trim()) return null;
    if (range) {
        return content.slice(range.start, range.end) === text ? range : null;
    }
    const start = content.indexOf(text);
    if (start < 0 || content.indexOf(text, start + 1) >= 0) return null;
    return { start, end: start + text.length };
};

export const replaceTextSelection = (content: string, text: string, range: TextRange, replacement: string): string | null => {
    if (content.slice(range.start, range.end) !== text) return null;
    return content.slice(0, range.start) + replacement + content.slice(range.end);
};
