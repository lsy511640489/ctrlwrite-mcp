import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { selectWorkspaceDirectory } from './localFolderPicker';

test('folder selection returns the chosen path and cancellation preserves the current choice', async () => {
    const initial = path.resolve('当前文件夹');
    const selected = path.resolve('新的工作区');
    assert.equal(await selectWorkspaceDirectory(initial, async value => { assert.equal(value, initial); return selected; }), selected);
    assert.equal(await selectWorkspaceDirectory(initial, async () => ''), null);
    await assert.rejects(selectWorkspaceDirectory({}, async () => selected), /路径无效/);
    await assert.rejects(selectWorkspaceDirectory(initial, async () => 'relative-folder'), /绝对路径/);
});

test('only one dialog can open at a time and a failed dialog can be retried', async () => {
    let finish: (value: string) => void = () => undefined;
    const pending = selectWorkspaceDirectory('', () => new Promise(resolve => { finish = resolve; }));
    await assert.rejects(selectWorkspaceDirectory('', async () => ''), /已有文件夹选择窗口/);
    finish('');
    assert.equal(await pending, null);
    await assert.rejects(selectWorkspaceDirectory('', async () => { throw new Error('dialog failed'); }), /dialog failed/);
    assert.equal(await selectWorkspaceDirectory('', async () => ''), null);
});
