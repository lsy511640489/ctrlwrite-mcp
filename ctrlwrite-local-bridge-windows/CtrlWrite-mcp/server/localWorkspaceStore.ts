import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { validateCanvas } from './canvasModel';

const settingsSchema = z.record(z.string(), z.string());
const entrySchema = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(200), content: z.string().max(50000) });
const secretKeys = new Set(['iamtired_ai_config', 'iamtired_ai_profiles']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function atomicJson(filename: string, value: unknown) {
    await atomicText(filename, JSON.stringify(value, null, 2));
}

async function atomicText(filename: string, value: string) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
}

async function readJson(filename: string, fallback: unknown): Promise<any> {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}

export async function windowsSecret(value: string, decrypt = false): Promise<string> {
    if (process.platform !== 'win32') throw new Error('本机密钥配置需要 Windows 用户加密支持。');
    const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Security; $text=[Console]::In.ReadToEnd(); ${decrypt
        ? '$bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($text),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Text.Encoding]::UTF8.GetString($bytes))'
        : '$bytes=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($text),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($bytes))'}`;
    return new Promise((resolve, reject) => {
        const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
            if (error) reject(new Error('无法使用当前 Windows 用户加密或解密配置。')); else resolve(stdout.trim());
        });
        child.stdin!.end(value);
    });
}

export class LocalWorkspaceStore {
    private root: string | null = null;
    private loaded = false;
    private queue: Promise<unknown> = Promise.resolve();
    readonly configDirectory: string;
    constructor(directory = path.join(homedir(), 'ctrlwrite_config'), private protect = windowsSecret) { this.configDirectory = directory; }

    async run<T>(work: () => Promise<T>): Promise<T> {
        const result = this.queue.then(work);
        this.queue = result.catch(() => undefined);
        return result;
    }

    private async config() {
        await mkdir(this.configDirectory, { recursive: true, mode: 0o700 });
        const config = await readJson(path.join(this.configDirectory, 'config.json'), {});
        if (!this.loaded) { this.root = typeof config.workspace === 'string' ? config.workspace : null; this.loaded = true; }
        return config;
    }

    async status() {
        const config = await this.config();
        const values = config.encrypted ? settingsSchema.parse(JSON.parse(await this.protect(config.encrypted, true))) : {};
        return { workspace: this.root, configPath: path.join(this.configDirectory, 'config.json'), values };
    }

    async saveSecrets(input: unknown) {
        const values = settingsSchema.parse(input);
        if (Object.keys(values).some(key => !secretKeys.has(key))) throw new Error('无效的模型配置项。');
        const config = await this.config();
        await atomicJson(path.join(this.configDirectory, 'config.json'), { ...config, encrypted: await this.protect(JSON.stringify(values)), workspace: this.root, version: 1 });
    }

    async activate(directory: string, migrate?: any) {
        await this.config();
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请输入本机工作区的绝对路径。');
        await mkdir(directory, { recursive: true });
        const target = await realpath(directory);
        const configRoot = await realpath(this.configDirectory);
        if (target === path.parse(target).root || target === configRoot || target.startsWith(configRoot + path.sep)) throw new Error('请选择独立的工作区文件夹，不能使用磁盘根目录或密钥配置目录。');
        const markerFile = path.join(target, 'workspace.json');
        const marker = await readJson(markerFile, null);
        if (marker && (marker.format !== 'ctrlwrite-workspace' || marker.version !== 1)) throw new Error('工作区格式或版本不受支持。');
        if (marker && migrate) throw new Error('目标已有工作区，请使用打开已有工作区，避免覆盖。');
        if (!marker) {
            if ((await readdir(target)).length) throw new Error('新工作区需要一个空文件夹；已有工作区需要 workspace.json。');
            for (const name of ['canvases', 'skills', 'constraints', 'backups']) await mkdir(path.join(target, name));
            if (migrate) {
                await this.saveCanvas(target, null, migrate.canvas);
                await this.saveSettings(target, null, migrate.settings || {});
                const library = z.object({ skills: z.array(entrySchema).max(200), constraints: z.array(entrySchema).max(200) }).parse(migrate.library);
                for (const entry of library.skills) await this.writeLibrary(target, 'skill', entry);
                for (const entry of library.constraints) await this.writeLibrary(target, 'constraint', entry);
            }
            await atomicJson(markerFile, { format: 'ctrlwrite-workspace', version: 1 });
        }
        const config = await this.config();
        await atomicJson(path.join(this.configDirectory, 'config.json'), { ...config, version: 1, workspace: target });
        this.root = target;
        return { workspace: target };
    }

    async detach() {
        const config = await this.config();
        await atomicJson(path.join(this.configDirectory, 'config.json'), { ...config, workspace: null });
        this.root = null;
    }

    async assertRoot(expected: string) {
        await this.config();
        if (!this.root || this.root !== expected) throw new Error('工作区已切换，请刷新页面。');
        const marker = await readJson(path.join(this.root, 'workspace.json'), null);
        if (marker?.format !== 'ctrlwrite-workspace' || marker.version !== 1) throw new Error('工作区不可用，请检查文件夹。');
        return this.root;
    }

    private async file(root: string, relative: string) {
        const candidate = path.join(root, relative);
        const parent = await realpath(path.dirname(candidate));
        if (!parent.startsWith(root + path.sep) && parent !== root) throw new Error('工作区文件指向了外部目录。');
        try {
            const resolved = await realpath(candidate);
            if (!resolved.startsWith(root + path.sep)) throw new Error('工作区文件指向了外部目录。');
            if ((await stat(resolved)).size > 50_000_000) throw new Error('工作区文件超过 50 MB。');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        return candidate;
    }

    async document(root: string, relative: string) {
        const filename = await this.file(root, relative);
        try { const text = await readFile(filename, 'utf8'); return { value: JSON.parse(text), revision: hash(text) }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: null, revision: null }; throw error; }
    }

    async saveCanvas(root: string, revision: string | null, data: any) {
        if (!data || data.version !== 3 || !data.tabState) throw new Error('画布存档格式无效。');
        validateCanvas(data.tabState);
        return this.saveDocument(root, 'canvases/canvas.json', revision, data, true);
    }

    async saveSettings(root: string, revision: string | null, input: unknown) {
        const settings = settingsSchema.parse(input);
        if (Object.keys(settings).some(key => secretKeys.has(key) || key.includes('token'))) throw new Error('密钥不能写入工作区设置。');
        return this.saveDocument(root, 'settings.json', revision, settings);
    }

    private async saveDocument(root: string, relative: string, revision: string | null, value: unknown, backup = false) {
        const current = await this.document(root, relative);
        if (current.revision !== revision) throw new Error('文件已被其他页面或程序修改，请先导出当前内容，再重新加载工作区。');
        if (backup && current.value) await atomicJson(await this.file(root, 'backups/canvas.previous.json'), current.value);
        const filename = await this.file(root, relative);
        const text = JSON.stringify(value, null, 2);
        await atomicJson(filename, value);
        return { revision: hash(text) };
    }

    private libraryName(kind: string, name: string) {
        if (!['skill', 'constraint'].includes(kind) || !name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name)) throw new Error('文件名包含不支持的字符。');
        if (kind === 'constraint' && !name.endsWith('.md')) throw new Error('约束文件需使用 .md 扩展名。');
        return `${kind === 'skill' ? 'skills' : 'constraints'}/${kind === 'skill' ? name + '.md' : name}`;
    }

    async library(root: string, kind: 'skill' | 'constraint') {
        const directory = await this.file(root, `${kind === 'skill' ? 'skills' : 'constraints'}/.check`);
        const names = (await readdir(path.dirname(directory))).filter(name => name.endsWith('.md'));
        const index = await this.document(root, 'library.json');
        return Promise.all(names.map(async filename => {
            const name = kind === 'skill' ? filename.slice(0, -3) : filename;
            const file = await this.file(root, this.libraryName(kind, name));
            if ((await stat(file)).size > 50000) throw new Error('技能或约束超过 50 KB。');
            return { id: index.value?.[`${kind}:${name}`] || `file:${kind}:${name}`, name, content: await readFile(file, 'utf8') };
        }));
    }

    async writeLibrary(root: string, kind: 'skill' | 'constraint', input: unknown) {
        const entry = entrySchema.parse(input);
        if (Buffer.byteLength(entry.content, 'utf8') > 50000) throw new Error('技能或约束超过 50 KB。');
        const filename = await this.file(root, this.libraryName(kind, entry.name));
        await atomicText(filename, entry.content);
        const index = await this.document(root, 'library.json');
        await atomicJson(await this.file(root, 'library.json'), { ...index.value, [`${kind}:${entry.name}`]: entry.id });
        return entry;
    }
}
