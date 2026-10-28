import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeLocalFiles, readFileSetting, writeFileSetting, flushLocalFiles, fileWorkspace, readFileCanvas, writeFileCanvas, activateFileWorkspace, browserWorkspaceSettings } from './localFiles';

test('paired browser migrates old secrets, separates workspace settings, detects save failures and freezes writes during a switch', async () => {
    const storage = new Map<string, string>([
        ['user:local-browser:iamtired_local_mcp_token', 'paired-token'],
        ['user:local-browser:iamtired_ai_config', '{"apiKey":"legacy-key"}']
    ]);
    const originalStorage = globalThis.localStorage;
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    let reloads = 0;
    let failWrite = false;
    const calls: { route: string; input: any }[] = [];
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null
    } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { reload: () => { reloads++; } } } });
    globalThis.fetch = (async (url, options) => {
        const route = String(url).split('/local/files/')[1];
        const input = options?.body ? JSON.parse(String(options.body)) : null;
        calls.push({ route, input });
        assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer paired-token');
        const value = route === 'status' ? { workspace: 'D:\\Work', configPath: 'C:\\Users\\test\\ctrlwrite_config\\config.json', values: {} }
            : route === 'settings/read' ? { revision: 'settings-1', value: { iamtired_global_md_path: 'rules.md' } }
            : route === 'canvas/read' ? { revision: 'canvas-1', value: { version: 3 } }
            : route === 'canvas/write' && failWrite ? { error: 'file conflict' }
            : route === 'activate' ? { workspace: 'D:\\Next' }
            : { revision: 'next-revision' };
        return new Response(JSON.stringify(value), { status: route === 'canvas/write' && failWrite ? 400 : 200 });
    }) as typeof fetch;
    try {
        await initializeLocalFiles();
        assert.equal(fileWorkspace(), 'D:\\Work');
        assert.equal(readFileSetting('iamtired_ai_config'), '{"apiKey":"legacy-key"}');
        assert.equal(storage.has('user:local-browser:iamtired_ai_config'), false);
        assert.equal(readFileSetting('iamtired_global_md_path'), 'rules.md');
        writeFileSetting('iamtired_ai_profiles', '{"openai":{"apiKey":"new-key"}}');
        writeFileSetting('iamtired_system_skill_ids', '["skill-id"]');
        await flushLocalFiles();
        const savedSettings = calls.find(call => call.route === 'settings/write')!.input.value;
        assert.equal(savedSettings.iamtired_system_skill_ids, '["skill-id"]');
        assert.ok(!JSON.stringify(savedSettings).includes('new-key'));
        assert.ok(!JSON.stringify(browserWorkspaceSettings()).includes('new-key'));
        await assert.rejects(writeFileCanvas({}), /尚未成功读取/);
        await readFileCanvas();
        await writeFileCanvas({ version: 3 });
        assert.equal(calls.find(call => call.route === 'canvas/write')!.input.revision, 'canvas-1');
        failWrite = true;
        await assert.rejects(writeFileCanvas({ version: 3 }), /file conflict/);
        await activateFileWorkspace('D:\\Next');
        assert.equal(reloads, 1);
        assert.equal(storage.get('user:local-browser:file_workspace'), 'D:\\Next');
        await assert.rejects(writeFileCanvas({ version: 3 }), /正在切换/);
    } finally {
        globalThis.fetch = originalFetch;
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
        Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
});
