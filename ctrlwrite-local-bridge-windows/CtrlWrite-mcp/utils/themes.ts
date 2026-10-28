import { workspaceStorage } from './workspaceStorage';
export type ThemeId = 'paper' | 'forest' | 'ocean' | 'graphite' | 'clay';

type Palette = {
    canvas: string;
    surface: string;
    raised: string;
    text: string;
    muted: string;
    subtle: string;
    accent: string;
    solid: string;
    hover: string;
};

type ThemePreset = {
    id: ThemeId;
    name: string;
    subtitle: string;
    description: string;
    light: Palette;
    dark: Palette;
};

export const themePresets: ThemePreset[] = [
    {
        id: 'paper', name: '暖纸', subtitle: 'PAPER & INK', description: '奶油纸色 · 胡桃木 · 编辑手记',
        light: { canvas: '#eeeae1', surface: '#faf7f0', raised: '#fffdf8', text: '#302c25', muted: '#736b5d', subtle: '#8b8172', accent: '#8a6740', solid: '#795635', hover: '#634429' },
        dark: { canvas: '#201e1a', surface: '#2b2822', raised: '#353128', text: '#eee6d7', muted: '#bbae99', subtle: '#978c7b', accent: '#d2b787', solid: '#80603c', hover: '#947048' }
    },
    {
        id: 'forest', name: '松林', subtitle: 'MOSS & LINEN', description: '亚麻白 · 苔藓绿 · 安静思考',
        light: { canvas: '#e8ece4', surface: '#f6f8f1', raised: '#fcfdf8', text: '#293c30', muted: '#61715f', subtle: '#7b8975', accent: '#466b50', solid: '#3b6045', hover: '#2d4d36' },
        dark: { canvas: '#151e19', surface: '#1e2a22', raised: '#28372c', text: '#e5ede0', muted: '#a6b7a3', subtle: '#82967f', accent: '#a3c49d', solid: '#486b4d', hover: '#567d5c' }
    },
    {
        id: 'ocean', name: '深海', subtitle: 'TIDE & SLATE', description: '雾蓝灰 · 深海青 · 清晰专注',
        light: { canvas: '#e8edf0', surface: '#f5f9fa', raised: '#fcfefe', text: '#263c47', muted: '#60757f', subtle: '#7e9099', accent: '#3b6e7d', solid: '#345f70', hover: '#284b59' },
        dark: { canvas: '#141e28', surface: '#1c2b38', raised: '#263847', text: '#e4edf2', muted: '#a1b7c3', subtle: '#7d98a7', accent: '#92c1cd', solid: '#3c697b', hover: '#477d91' }
    },
    {
        id: 'graphite', name: '石墨', subtitle: 'GRAPHITE STUDIO', description: '柔雾灰 · 铂银色 · 极简工作室',
        light: { canvas: '#ededf0', surface: '#f9f9fb', raised: '#ffffff', text: '#33333c', muted: '#6d6b79', subtle: '#888592', accent: '#686479', solid: '#5e586f', hover: '#494458' },
        dark: { canvas: '#19191e', surface: '#24242c', raised: '#2e2e38', text: '#eae8ef', muted: '#b0acbc', subtle: '#8f899e', accent: '#bcb5cc', solid: '#6c627e', hover: '#7d7290' }
    },
    {
        id: 'clay', name: '赤陶', subtitle: 'CLAY & SAND', description: '沙岩米 · 陶土红 · 温暖灵感',
        light: { canvas: '#f0e6de', surface: '#fcf5ef', raised: '#fffbf7', text: '#44342c', muted: '#826d60', subtle: '#9b8272', accent: '#a35e47', solid: '#96543d', hover: '#7a422f' },
        dark: { canvas: '#251d1a', surface: '#322722', raised: '#3e3029', text: '#f2e5da', muted: '#c4a898', subtle: '#a88a79', accent: '#dfa98d', solid: '#915d47', hover: '#a66c53' }
    }
];

const rgb = (hex: string, separator = ' ') => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(separator);

export const themeVariables = (id: ThemeId, dark: boolean): Record<`--${string}`, string> => {
    const preset = themePresets.find(theme => theme.id === id) || themePresets[3];
    const colors = dark ? preset.dark : preset.light;
    const mix = (color: string, amount: number) => `color-mix(in srgb, ${color} ${amount}%, ${colors.surface})`;
    return {
        '--bg-body': colors.canvas,
        '--surface': colors.surface,
        '--surface-raised': colors.raised,
        '--text-main': colors.text,
        '--text-muted': colors.muted,
        '--text-subtle': colors.subtle,
        '--accent': colors.accent,
        '--accent-solid': colors.solid,
        '--accent-hover': colors.hover,
        '--accent-soft': mix(colors.accent, dark ? 14 : 9),
        '--accent-rgb': rgb(colors.accent),
        '--accent-solid-rgb': rgb(colors.solid),
        '--accent-hover-rgb': rgb(colors.hover),
        '--glass-bg': `color-mix(in srgb, ${colors.surface} 94%, transparent)`,
        '--glass-border': mix(colors.text, dark ? 12 : 13),
        '--border-strong': mix(colors.text, dark ? 24 : 25),
        '--grid-rgb': rgb(colors.muted, ', '),
        '--panel-shadow': dark ? '0 16px 48px #00000030, 0 2px 8px #00000020' : '0 12px 36px #3028180a, 0 2px 8px #30281806',
        '--node-shadow': dark ? '0 6px 24px #00000020' : '0 4px 20px #30281808',
        '--node-text-0': colors.text,
        '--node-text-1': colors.text,
        '--node-text-2': mix(colors.text, 80),
        '--node-text-3': colors.muted,
        '--node-text-4': colors.subtle,
        '--node-bg-0': colors.surface,
        '--node-bg-1': mix('#b56b63', dark ? 24 : 14),
        '--node-bg-2': mix('#b88859', dark ? 24 : 14),
        '--node-bg-3': mix('#afa163', dark ? 24 : 14),
        '--node-bg-4': mix('#758f74', dark ? 24 : 14),
        '--node-bg-5': mix('#718d9e', dark ? 24 : 14),
        '--node-bg-6': mix('#95839e', dark ? 24 : 14)
    };
};

export const readAppearance = (): { theme: ThemeId; dark: boolean } | null => {
    try {
        const saved = JSON.parse(workspaceStorage.getItem('iamtired_appearance') || 'null');
        if (saved && themePresets.some(theme => theme.id === saved.theme) && typeof saved.dark === 'boolean') return saved;
    } catch {}
    return null;
};
