import { flushLocalFiles, readFileSetting, writeFileSetting } from './localFiles';

let identity: string | null = null;
let cloud = false;
let localOnly = false;
let values: Record<string, string> = {};
let pending = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let installed = false;
const controllers = new Set<AbortController>();

export const BROWSER_WORKSPACE_ID = 'local-browser';
export const workspaceUser = () => identity;
export function assertWorkspaceUser(expected: string | null) {
    if (expected !== identity) throw new Error('账号已切换，已停止原工作区的操作。');
}
export const isCloudWorkspace = () => cloud;
export const isLocalOnlyWorkspace = () => localOnly;
export const workspaceKey = (key: string) => `user:${identity || 'signed-out'}:${key}`;

export function installWorkspaceRequests() {
    if (installed) return;
    installed = true;
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/auth/')) return original(input, options);
        const actor = identity;
        const controller = new AbortController();
        controllers.add(controller);
        const upstream = options?.signal || (input instanceof Request ? input.signal : undefined);
        const cancel = () => controller.abort();
        upstream?.addEventListener('abort', cancel, { once: true });
        if (upstream?.aborted) controller.abort();
        const headers = new Headers(options?.headers || (input instanceof Request ? input.headers : undefined));
        if (actor) headers.set('X-Workspace-User', actor);
        try {
            const response = await original(input, { ...options, headers, signal: controller.signal });
            if (actor !== identity) throw new DOMException('账号已切换。', 'AbortError');
            return response;
        } finally {
            controllers.delete(controller);
            upstream?.removeEventListener('abort', cancel);
        }
    };
}

export async function prepareWorkspace(userId: string | null, useCloud: boolean, useLocalOnly = false) {
    if (identity === userId && cloud === useCloud && localOnly === useLocalOnly) return;
    for (const controller of controllers) controller.abort();
    clearTimeout(timer);
    identity = userId;
    cloud = useCloud;
    localOnly = useLocalOnly;
    values = {};
    if (userId && useLocalOnly && typeof navigator !== 'undefined') void navigator.storage?.persist?.().catch(() => undefined);
    if (userId && useCloud) {
        try {
            const response = await fetch('/api/settings', { cache: 'no-store' });
            if (!response.ok) throw new Error('无法读取你的工作区设置，请重试。');
            const data = await response.json();
            if (identity === userId) values = data.values || {};
        } catch (error) {
            if (identity === userId) { identity = null; cloud = false; }
            throw error;
        }
    }
}

export function flushWorkspaceSettings() {
    clearTimeout(timer);
    if (localOnly) return flushLocalFiles();
    if (!cloud || !identity) return Promise.resolve();
    const actor = identity;
    const snapshot = JSON.stringify({ values });
    pending = pending.catch(() => undefined).then(async () => {
        if (actor !== identity) return;
        const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: snapshot });
        if (!response.ok) throw new Error('设置未能保存到服务器，请重试。');
    });
    return pending;
}

export const workspaceStorage = {
    getItem(key: string) {
        if (localOnly) { const value = readFileSetting(key); if (value !== undefined) return value; }
        return cloud ? values[key] ?? null : localStorage.getItem(workspaceKey(key));
    },
    setItem(key: string, value: string) {
        if (!identity) return;
        if (localOnly && writeFileSetting(key, value)) {
            clearTimeout(timer);
            timer = setTimeout(() => { void flushLocalFiles().catch(() => window.dispatchEvent(new Event('iamtired:settings-save-failed'))); }, 400);
            return;
        }
        if (!cloud) { localStorage.setItem(workspaceKey(key), value); return; }
        values[key] = value;
        clearTimeout(timer);
        timer = setTimeout(() => { void flushWorkspaceSettings().catch(() => window.dispatchEvent(new Event('iamtired:settings-save-failed'))); }, 400);
    }
};

export async function flushWorkspaceCanvas() {
    const promises: Promise<unknown>[] = [];
    window.dispatchEvent(new CustomEvent('iamtired:flush-canvas', { detail: { waitUntil: (promise: Promise<unknown>) => promises.push(promise) } }));
    if (!promises.length) throw new Error('画布正在加载，请稍后再保存。');
    await Promise.all(promises);
    await flushWorkspaceSettings();
}
