import type { IncomingMessage, ServerResponse } from 'node:http';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import type { Plugin } from 'vite';
import type { LocalSkill } from '../types/skillTypes';
import { workspaceDirectory } from './workspaceContext';

const MAX_ZIP = 10 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_UNPACKED = 20 * 1024 * 1024;
const MAX_SKILL = 50000;

const skillName = (id: string, content: string) => {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
    const name = frontmatter?.match(/^name:\s*['"]?([^\r\n'"]+)['"]?\s*$/m)?.[1];
    return name?.trim() || id;
};

async function listSkills(): Promise<LocalSkill[]> {
    const skillRoot = workspaceDirectory(path.resolve(process.cwd(), 'skill'));
    await mkdir(skillRoot, { recursive: true });
    const entries = await readdir(skillRoot, { withFileTypes: true });
    const skills = await Promise.all(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(async entry => {
        const file = path.join(skillRoot, entry.name, 'SKILL.md');
        try {
            if (!(await lstat(file)).isFile()) return null;
            const content = await readFile(file, 'utf8');
            if (!content.trim() || content.length > MAX_SKILL) return null;
            return { id: entry.name, name: skillName(entry.name, content), content };
        } catch { return null; }
    }));
    return skills.filter((skill): skill is LocalSkill => skill !== null).sort((a, b) => a.name.localeCompare(b.name));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_ZIP) throw new Error('ZIP must be smaller than 10 MB.');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}

function safePart(part: string): boolean {
    return !!part && part !== '.' && part !== '..' && !/[<>:"\\|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part);
}

async function importSkill(buffer: Buffer, filename: string): Promise<LocalSkill> {
    const skillRoot = workspaceDirectory(path.resolve(process.cwd(), 'skill'));
    await mkdir(skillRoot, { recursive: true });
    const zip = await openZip(buffer);
    let directory: string | undefined;
    let completed = false;
    try {
        const entries: yauzl.Entry[] = [];
        let total = 0;
        for await (const entry of zip.eachEntry()) {
            const parts = entry.fileName.replace(/\/$/, '').split('/');
            if (!parts.every(safePart) || entry.isEncrypted() || !entry.canDecodeFileData() || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error('ZIP contains an unsafe entry.');
            total += entry.uncompressedSize;
            if (total > MAX_UNPACKED || entries.length >= MAX_FILES) throw new Error('ZIP is too large after extraction.');
            entries.push(entry);
        }
        const manifest = entries.filter(entry => /(^|\/)SKILL\.md$/i.test(entry.fileName) && !entry.fileName.endsWith('/'));
        if (manifest.length !== 1) throw new Error('ZIP must contain exactly one SKILL.md.');
        const prefix = manifest[0].fileName.slice(0, -'SKILL.md'.length);
        if (entries.some(entry => !entry.fileName.startsWith(prefix) && !entry.fileName.startsWith('__MACOSX/'))) throw new Error('ZIP must contain a single skill folder.');
        const base = path.basename(prefix.replace(/\/$/, '') || filename.replace(/\.zip$/i, '')).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
        directory = await mkdtemp(path.join(skillRoot, `${base}-`));
        for (const entry of [...entries.filter(entry => entry !== manifest[0]), manifest[0]]) {
            if (entry.fileName.startsWith('__MACOSX/') || entry.fileName === prefix) continue;
            const relative = entry.fileName.slice(prefix.length);
            if (!relative) continue;
            const destination = path.join(directory, ...relative.split('/'));
            if (entry.fileName.endsWith('/')) {
                await mkdir(destination, { recursive: true });
            } else {
                await mkdir(path.dirname(destination), { recursive: true });
                await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(destination, { flags: 'wx' }));
            }
        }
        const content = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
        if (!content.trim() || content.length > MAX_SKILL) throw new Error('SKILL.md must be nonempty and under 50,000 characters.');
        const id = path.basename(directory);
        completed = true;
        return { id, name: skillName(id, content), content };
    } finally {
        zip.close();
        if (!completed && directory?.startsWith(skillRoot + path.sep)) await rm(directory, { recursive: true, force: true });
    }
}

function respond(response: ServerResponse, status: number, body: object) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
}

export function skillLibraryPlugin(): Plugin {
    const middleware = async (request: IncomingMessage, response: ServerResponse) => {
        const address = request.socket.remoteAddress;
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || '')) return respond(response, 403, { error: 'Local access only.' });
        if (request.url?.split('?')[0] !== '/') return respond(response, 404, { error: 'Not found.' });
        try {
            if (request.method === 'GET') return respond(response, 200, { skills: await listSkills() });
            if (request.method === 'POST') {
                if (request.headers['content-type'] !== 'application/zip') return respond(response, 415, { error: 'Choose a ZIP file.' });
                const origin = request.headers.origin;
                if (!origin || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return respond(response, 403, { error: 'Local origin required.' });
                const filename = decodeURIComponent(String(request.headers['x-skill-filename'] || 'skill.zip'));
                if (!/\.zip$/i.test(filename)) return respond(response, 400, { error: 'Choose a ZIP file.' });
                return respond(response, 201, { skill: await importSkill(await readBody(request), filename) });
            }
            return respond(response, 405, { error: 'Method not allowed.' });
        } catch (error) {
            return respond(response, 400, { error: error instanceof Error ? error.message : 'Could not import skill.' });
        }
    };
    return {
        name: 'local-skill-library',
        configureServer(server) { server.middlewares.use('/api/skills', middleware); },
        configurePreviewServer(server) { server.middlewares.use('/api/skills', middleware); }
    };
}
