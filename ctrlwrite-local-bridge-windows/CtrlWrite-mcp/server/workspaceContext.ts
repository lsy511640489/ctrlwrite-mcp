import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

export const localWorkspace = new AsyncLocalStorage<string>();
export const localWorkspaceId = () => localWorkspace.getStore() || 'legacy';
export const workspaceDirectory = (base: string) => localWorkspace.getStore() ? path.join(base, 'users', localWorkspaceId()) : base;
