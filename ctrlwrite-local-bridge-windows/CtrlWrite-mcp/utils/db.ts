
import { isCloudWorkspace, workspaceKey, workspaceStorage } from './workspaceStorage';
import { fileWorkspace, readFileCanvas, writeFileCanvas } from './localFiles';

const DB_NAME = 'iamtired_db';
const STORE_NAME = 'saves';
const DB_VERSION = 2;

export const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains('library')) db.createObjectStore('library');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const saveToDB = async (key: string, data: any): Promise<void> => {
  if (fileWorkspace() && key === 'iamtired_save') {
    await writeFileCanvas(data);
    try { await saveToDB(`file:${fileWorkspace()}:${key}`, data); }
    catch (error) { console.warn('工作区已保存，但浏览器恢复缓存未更新。', error); }
    return;
  }
  key = workspaceKey(key);
  if (isCloudWorkspace()) {
    const { tabState, nodes, connections, ...preferences } = data;
    workspaceStorage.setItem('iamtired_editor_preferences', JSON.stringify(preferences));
    return;
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(data, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const loadFromDB = async (key: string): Promise<any> => {
  if (fileWorkspace() && key === 'iamtired_save') return readFileCanvas();
  if (isCloudWorkspace()) return null;
  key = workspaceKey(key);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};
