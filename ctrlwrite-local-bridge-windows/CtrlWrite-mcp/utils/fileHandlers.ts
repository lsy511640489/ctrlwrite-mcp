import { flushWorkspaceCanvas, isCloudWorkspace, isLocalOnlyWorkspace, workspaceStorage } from './workspaceStorage';
import { exportLocalLibrary, importLocalLibrary, type LibraryBackup } from './localLibrary';
import { fileWorkspace } from './localFiles';

import React from 'react';
import { ToastType } from '../components/Toast';
import { loadFromDB } from './db';
import { importMarkdown } from './markdownImport';
import type { Tab } from '../types/tabTypes';

interface PersistenceData {
    version: number;
    timestamp: number;
    tabState?: any;
    nodes?: any[];
    connections?: any[];
    [key: string]: any;
}

export const handleExportFile = async (saveData: (toLocalStorage: boolean) => Promise<PersistenceData | null>, filename?: string) => {
    const data = await saveData(false);
    if (!data) return;
    if (isLocalOnlyWorkspace()) {
        data.localLibrary = await exportLocalLibrary();
        data.systemSkillIds = JSON.parse(workspaceStorage.getItem('iamtired_system_skill_ids') || '[]');
        data.globalMdPath = workspaceStorage.getItem('iamtired_global_md_path') || '';
        data.writingTemplates = workspaceStorage.getItem('iamtired_writing_templates') || '[]';
    }
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    let name = filename || `Ctrlwrite-backup-${new Date().toISOString().slice(0, 10)}`;
    // Ensure .json extension
    if (!name.toLowerCase().endsWith('.json')) {
        name += '.json';
    }
    
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
};

export const handleImportFile = (
    e: React.ChangeEvent<HTMLInputElement>,
    loadData: (data: any) => void,
    addToast: (props: { title: string; message: string; type?: ToastType }) => void,
    onImportMarkdown?: (tab: Tab) => void,
    onRestoreLibrary?: (selectedIds: string[], globalMdPath: string) => void
) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isMarkdown = /\.(md|markdown)$/i.test(file.name);
    if (!isMarkdown && !/\.json$/i.test(file.name)) {
        addToast({ title: '导入失败', message: '请选择 .md、.markdown 或 .json 文件。', type: 'error' });
        return;
    }
    const reader = new FileReader();
    reader.onload = async (evt) => {
        try {
            const content = String(evt.target?.result || '');
            if (isMarkdown) {
                if (!onImportMarkdown) throw new Error('当前入口不支持 Markdown 导入。');
                const tab = importMarkdown(content, file.name);
                onImportMarkdown(tab);
                addToast({ title: '导入成功', message: `已创建画布「${tab.title}」，解析出 ${tab.nodes.length} 个节点。`, type: 'success' });
                return;
            }
            const data = JSON.parse(content.replace(/^\uFEFF/, ''));
            if (isLocalOnlyWorkspace() && data.localLibrary) {
                await importLocalLibrary(data.localLibrary as LibraryBackup);
                onRestoreLibrary?.(Array.isArray(data.systemSkillIds) ? data.systemSkillIds : [], typeof data.globalMdPath === 'string' ? data.globalMdPath : '');
                if (typeof data.writingTemplates === 'string') workspaceStorage.setItem('iamtired_writing_templates', data.writingTemplates);
            }
            loadData(data);
            addToast({ title: 'Import Successful', message: 'Graph data loaded from file.', type: 'success' });
        } catch (err) {
            addToast({ title: '导入失败', message: err instanceof Error ? err.message : '无法读取备份文件。', type: 'error' });
        }
    };
    reader.onerror = () => addToast({ title: '导入失败', message: '无法读取文件，请重新选择。', type: 'error' });
    reader.readAsText(file, 'UTF-8');
};

export const handleSaveLocal = async (
    saveData: (toLocalStorage: boolean) => Promise<any>,
    addToast: (props: { title: string; message: string; type?: ToastType }) => void
) => {
    try {
        await saveData(true);
        if (isCloudWorkspace()) await flushWorkspaceCanvas();
        addToast({ title: '保存成功', message: isCloudWorkspace() ? '画布已保存到个人云端工作区。' : fileWorkspace() ? `画布已保存到 ${fileWorkspace()}` : '画布已保存到当前浏览器。', type: 'success' });
    } catch (e) {
        addToast({ title: '保存失败', message: e instanceof Error ? e.message : '请稍后重试。', type: 'error' });
    }
};

export const handleLoadLocal = async (
    loadData: (data: any) => void,
    addToast: (props: { title: string; message: string; type?: ToastType }) => void
) => {
    try {
        if (isCloudWorkspace()) {
            const response = await fetch('/api/canvas-mcp/state', { cache: 'no-store' });
            const remote = await response.json();
            if (!response.ok || !remote?.state) throw new Error(remote?.error || '还没有云端存档。');
            const preferences = JSON.parse(workspaceStorage.getItem('iamtired_editor_preferences') || '{}');
            loadData({ ...preferences, version: 3, tabState: remote.state });
            addToast({ title: '已加载', message: '已读取当前账号的云端画布。', type: 'success' });
            return;
        }
        // First try IndexedDB
        let data = await loadFromDB('iamtired_save');
        
        // Fallback to localStorage
        if (!data && !fileWorkspace()) {
            const local = workspaceStorage.getItem('iamtired_save');
            if (local) data = JSON.parse(local);
        }

        if (data) {
            loadData(data);
            addToast({ title: 'Load Successful', message: fileWorkspace() ? '已读取本地工作区。' : 'Graph data loaded from browser storage.', type: 'success' });
        } else {
            addToast({ title: 'No Save Found', message: 'No local save found in this browser.', type: 'warning' });
        }
    } catch (e) {
        addToast({ title: 'Load Failed', message: e instanceof Error ? e.message : 'Failed to load local save.', type: 'error' });
    }
};
