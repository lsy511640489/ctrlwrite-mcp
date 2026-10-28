import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareFileImport, readImportFile } from './fileImport';
import { buildDraft, validateCanvas } from './canvasModel';

test('file import uses the article parser with groups and separate paragraphs', () => {
    const imported = prepareFileImport('\uFEFF# Article\r\n\r\n## Chapter\r\n\r\n### Section\r\n\r\nFirst.\r\n\r\nSecond.', 'converted.MD');
    assert.equal(imported.tabs[0].title, 'Article');
    assert.deepEqual(imported.tabs[0].nodes.map(node => node.type), ['group', 'text', 'text']);
    assert.equal(imported.tabs[0].nodes[1].content, 'First.');
    assert.equal(imported.tabs[0].nodes[2].content, 'Second.');
});

test('JSON article drafts and wrapped drafts remain supported', () => {
    const draft = { tabs: [{ title: 'Article', nodes: [{ key: 'body', type: 'text', title: 'Section', content: 'Body.' }] }] };
    for (const value of [draft, { draft }]) {
        const imported = prepareFileImport(JSON.stringify(value), 'article.json');
        assert.equal(imported.tabs[0].nodes[0].content, 'Body.');
    }
});

test('backup import preserves layout, styles and resources while remapping every relationship', () => {
    const tab = buildDraft({ tabs: [{ title: 'Saved', nodes: [
        { key: 'group', type: 'group', title: 'Chapter' },
        { key: 'first', type: 'text', title: 'Section', content: 'First.', parentKey: 'group' },
        { key: 'second', type: 'text', title: 'Continuation', content: 'Second.', parentKey: 'group', omitTitleInMarkdown: true }
    ], connections: [{ sourceKey: 'first', targetKey: 'second' }],
    skillGroups: [{ key: 'references', name: 'References', members: ['first'], resources: [{ name: 'source.md', content: 'Reference.' }] }] }] }).tabs[0];
    tab.nodes[1].bodyFontSize = 22;
    tab.nodes[1].selected = true;
    const state = { tabs: [tab], activeTabId: tab.id };
    for (const value of [state, { version: 3, tabState: state }, { revision: 8, state }]) {
        const imported = prepareFileImport(JSON.stringify(value), 'backup.json').tabs[0];
        assert.notEqual(imported.id, tab.id);
        assert.ok(imported.nodes.every(node => !tab.nodes.some(original => original.id === node.id)));
        assert.equal(imported.nodes[1].parentId, imported.nodes[0].id);
        assert.equal(imported.nodes[1].bodyFontSize, 22);
        assert.equal(imported.nodes[1].selected, undefined);
        assert.deepEqual(imported.nodes[1].position, tab.nodes[1].position);
        assert.equal(imported.connections[0].sourceId, imported.nodes[1].id);
        assert.equal(imported.connections[0].targetId, imported.nodes[2].id);
        assert.equal(imported.nodes[1].skillGroupId, imported.skillGroups![0].id);
        assert.equal(imported.skillGroups![0].resources[0].content, 'Reference.');
        validateCanvas({ tabs: [tab, imported], activeTabId: imported.id });
    }
});

test('legacy single-canvas backups import into a new tab', () => {
    const original = buildDraft({ tabs: [{ title: 'Original', nodes: [{ key: 'body', type: 'text', title: 'Body', content: 'Saved text.' }] }] }).tabs[0];
    const imported = prepareFileImport(JSON.stringify({ version: 1, nodes: original.nodes, connections: [] }), 'legacy.json');
    assert.equal(imported.tabs[0].title, 'legacy');
    assert.equal(imported.tabs[0].nodes[0].content, 'Saved text.');
});

test('rejects empty files, unsupported formats, malformed JSON and invalid relationships', () => {
    assert.throws(() => prepareFileImport(' \n', 'empty.md'), /empty/);
    assert.throws(() => prepareFileImport('binary', 'source.pdf'), /Supported import/);
    assert.throws(() => prepareFileImport('{', 'broken.json'), /Invalid JSON/);
    assert.throws(() => prepareFileImport('{"unrelated":true}', 'other.json'), /tabs array/);
    assert.throws(() => prepareFileImport(JSON.stringify({ tabs: [{ title: 'Broken', nodes: [{ key: 'body', type: 'text', title: 'Body', parentKey: 'missing' }] }] }), 'broken.json'), /Unknown group parent/);
});

test('reads only regular, supported local UTF-8 files and enforces the size limit', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'iamtired-import-test-'));
    try {
        const markdownPath = path.join(directory, 'converted.md');
        await writeFile(markdownPath, '\uFEFF# Converted\n\nBody.');
        const file = await readImportFile(markdownPath);
        assert.equal(file.filename, 'converted.md');
        assert.equal(prepareFileImport(file.fileContent, file.filename).tabs[0].title, 'Converted');
        await assert.rejects(readImportFile('relative.md'), /absolute path/);
        await assert.rejects(readImportFile(path.join(directory, 'source.docx')), /Convert this document/);
        const binaryPath = path.join(directory, 'binary.md');
        await writeFile(binaryPath, new Uint8Array([0xff, 0xfe, 0x00]));
        await assert.rejects(readImportFile(binaryPath), /UTF-8/);
        const largePath = path.join(directory, 'large.md');
        await writeFile(largePath, Buffer.alloc(20_000_001));
        await assert.rejects(readImportFile(largePath), /20 MB/);
    } finally {
        if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('iamtired-import-test-')) await rm(directory, { recursive: true, force: true });
    }
});
