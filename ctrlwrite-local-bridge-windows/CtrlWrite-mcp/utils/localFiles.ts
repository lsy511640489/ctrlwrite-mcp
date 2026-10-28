type BridgeStatus = { workspace: string | null; configPath: string; values: Record<string, string> };
type DocumentResult = { value: any; revision: string | null };
export const secretSetting = (key: string) => key === 'iamtired_ai_config' || key === 'iamtired_ai_profiles';
const localPrefix = 'user:local-browser:';
const tokenKey = localPrefix + 'iamtired_local_mcp_token';
const workspaceMarker = localPrefix + 'file_workspace';
let status: BridgeStatus | null = null;
let workspace: string | null = null;
let secrets: Record<string, string> = {};
let settings: Record<string, string> = {};
let settingsRevision: string | null = null;
let canvasRevision: string | null = null;
let canvasLoaded = false;
let errorMessage = '';
let frozen = false;
let pending: Promise<unknown> = Promise.resolve();
let configDirty = false;
let settingsDirty = false;

export const fileWorkspace = () => workspace;
export const localFileState = () => ({ workspace, configPath: status?.configPath || '', connected: !!status, error: errorMessage });
export const fileWritesPaused = () => frozen;

export async function localFileRequest<T>(route: string, input?: unknown): Promise<T> {
    const token = localStorage.getItem(tokenKey);
    if (!token) throw new Error('请先在 Data 设置中输入本机配对令牌。');
    const response = await fetch(`http://127.0.0.1:39173/local/files/${route}`, {
        method: input === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: input === undefined ? undefined : JSON.stringify(input),
        signal: AbortSignal.timeout(route === 'browse' ? 310000 : 25000), targetAddressSpace: 'loopback'
    } as RequestInit & { targetAddressSpace: 'loopback' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '本机文件操作失败。');
    return result as T;
}

export async function initializeLocalFiles() {
    workspace = localStorage.getItem(workspaceMarker);
    try {
        if (!localStorage.getItem(tokenKey)) return;
        const next = await localFileRequest<BridgeStatus>('status');
        const loaded = next.workspace ? await localFileRequest<DocumentResult>('settings/read', { workspace: next.workspace }) : null;
        status = next;
        workspace = next.workspace;
        secrets = next.values;
        settings = loaded?.value || {};
        settingsRevision = loaded?.revision || null;
        if (workspace) localStorage.setItem(workspaceMarker, workspace); else localStorage.removeItem(workspaceMarker);
        for (const key of ['iamtired_ai_config', 'iamtired_ai_profiles']) {
            const legacy = localStorage.getItem(localPrefix + key);
            if (!secrets[key] && legacy) { secrets[key] = legacy; configDirty = true; }
        }
        if (configDirty) await flushLocalFiles();
        errorMessage = '';
    } catch (error) {
        status = null;
        errorMessage = error instanceof Error ? error.message : '本机文件服务未连接。';
    }
}

export function readFileSetting(key: string): string | null | undefined {
    if (secretSetting(key)) return secrets[key] ?? localStorage.getItem(localPrefix + key);
    if (workspace && !key.includes('token')) return settings[key] ?? null;
    return undefined;
}

export function writeFileSetting(key: string, value: string) {
    if (frozen) throw new Error('正在切换工作区，请等待页面重新加载。');
    if (secretSetting(key)) { secrets[key] = value; configDirty = true; return true; }
    if (workspace && !key.includes('token')) {
        if (settings[key] !== value) { settings[key] = value; settingsDirty = true; }
        return true;
    }
    return false;
}

export function flushLocalFiles() {
    const result = pending.catch(() => undefined).then(async () => {
        if (frozen) return;
        if (workspace && !status) throw new Error(errorMessage || '本机工作区未连接，请启动服务后刷新。');
        if (configDirty) {
            const snapshot = { ...secrets };
            await localFileRequest('config', { values: snapshot });
            if (JSON.stringify(snapshot) === JSON.stringify(secrets)) configDirty = false;
            for (const key of Object.keys(snapshot)) localStorage.removeItem(localPrefix + key);
        }
        if (workspace && settingsDirty) {
            const snapshot = { ...settings };
            const result = await localFileRequest<{ revision: string }>('settings/write', { workspace, revision: settingsRevision, value: snapshot });
            settingsRevision = result.revision;
            if (JSON.stringify(snapshot) === JSON.stringify(settings)) settingsDirty = false;
        }
    });
    pending = result;
    return result;
}

export async function readFileCanvas() {
    if (!status) throw new Error(errorMessage || '工作区服务未连接，请启动本机桥接后刷新。');
    const result = await localFileRequest<DocumentResult>('canvas/read', { workspace });
    canvasRevision = result.revision;
    canvasLoaded = true;
    return result.value;
}

export async function writeFileCanvas(value: unknown) {
    const result = pending.catch(() => undefined).then(async () => {
        if (frozen) throw new Error('工作区正在切换。');
        if (!canvasLoaded || !status) throw new Error('工作区尚未成功读取，已停止保存，避免覆盖原文件。');
        const saved = await localFileRequest<{ revision: string }>('canvas/write', { workspace, revision: canvasRevision, value });
        canvasRevision = saved.revision;
    });
    pending = result;
    await result;
    await flushLocalFiles();
}

export async function activateFileWorkspace(directory: string, migrate?: unknown) {
    await flushLocalFiles();
    frozen = true;
    try {
        const result = await localFileRequest<{ workspace: string }>('activate', { directory, migrate });
        localStorage.setItem(workspaceMarker, result.workspace);
        window.location.reload();
    } catch (error) { frozen = false; throw error; }
}

export async function detachFileWorkspace() {
    await flushLocalFiles();
    frozen = true;
    try {
        await localFileRequest('detach', {});
        localStorage.removeItem(workspaceMarker);
        window.location.reload();
    } catch (error) { frozen = false; throw error; }
}

export function browserWorkspaceSettings() {
    const result: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index++) {
        const storageKey = localStorage.key(index)!;
        const key = storageKey.slice(localPrefix.length);
        if (storageKey.startsWith(localPrefix) && !secretSetting(key) && !key.includes('token') && key !== 'file_workspace' && key !== 'iamtired_save') result[key] = localStorage.getItem(storageKey)!;
    }
    return workspace ? { ...settings } : result;
}
