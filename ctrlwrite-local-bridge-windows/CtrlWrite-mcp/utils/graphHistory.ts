import type { WikiNode, Connection } from '../types';

export interface GraphSnapshot {
    nodes: WikiNode[];
    connections: Connection[];
    signature: string;
}

export interface GraphHistory {
    past: GraphSnapshot[];
    present: GraphSnapshot;
    future: GraphSnapshot[];
    lastEdit: { id: string; field: 'title' | 'content'; at: number } | null;
}

export const snapshotGraph = (nodes: WikiNode[], connections: Connection[]): GraphSnapshot => {
    const savedNodes = nodes.map(({ isGenerating, activeAIPanel, ...node }) => ({ ...node }));
    const savedConnections = connections.map(({ isEditing, ...connection }) => ({ ...connection }));
    const signature = JSON.stringify([
        savedNodes.map(({ selected, ...node }) => node),
        savedConnections.map(({ selected, ...connection }) => connection)
    ]);
    return { nodes: savedNodes, connections: savedConnections, signature };
};

export const createGraphHistory = (nodes: WikiNode[], connections: Connection[]): GraphHistory => ({
    past: [], present: snapshotGraph(nodes, connections), future: [], lastEdit: null
});

const editedField = (previous: GraphSnapshot, next: GraphSnapshot) => {
    if (previous.nodes.length !== next.nodes.length || previous.connections.length !== next.connections.length) return null;
    if (JSON.stringify(previous.connections.map(({ selected, ...connection }) => connection)) !== JSON.stringify(next.connections.map(({ selected, ...connection }) => connection))) return null;

    let edit: { id: string; field: 'title' | 'content' } | null = null;
    for (let index = 0; index < next.nodes.length; index++) {
        const oldNode = previous.nodes[index];
        const newNode = next.nodes[index];
        if (oldNode.id !== newNode.id) return null;
        const { selected: oldSelected, ...before } = oldNode;
        const { selected: newSelected, ...after } = newNode;
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        const field = oldNode.title !== newNode.title && oldNode.content === newNode.content ? 'title'
            : oldNode.content !== newNode.content && oldNode.title === newNode.title ? 'content' : null;
        if (!field || edit || JSON.stringify({ ...before, [field]: newNode[field] }) !== JSON.stringify(after)) return null;
        edit = { id: newNode.id, field };
    }
    return edit;
};

export const recordGraph = (history: GraphHistory, next: GraphSnapshot, now = Date.now()) => {
    if (next.signature === history.present.signature) {
        history.present = next;
        return;
    }
    const edit = editedField(history.present, next);
    if (!edit || history.lastEdit?.id !== edit.id || history.lastEdit.field !== edit.field || now - history.lastEdit.at > 800) {
        history.past.push(history.present);
        if (history.past.length > 100) history.past.shift();
    }
    history.present = next;
    history.future = [];
    history.lastEdit = edit && { ...edit, at: now };
};

export const undoGraph = (history: GraphHistory): GraphSnapshot | null => {
    const previous = history.past.pop();
    if (!previous) return null;
    history.future.push(history.present);
    history.present = previous;
    history.lastEdit = null;
    return previous;
};

export const redoGraph = (history: GraphHistory): GraphSnapshot | null => {
    const next = history.future.pop();
    if (!next) return null;
    history.past.push(history.present);
    history.present = next;
    history.lastEdit = null;
    return next;
};
