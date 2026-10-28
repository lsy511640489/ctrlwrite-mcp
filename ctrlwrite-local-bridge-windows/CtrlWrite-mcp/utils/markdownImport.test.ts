import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { MarkdownContent } from '../components/MarkdownContent';
import { importMarkdown } from './markdownImport';
import { buildDraft, markdownDraft, validateCanvas } from '../server/canvasModel';
import { buildMarkdownOutline, renderMarkdown } from './markdownExport';
import type { Tab } from '../types/tabTypes';

const exportTab = (tab: Tab) => renderMarkdown(buildMarkdownOutline(tab.nodes, tab.connections), tab.title);

const checkLayout = (tab: Tab) => {
    for (const node of tab.nodes) {
        if (node.parentId) {
            const parent = tab.nodes.find(candidate => candidate.id === node.parentId)!;
            assert.equal(parent.type, 'group');
            assert.ok(node.position.x >= 28 && node.position.y >= 76);
            assert.ok(node.position.x + node.width <= parent.width - 28);
            assert.ok(node.position.y + node.height <= parent.height - 28);
        }
        for (const sibling of tab.nodes.filter(candidate => candidate.parentId === node.parentId && candidate.id !== node.id)) {
            assert.ok(node.position.x + node.width <= sibling.position.x || sibling.position.x + sibling.width <= node.position.x
                || node.position.y + node.height <= sibling.position.y || sibling.position.y + sibling.height <= node.position.y);
        }
    }
};

test('major sections become groups and leaf headings belong to their first paragraph', () => {
    const tab = importMarkdown('# 文档\n\n## 背景\n\n导言。\n\n### 方法\n\n方法第一段。\n\n方法第二段。\n\n### 结果\n\n结果正文。', 'source.md');
    assert.equal(tab.title, '文档');
    assert.equal(tab.nodes.filter(node => node.type === 'group').length, 1);
    const group = tab.nodes.find(node => node.type === 'group')!;
    assert.equal(group.title, '背景');
    assert.ok(tab.nodes.filter(node => node.type === 'text').every(node => node.parentId === group.id));
    const method = tab.nodes.find(node => node.title === '方法')!;
    assert.equal(method.content, '方法第一段。');
    const continuation = tab.nodes.find(node => node.content === '方法第二段。')!;
    assert.equal(continuation.omitTitleInMarkdown, true);
    assert.ok(tab.connections.some(connection => connection.sourceId === method.id && connection.targetId === continuation.id));
    assert.ok(tab.nodes.every(node => node.type !== 'title' && (node.type === 'group' || node.content)));
    validateCanvas({ tabs: [tab], activeTabId: tab.id });
    checkLayout(tab);
});

test('nested subsections use nested groups, including skipped heading levels', () => {
    const markdown = '# 文章\n\n## 第一章\n\n章导言。\n\n### 理论\n\n理论概述。\n\n##### 推导\n\n推导正文。\n\n### 实验\n\n实验正文。\n\n## 第二章\n\n结论。';
    const tab = importMarkdown(markdown, 'nested.md');
    const chapter = tab.nodes.find(node => node.title === '第一章')!;
    const theory = tab.nodes.find(node => node.title === '理论')!;
    const derivation = tab.nodes.find(node => node.title === '推导')!;
    assert.equal(chapter.type, 'group');
    assert.equal(theory.type, 'group');
    assert.equal(theory.parentId, chapter.id);
    assert.equal(derivation.parentId, theory.id);
    assert.equal(tab.nodes.find(node => node.title === '实验')!.parentId, chapter.id);
    assert.equal(tab.nodes.find(node => node.title === '第二章')!.parentId, undefined);
    checkLayout(tab);
    const exported = exportTab(tab);
    assert.match(exported, /## 第一章/);
    assert.match(exported, /### 理论/);
    assert.match(exported, /#### 推导/);
    assert.match(exported, /### 实验/);
    assert.match(exported, /## 第二章/);
    assert.equal(buildDraft(markdownDraft(markdown, 'nested.md')).tabs[0].nodes.length, tab.nodes.length);
});

test('standalone leaf headings do not create empty heading cards', () => {
    const tab = importMarkdown('# 文档\n\n## 背景\n\n第一段。\n\n第二段。\n\n## 结论\n\n第三段。', 'flat.md');
    assert.deepEqual(tab.nodes.map(node => node.type), ['text', 'text', 'text']);
    assert.deepEqual(tab.nodes.map(node => node.content), ['第一段。', '第二段。', '第三段。']);
    assert.equal(tab.nodes[0].title, '背景');
    assert.equal(tab.nodes[2].title, '结论');
    const exported = exportTab(tab);
    assert.equal((exported.match(/## 背景/g) || []).length, 1);
    assert.ok(exported.indexOf('第一段。') < exported.indexOf('第二段。'));
    assert.ok(exported.indexOf('第二段。') < exported.indexOf('## 结论'));
    checkLayout(tab);
});

test('normalizes BOM and Windows newlines and splits documents without headings', () => {
    const tab = importMarkdown('\uFEFF中文正文\r\n\r\n- 列表\r\n- 第二项', '笔记.MARKDOWN');
    assert.equal(tab.title, '笔记');
    assert.deepEqual(tab.nodes.map(node => node.content), ['中文正文', '- 列表\n- 第二项']);
    assert.ok(tab.nodes.every(node => node.omitTitleInMarkdown));
    assert.throws(() => importMarkdown('\uFEFF \r\n', 'empty.md'), /为空/);
});

test('preserves tables, reference images and math rendering across sections', () => {
    const tab = importMarkdown('# 文档\n\n## 数据\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n$$x^2$$\n\n### 图片\n\n![示例][asset]\n\n[asset]: https://example.com/image.png', 'data.md');
    const markup = tab.nodes.filter(node => node.content)
        .map(node => renderToStaticMarkup(React.createElement(MarkdownContent, { children: node.content }))).join('');
    assert.match(markup, /<table/);
    assert.match(markup, /katex-display/);
    assert.match(markup, /src="https:\/\/example.com\/image.png"/);
});

test('long plain paragraphs split at sentence boundaries without losing text', () => {
    const paragraph = '这是一句用于测试长段落拆分的完整句子。'.repeat(100);
    const tab = importMarkdown('# 文档\n\n## 长段落\n\n' + paragraph, 'long.md');
    assert.ok(tab.nodes.length > 1);
    assert.ok(tab.nodes.every(node => node.content.length <= 600));
    assert.equal(tab.nodes.map(node => node.content).join(''), paragraph);
    assert.ok(tab.nodes.slice(0, -1).every(node => node.content.endsWith('。')));
    checkLayout(tab);
});

test('keeps multiline code, lists, tables and display equations intact', () => {
    const blocks = ['第一段。', '```md\n## 代码里的标题\n\n**不是标题**\n```', '- 第一项\n\n- 第二项', '| A | B |\n| --- | --- |\n| 1 | 2 |', '$$\nx^2\n\n+ y^2\n$$', '最后一段。'];
    const tab = importMarkdown(blocks.join('\n\n'), 'blocks.md');
    assert.deepEqual(tab.nodes.map(node => node.content), blocks);
    assert.ok(tab.nodes.every(node => node.type === 'text'));
});

test('recognizes standalone bold numbered headings without treating ordinary emphasis as headings', () => {
    const markdown = '# 报告\n\n**一、背景**\n\n章节概述。\n\n**1.1 目标**\n\n目标正文。\n\n这段有**强调**但不是标题。\n\n**这是一句完整的话。**\n\n**二、结论**\n\n总结正文。';
    const tab = importMarkdown(markdown, 'report.md');
    const background = tab.nodes.find(node => node.title === '一、背景')!;
    assert.equal(background.type, 'group');
    const goal = tab.nodes.find(node => node.title === '1.1 目标')!;
    assert.equal(goal.parentId, background.id);
    assert.equal(goal.content, '目标正文。');
    assert.ok(tab.nodes.some(node => node.content === '这段有**强调**但不是标题。'));
    assert.ok(tab.nodes.some(node => node.content === '**这是一句完整的话。**'));
    assert.equal(tab.nodes.find(node => node.title === '二、结论')!.parentId, undefined);
    checkLayout(tab);
});

test('recognizes setext headings and handles duplicate subsection names independently', () => {
    const tab = importMarkdown('文档\n===\n\n第一章\n---\n\n### 说明\n\n第一章正文。\n\n第二章\n---\n\n### 说明\n\n第二章正文。', 'setext.md');
    const notes = tab.nodes.filter(node => node.title === '说明');
    assert.equal(tab.title, '文档');
    assert.equal(notes.length, 2);
    assert.notEqual(notes[0].parentId, notes[1].parentId);
    assert.notEqual(notes[0].id, notes[1].id);
    checkLayout(tab);
});

test('keeps later top-level headings and preserves empty sections as groups', () => {
    const tab = importMarkdown('# 文档\n\n# 第一章\n\n正文。\n\n## 待补充\n\n# 第二章\n\n下一章。', 'chapters.md');
    assert.equal(tab.title, '文档');
    assert.equal(tab.nodes.find(node => node.title === '待补充')!.type, 'group');
    const exported = exportTab(tab);
    assert.match(exported, /待补充/);
    assert.ok(exported.indexOf('第一章') < exported.indexOf('第二章'));
    checkLayout(tab);
});

test('reimported articles have independent group and connection IDs', () => {
    const markdown = '# 文档\n\n## 章节\n\n### 小节\n\n第一段。\n\n第二段。';
    const first = importMarkdown(markdown, 'same.md');
    const second = importMarkdown(markdown, 'same.md');
    assert.notEqual(first.id, second.id);
    assert.ok(second.nodes.every(node => !first.nodes.some(previous => previous.id === node.id)));
    assert.ok(second.connections.every(connection => !first.connections.some(previous => previous.id === connection.id)));
    validateCanvas({ tabs: [first, second], activeTabId: second.id });
});
