import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { mapMarkdownTextOffset, rehypeSelectionPositions } from './markdownSelection';
import { replaceTextSelection, resolveEditorTextSelection, resolveTextSelection } from './textSelection';

test('rendered text retains distinct source positions for repeated sentences', () => {
    const markup = renderToStaticMarkup(React.createElement(ReactMarkdown, {
        children: 'Same sentence.\n\nSame sentence.',
        rehypePlugins: [rehypeSelectionPositions]
    }));
    assert.match(markup, /data-markdown-start="0" data-markdown-end="14"/);
    assert.match(markup, /data-markdown-start="16" data-markdown-end="30"/);
    const range = resolveTextSelection('Same sentence.\n\nSame sentence.', 'Same sentence.', { start: 16, end: 30 });
    assert.deepEqual(range, { start: 16, end: 30 });
    assert.equal(replaceTextSelection('Same sentence.\n\nSame sentence.', 'Same sentence.', range!, 'Rewritten.'), 'Same sentence.\n\nRewritten.');
});

test('formatted selection is resolved against its Markdown source', () => {
    const content = 'Before **bold** and [link](https://example.com). After.';
    const source = '**bold** and [link](https://example.com).';
    const range = { start: content.indexOf(source), end: content.indexOf(source) + source.length };
    assert.deepEqual(resolveTextSelection(content, source, range), range);
    assert.equal(replaceTextSelection(content, source, range, 'Updated.'), 'Before Updated. After.');
    assert.equal(resolveTextSelection(content, 'bold and link.'), null);
});

test('rendered offsets account for entities, escapes, Unicode and line endings', () => {
    assert.equal(mapMarkdownTextOffset('A &amp; B', 'A & B', 3), 7);
    assert.equal(mapMarkdownTextOffset('&amp;', '&', 1), 5);
    assert.equal(mapMarkdownTextOffset(String.raw`\*`, '*', 0), 0);
    assert.equal(mapMarkdownTextOffset(String.raw`\*`, '*', 1), 2);
    assert.equal(mapMarkdownTextOffset(String.raw`A \* B`, 'A * B', 3), 4);
    assert.equal(mapMarkdownTextOffset('&#x1F600;!', '😀!', 2), 9);
    assert.equal(mapMarkdownTextOffset('你好😀', '你好😀', 4), 4);
    assert.equal(mapMarkdownTextOffset('a\r\nb', 'a\nb', 2), 3);
    assert.equal(mapMarkdownTextOffset('`inline`', 'inline', 6), 7);
    assert.equal(mapMarkdownTextOffset('different', 'text', 2), null);
});

test('changed source and ambiguous text remain protected from replacement', () => {
    assert.equal(resolveTextSelection('Changed sentence.', 'Original sentence.', { start: 0, end: 18 }), null);
    assert.equal(resolveTextSelection('Repeat. Repeat.', 'Repeat.'), null);
    assert.equal(replaceTextSelection('Changed sentence.', 'Original sentence.', { start: 0, end: 18 }, 'New.'), null);
});

test('Windows line endings map editor selection back to the exact original occurrence', () => {
    const content = 'Heading\r\n\r\nRepeat.\r\n\r\nRepeat.';
    const editorValue = content.replace(/\r\n/g, '\n');
    const start = editorValue.lastIndexOf('Repeat.');
    const range = resolveEditorTextSelection(content, editorValue, { start, end: start + 7 });
    const sourceStart = content.lastIndexOf('Repeat.');
    assert.deepEqual(range, { start: sourceStart, end: sourceStart + 7 });
    assert.equal(replaceTextSelection(content, 'Repeat.', range!, 'Updated.'), 'Heading\r\n\r\nRepeat.\r\n\r\nUpdated.');
});

test('multiline editor selections retain original mixed line endings and Unicode offsets', () => {
    const content = '标题😀\r\n第一句\r第二句\n末尾';
    const editorValue = content.replace(/\r\n?/g, '\n');
    const start = editorValue.indexOf('第一句');
    const end = editorValue.indexOf('\n末尾');
    const range = resolveEditorTextSelection(content, editorValue, { start, end });
    assert.deepEqual(range, { start: content.indexOf('第一句'), end: content.indexOf('\n末尾') });
    const selectedSource = content.slice(range!.start, range!.end);
    assert.equal(selectedSource, '第一句\r第二句');
    assert.deepEqual(resolveTextSelection(content, selectedSource, range!), range);
    assert.equal(replaceTextSelection(content, selectedSource, range!, '修改后的句子'), '标题😀\r\n修改后的句子\n末尾');
});

test('editor selections reject outdated content and invalid offsets', () => {
    assert.deepEqual(resolveEditorTextSelection('hello', 'hello', { start: 0, end: 5 }), { start: 0, end: 5 });
    assert.equal(resolveEditorTextSelection('old\r\ntext', 'new\ntext', { start: 0, end: 3 }), null);
    assert.equal(resolveEditorTextSelection('hello', 'hello', { start: 3, end: 3 }), null);
    assert.equal(resolveEditorTextSelection('hello', 'hello', { start: -1, end: 2 }), null);
    assert.equal(resolveEditorTextSelection('hello', 'hello', { start: 0, end: 6 }), null);
});
