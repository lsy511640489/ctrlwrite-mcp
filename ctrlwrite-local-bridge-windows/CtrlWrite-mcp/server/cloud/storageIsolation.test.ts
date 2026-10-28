import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BROWSER_WORKSPACE_ID, prepareWorkspace, workspaceStorage, workspaceKey, flushWorkspaceSettings, isLocalOnlyWorkspace } from '../../utils/workspaceStorage';
import { buildSkillConstraints } from '../../utils/skillGroups';

test('account switches isolate local keys and cloud settings do not persist secrets in localStorage', async () => {
    const local = new Map<string, string>();
    const originalStorage = globalThis.localStorage;
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value) } });
    const saved: string[] = [];
    globalThis.fetch = (async (_url, options) => {
        if (options?.method === 'PUT') saved.push(String(options.body));
        return new Response(JSON.stringify({ values: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
        await prepareWorkspace('alice', false);
        workspaceStorage.setItem('iamtired_ai_config', 'alice-key');
        const aliceKey = workspaceKey('iamtired_ai_config');
        await prepareWorkspace('bob', false);
        assert.equal(workspaceStorage.getItem('iamtired_ai_config'), null);
        assert.notEqual(workspaceKey('iamtired_ai_config'), aliceKey);
        await prepareWorkspace('alice', false);
        assert.equal(workspaceStorage.getItem('iamtired_ai_config'), 'alice-key');
        await prepareWorkspace('cloud-alice', true);
        workspaceStorage.setItem('iamtired_ai_config', 'cloud-private-key');
        await flushWorkspaceSettings();
        assert.ok(saved[0].includes('cloud-private-key'));
        assert.ok(![...local.values()].includes('cloud-private-key'));
        await prepareWorkspace('cloud-bob', true);
        assert.equal(workspaceStorage.getItem('iamtired_ai_config'), null);
        await assert.rejects(buildSkillConstraints(undefined, [], '', 'cloud-alice'), /账号已切换/);
        const previousRequests = saved.length;
        await prepareWorkspace('local-only', false, true);
        workspaceStorage.setItem('iamtired_ai_config', 'browser-key');
        await assert.rejects(flushWorkspaceSettings(), /配对令牌/);
        assert.equal(isLocalOnlyWorkspace(), true);
        assert.equal(workspaceStorage.getItem('iamtired_ai_config'), 'browser-key');
        assert.ok(![...local.values()].includes('browser-key'));
        assert.equal(saved.length, previousRequests);
        await prepareWorkspace(BROWSER_WORKSPACE_ID, false, true);
        workspaceStorage.setItem('iamtired_save', 'browser-canvas');
        await prepareWorkspace(null, false);
        await prepareWorkspace(BROWSER_WORKSPACE_ID, false, true);
        assert.equal(workspaceStorage.getItem('iamtired_save'), 'browser-canvas');
        assert.equal(workspaceKey('iamtired_save'), `user:${BROWSER_WORKSPACE_ID}:iamtired_save`);
        await prepareWorkspace(null, false);
    } finally {
        globalThis.fetch = originalFetch;
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
    }
});
