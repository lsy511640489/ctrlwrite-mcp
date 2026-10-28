import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDraft, markdownDraft, validateCanvas } from './canvasModel';
import { applyMutations } from './canvasStore';

test('draft creates validated tabs, groups, arrows and local skill groups', () => {
    const draft = buildDraft({ tabs: [{ title: 'Research', nodes: [
        { key: 'group', type: 'group', title: 'Background' },
        { key: 'note', type: 'text', title: 'Prior work', content: 'Content', parentKey: 'group' }
    ], connections: [{ sourceKey: 'group', targetKey: 'note' }], skillGroups: [
        { key: 'style', name: 'Academic', members: ['group'], resources: [{ name: 'rules.md', content: 'Be precise.' }] }
    ] }] });
    const tab = draft.tabs[0];
    assert.equal(tab.nodes[1].parentId, tab.nodes[0].id);
    assert.equal(tab.nodes[0].skillGroupId, tab.skillGroups?.[0].id);
    assert.equal(tab.connections[0].targetId, tab.nodes[1].id);
    assert.equal(validateCanvas({ tabs: draft.tabs, activeTabId: tab.id }).tabs.length, 1);
});

test('invalid containment and missing arrow endpoints are rejected', () => {
    assert.throws(() => buildDraft({ tabs: [{ title: 'Bad', nodes: [
        { key: 'a', type: 'text', title: 'A', parentKey: 'b' }, { key: 'b', type: 'text', title: 'B' }
    ] }] }), /Unknown group parent/);
    assert.throws(() => buildDraft({ tabs: [{ title: 'Bad', nodes: [], connections: [{ sourceKey: 'x', targetKey: 'y' }] }] }), /unknown key/);
});

test('markdown parser preserves headings, paragraphs and fenced code', () => {
    const draft = markdownDraft('# Article\n\n## Introduction\n\nFirst paragraph.\n\n```md\n## Not a heading\n```\n\n### Detail\n\nSecond paragraph.', 'source.md');
    const tab = draft.tabs[0];
    assert.equal(tab.title, 'Article');
    assert.deepEqual(tab.nodes.map(node => node.title), ['Introduction', '正文', '正文', 'Detail']);
    assert.equal(tab.nodes[0].type, 'group');
    assert.equal(tab.nodes[1].content, 'First paragraph.');
    assert.match(tab.nodes[2].content, /## Not a heading/);
    assert.ok(tab.nodes.slice(1).every(node => node.parentKey === tab.nodes[0].key));
    assert.equal(tab.nodes[3].content, 'Second paragraph.');
    assert.deepEqual(tab.connections, []);
});

test('markdown parser combines leaf headings with their lists or tables', () => {
    const draft = markdownDraft('# Article\n\n## Four\n\n- First item\n- Second item\n\n## Five\n\n| Scene | Prompt |\n| --- | --- |\n| Summary | Be concise |', 'source.md');
    const tab = draft.tabs[0];
    assert.deepEqual(tab.nodes.map(node => [node.type, node.title]), [
        ['text', 'Four'], ['text', 'Five']
    ]);
    assert.match(tab.nodes[0].content, /- Second item/);
    assert.match(tab.nodes[1].content, /\| Summary \| Be concise \|/);
    assert.deepEqual(tab.connections, []);
    assert.equal(buildDraft(draft).tabs[0].nodes.length, 2);
});

test('batched object edits delete group descendants and attached arrows', () => {
    const tab = buildDraft({ tabs: [{ title: 'Example', nodes: [
        { key: 'parent', type: 'group', title: 'Parent' },
        { key: 'child', type: 'text', title: 'Child', parentKey: 'parent' }
    ], connections: [{ sourceKey: 'parent', targetKey: 'child' }] }] }).tabs[0];
    const state = { tabs: [tab], activeTabId: tab.id };
    const changed = applyMutations(state, [{ kind: 'update_node', tabId: tab.id, nodeId: tab.nodes[1].id, changes: { content: 'Updated' } }]);
    assert.equal(changed.tabs[0].nodes[1].content, 'Updated');
    assert.equal(state.tabs[0].nodes[1].content, '');
    const deleted = applyMutations(changed, [{ kind: 'delete_node', tabId: tab.id, nodeId: tab.nodes[0].id }]);
    assert.equal(deleted.tabs[0].nodes.length, 0);
    assert.equal(deleted.tabs[0].connections.length, 0);
});
