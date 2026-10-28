import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getMarqueeSelection } from './marqueeSelection';
import { getCursor } from './cursorUtils';
import { ToolMode, type WikiNode } from '../types';

const node = (id: string, x: number, y: number, changes: Partial<WikiNode> = {}): WikiNode => ({
    id, type: 'text', title: id, content: '', position: { x, y }, width: 100, height: 80, ...changes
});
const viewport = { x: 0, y: 0, scale: 1 };

test('selects multiple intersecting cards without requiring full containment', () => {
    const nodes = [node('first', 0, 0), node('second', 140, 0), node('outside', 400, 0)];
    assert.deepEqual(getMarqueeSelection(nodes, viewport, { start: { x: 50, y: 20 }, end: { x: 180, y: 60 } }), ['first', 'second']);
});

test('supports reverse dragging and zoomed, translated canvas coordinates', () => {
    const nodes = [node('first', 10, 20), node('second', 150, 20), node('outside', -500, -500)];
    const shifted = { x: -100, y: 50, scale: 2 };
    assert.deepEqual(getMarqueeSelection(nodes, shifted, { start: { x: 240, y: 150 }, end: { x: -60, y: 100 } }), ['first', 'second']);
});

test('selects children inside nested groups without selecting partially touched groups', () => {
    const nodes = [node('chapter', 100, 100, { type: 'group', width: 1000, height: 800 }),
        node('section', 30, 70, { type: 'group', parentId: 'chapter', width: 600, height: 500 }),
        node('first', 20, 40, { parentId: 'section' }), node('second', 160, 40, { parentId: 'section' })];
    assert.deepEqual(getMarqueeSelection(nodes, viewport, { start: { x: 170, y: 230 }, end: { x: 310, y: 250 } }), ['first', 'second']);
});

test('selecting a complete group excludes its descendants to avoid duplicate operations', () => {
    const nodes = [node('chapter', 100, 100, { type: 'group', width: 500, height: 500 }),
        node('section', 30, 70, { type: 'group', parentId: 'chapter', width: 300, height: 300 }),
        node('paragraph', 20, 40, { parentId: 'section' }), node('outside', 650, 100)];
    assert.deepEqual(getMarqueeSelection(nodes, viewport, { start: { x: 90, y: 90 }, end: { x: 610, y: 610 } }), ['chapter']);
    assert.deepEqual(getMarqueeSelection(nodes, viewport, { start: { x: 120, y: 160 }, end: { x: 440, y: 480 } }), ['section']);
});

test('additive selection uses the initial selection instead of accumulating previous previews', () => {
    const nodes = [node('first', 0, 0), node('second', 140, 0), node('third', 280, 0)];
    const initial = ['first'];
    assert.deepEqual(getMarqueeSelection(nodes, viewport, { start: { x: 130, y: -10 }, end: { x: 400, y: 90 } }, initial), ['first', 'second', 'third']);
    assert.deepEqual(getMarqueeSelection(nodes, viewport, { start: { x: 130, y: -10 }, end: { x: 250, y: 90 } }, initial), ['first', 'second']);
    assert.deepEqual(initial, ['first']);
});

test('clicks and zero-area gestures do not select a node, and additive clicks retain the baseline', () => {
    const nodes = [node('first', 0, 0), node('second', 140, 0)];
    const click = { start: { x: 20, y: 20 }, end: { x: 21, y: 21 } };
    assert.deepEqual(getMarqueeSelection(nodes, viewport, click), []);
    assert.deepEqual(getMarqueeSelection(nodes, viewport, click, ['second']), ['second']);
    assert.deepEqual(getMarqueeSelection(nodes, viewport, { start: { x: 20, y: 20 }, end: { x: 20, y: 60 } }), []);
});

test('supports image and title cards and does not select cards just touching the rectangle edge', () => {
    const nodes = [node('image', -100, -100, { type: 'image' }), node('title', 20, -100, { type: 'title' }), node('edge', 100, -100)];
    assert.deepEqual(getMarqueeSelection(nodes, viewport, { start: { x: -50, y: -110 }, end: { x: 100, y: -50 } }), ['image', 'title']);
});

test('shows the box selection cursor while retaining the space-to-pan cursor', () => {
    const parameters = { isDraggingCanvas: false, isDraggingNode: false, isDraggingConnection: false,
        isResizingNode: false, isSpacePressed: false, toolMode: ToolMode.BOX_SELECT, resizeDirection: 'se' as const };
    assert.equal(getCursor(parameters), 'crosshair');
    assert.equal(getCursor({ ...parameters, isSpacePressed: true }), 'grab');
});
