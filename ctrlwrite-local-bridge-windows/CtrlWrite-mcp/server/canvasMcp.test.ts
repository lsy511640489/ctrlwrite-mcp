import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'vite';

test('Codex MCP can preview, apply and edit a live canvas', { timeout: 30000 }, async () => {
    const project = fileURLToPath(new URL('..', import.meta.url));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'iamtired-mcp-test-'));
    process.env.IAMTIRED_CANVAS_DATA_DIR = directory;
    const vite = await createServer({ configFile: path.join(project, 'vite.config.ts'), server: { port: 0, host: '127.0.0.1' } });
    let client: Client | undefined;
    try {
        await vite.listen();
        const address = vite.httpServer?.address();
        if (!address || typeof address === 'string') throw new Error('Could not determine test server port.');
        const transport = new StdioClientTransport({ command: process.execPath,
            args: [path.join(project, 'node_modules/tsx/dist/cli.mjs'), path.join(project, 'mcp/server.ts')], cwd: project, stderr: 'pipe',
            env: { ...process.env, IAMTIRED_CANVAS_URL: `http://127.0.0.1:${address.port}` } as Record<string, string> });
        client = new Client({ name: 'canvas-test', version: '1.0.0' });
        await client.connect(transport);
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['list_tabs', 'list_objects', 'get_object', 'edit_canvas', 'preview_canvas', 'preview_markdown', 'apply_preview'].sort());
        const call = async (name: string, args: Record<string, unknown>) => {
            const result = await client!.callTool({ name, arguments: args });
            const parsed = JSON.parse((result.content as { text: string }[])[0].text);
            if (result.isError) throw new Error(parsed.error);
            return parsed;
        };
        assert.equal((await call('list_tabs', {})).revision, 0);
        const preview = await call('preview_canvas', { revision: 0, draft: { tabs: [{ title: 'Test article', nodes: [
            { key: 'intro', type: 'title', title: 'Introduction' },
            { key: 'body', type: 'text', title: 'Overview', content: 'First paragraph.' }
        ], connections: [{ sourceKey: 'intro', targetKey: 'body' }] }] } });
        assert.equal(preview.summary[0].nodes, 2);
        const applied = await call('apply_preview', { previewId: preview.previewId });
        assert.equal(applied.revision, 1);
        const listed = await call('list_objects', { tabId: applied.activeTabId });
        assert.equal(listed.connections.length, 1);
        const modified = await call('edit_canvas', { revision: 1, operations: [{ kind: 'update_node', tabId: applied.activeTabId,
            nodeId: listed.nodes[1].id, changes: { content: 'Updated paragraph.' } }] });
        assert.equal(modified.revision, 2);
        assert.equal((await call('get_object', { tabId: applied.activeTabId, nodeId: listed.nodes[1].id })).node.content, 'Updated paragraph.');
        const markdown = await call('preview_markdown', { revision: 2, filename: 'notes.md', markdown: '# Notes\n\n## Background\n\nA paragraph.' });
        assert.equal(markdown.summary[0].title, 'Notes');
        assert.equal(markdown.summary[0].nodes, 1);
        assert.deepEqual(markdown.outline[0].nodes.map((node: { type: string }) => node.type), ['text']);
        const imported = await call('apply_preview', { previewId: markdown.previewId });
        assert.equal(imported.revision, 3);
        assert.equal(imported.tabs.length, 2);
        const markdownPath = path.join(directory, 'converted.md');
        await writeFile(markdownPath, '# Converted article\n\n## Chapter\n\n### Detail\n\nFirst paragraph.\n\nSecond paragraph.');
        const filePreview = await call('preview_markdown', { revision: 3, filePath: markdownPath });
        assert.equal((await call('list_tabs', {})).revision, 3);
        assert.deepEqual(filePreview.outline[0].nodes.map((node: { type: string }) => node.type), ['group', 'text', 'text']);
        const fileImport = await call('apply_preview', { previewId: filePreview.previewId });
        assert.equal(fileImport.revision, 4);
        assert.equal(fileImport.tabs.length, 3);
        const objects = await call('list_objects', { tabId: fileImport.activeTabId });
        assert.equal(objects.nodes[1].parentId, objects.nodes[0].id);
        assert.equal(objects.nodes[1].id, filePreview.outline[0].nodes[1].id);
        const backupPath = path.join(directory, 'backup.json');
        await writeFile(backupPath, await readFile(path.join(directory, 'canvas.json')));
        const backupPreview = await call('preview_canvas', { revision: 4, filePath: backupPath });
        assert.equal(backupPreview.summary.length, 3);
        const backupImport = await call('apply_preview', { previewId: backupPreview.previewId });
        assert.equal(backupImport.revision, 5);
        assert.equal(backupImport.tabs.length, 6);
        assert.notEqual(backupImport.activeTabId, applied.activeTabId);
        assert.equal((await call('get_object', { tabId: applied.activeTabId, nodeId: listed.nodes[1].id })).node.content, 'Updated paragraph.');
        const missingSource = await client.callTool({ name: 'preview_markdown', arguments: { revision: 5 } });
        assert.equal(missingSource.isError, true);
        const binary = await client.callTool({ name: 'preview_markdown', arguments: { revision: 5, filePath: path.join(directory, 'article.pdf') } });
        assert.equal(binary.isError, true);
        const bothSources = await client.callTool({ name: 'preview_markdown', arguments: { revision: 5, filePath: markdownPath, markdown: 'Conflicting source' } });
        assert.equal(bothSources.isError, true);
        const oldRevision = await client.callTool({ name: 'preview_markdown', arguments: { revision: 3, filePath: markdownPath } });
        assert.equal(oldRevision.isError, true);
        assert.equal((await call('list_tabs', {})).revision, 5);
        const stale = await client.callTool({ name: 'edit_canvas', arguments: { revision: 1, operations: [{ kind: 'delete_node', tabId: applied.activeTabId, nodeId: listed.nodes[0].id }] } });
        assert.equal(stale.isError, true);
    } finally {
        await client?.close();
        await vite.close();
        if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('iamtired-mcp-test-')) {
            await rm(directory, { recursive: true, force: true });
        }
        delete process.env.IAMTIRED_CANVAS_DATA_DIR;
    }
});
