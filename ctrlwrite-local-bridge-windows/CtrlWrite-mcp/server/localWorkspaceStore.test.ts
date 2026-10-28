import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalWorkspaceStore, windowsSecret } from './localWorkspaceStore';
import { buildDraft } from './canvasModel';

const protect = async (value: string, decrypt = false) => decrypt ? Buffer.from(value, 'base64').toString('utf8') : Buffer.from(value).toString('base64');
const canvas = () => {
    const tabs = buildDraft({ tabs: [{ title: '本地笔记', nodes: [{ key: 'body', type: 'text', title: '正文', content: '保留我的内容' }] }] }).tabs;
    return JSON.parse(JSON.stringify({ version: 3, tabState: { tabs, activeTabId: tabs[0].id } }));
};

test('workspace migration persists canvas, editable library and encrypted config separately; stale writes cannot overwrite files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ctrlwrite-files-'));
    try {
        const store = new LocalWorkspaceStore(path.join(directory, 'config'), protect);
        const target = path.join(directory, '我的工作区');
        const data = canvas();
        await store.saveSecrets({ iamtired_ai_config: JSON.stringify({ apiKey: 'private-test-key', model: '中文模型' }) });
        await store.activate(target, { canvas: data, settings: { iamtired_global_md_path: '约束.md' }, library: {
            skills: [{ id: 'keep-skill-id', name: '润色', content: '保留术语' }], constraints: [{ id: 'keep-constraint-id', name: '约束.md', content: '不加标题' }]
        } });
        const status = await store.status();
        assert.equal(status.workspace, target);
        assert.match(status.values.iamtired_ai_config, /private-test-key/);
        assert.ok(!(await readFile(status.configPath, 'utf8')).includes('private-test-key'));
        assert.deepEqual((await store.document(target, 'canvases/canvas.json')).value, data);
        assert.equal((await store.library(target, 'skill'))[0].id, 'keep-skill-id');
        assert.equal(await readFile(path.join(target, 'constraints/约束.md'), 'utf8'), '不加标题');
        await writeFile(path.join(target, 'skills/润色.md'), '在外部编辑器中修改');
        assert.equal((await store.library(target, 'skill'))[0].content, '在外部编辑器中修改');
        const original = await store.document(target, 'canvases/canvas.json');
        const changed = { ...data, timestamp: 123 };
        await store.saveCanvas(target, original.revision, changed);
        assert.deepEqual(JSON.parse(await readFile(path.join(target, 'backups/canvas.previous.json'), 'utf8')), data);
        await assert.rejects(store.saveCanvas(target, original.revision, data), /其他页面或程序修改/);
        await assert.rejects(store.saveSettings(target, null, { iamtired_ai_config: 'must-not-leak' }), /密钥不能/);
        await assert.rejects(store.writeLibrary(target, 'skill', { id: 'escape', name: '../escape', content: 'x' }), /文件名/);
        await assert.rejects(store.writeLibrary(target, 'constraint', { id: 'oversized', name: 'oversized.md', content: '文'.repeat(17000) }), /超过 50 KB/);
        const reopened = new LocalWorkspaceStore(path.join(directory, 'config'), protect);
        assert.equal((await reopened.status()).workspace, target);
        assert.equal((await reopened.library(target, 'constraint'))[0].id, 'keep-constraint-id');
        await assert.rejects(store.activate(target, { canvas: data }), /目标已有工作区/);
        await store.detach();
        await assert.rejects(store.assertRoot(target), /工作区已切换/);
        assert.deepEqual((await store.document(target, 'canvases/canvas.json')).value, changed);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('workspace cannot overwrite unrelated files or follow a library junction outside the selected directory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ctrlwrite-paths-'));
    try {
        const store = new LocalWorkspaceStore(path.join(directory, 'config'), protect);
        const occupied = path.join(directory, 'occupied');
        await mkdir(occupied);
        await writeFile(path.join(occupied, 'notes.txt'), 'keep');
        await assert.rejects(store.activate(occupied), /空文件夹/);
        await assert.rejects(store.activate(path.join(directory, 'config')), /独立的工作区/);
        const target = path.join(directory, 'workspace');
        await store.activate(target);
        await rename(path.join(target, 'skills'), path.join(target, 'old-skills'));
        await symlink(occupied, path.join(target, 'skills'), 'junction');
        await assert.rejects(store.writeLibrary(target, 'skill', { id: 'unsafe', name: 'notes', content: 'bad' }), /外部目录/);
        assert.equal(await readFile(path.join(occupied, 'notes.txt'), 'utf8'), 'keep');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows user encryption round trips Unicode without storing plaintext', { skip: process.platform !== 'win32' }, async () => {
    const original = JSON.stringify({ apiKey: 'test-only-key', model: '中文模型' });
    const encrypted = await windowsSecret(original);
    assert.ok(!encrypted.includes('test-only-key'));
    assert.equal(await windowsSecret(encrypted, true), original);
});
