export type WritingFont = 'sans' | 'serif' | 'mono';

export interface WritingStyle {
    font: WritingFont;
    size: number;
    color: string;
}

export interface WritingTemplate {
    format: 'iamtired-writing-template';
    version: 1;
    name: string;
    header: WritingStyle;
    body: WritingStyle;
    caption: WritingStyle;
}

export const builtInWritingTemplates: WritingTemplate[] = [
    {
        format: 'iamtired-writing-template', version: 1, name: 'Default',
        header: { font: 'sans', size: 18, color: 'var(--node-text-0)' },
        body: { font: 'sans', size: 15, color: 'var(--node-text-0)' },
        caption: { font: 'sans', size: 11, color: 'var(--node-text-3)' }
    },
    {
        format: 'iamtired-writing-template', version: 1, name: 'Reading',
        header: { font: 'serif', size: 24, color: 'var(--node-text-0)' },
        body: { font: 'serif', size: 18, color: 'var(--node-text-1)' },
        caption: { font: 'sans', size: 12, color: 'var(--node-text-3)' }
    },
    {
        format: 'iamtired-writing-template', version: 1, name: 'Compact',
        header: { font: 'sans', size: 16, color: 'var(--node-text-0)' },
        body: { font: 'sans', size: 13, color: 'var(--node-text-1)' },
        caption: { font: 'sans', size: 9, color: 'var(--node-text-3)' }
    }
];

const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const isStyle = (value: unknown): value is WritingStyle =>
    isObject(value) &&
    (value.font === 'sans' || value.font === 'serif' || value.font === 'mono') &&
    typeof value.size === 'number' && Number.isInteger(value.size) && value.size >= 6 && value.size <= 72 &&
    typeof value.color === 'string' && (/^var\(--node-text-[0-4]\)$/.test(value.color) || /^#[0-9a-f]{6}$/i.test(value.color));

export const parseWritingTemplate = (value: unknown): WritingTemplate => {
    if (!isObject(value) || value.format !== 'iamtired-writing-template' || value.version !== 1 ||
        typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80 ||
        !isStyle(value.header) || !isStyle(value.body) || !isStyle(value.caption)) {
        throw new Error('Invalid writing template JSON. Export a template from Settings for the supported format.');
    }
    return {
        format: 'iamtired-writing-template', version: 1, name: value.name.trim(),
        header: { ...value.header }, body: { ...value.body }, caption: { ...value.caption }
    };
};
