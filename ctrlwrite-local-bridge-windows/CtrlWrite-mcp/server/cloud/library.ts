import * as yauzl from 'yauzl';
import { AuthError } from '../authStore';

export async function skillFromZip(buffer: Buffer) {
    if (buffer.length > 10 * 1024 * 1024) throw new AuthError(413, '技能压缩包超过 10 MB。');
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, result) => error ? reject(error) : resolve(result)));
    try {
        let manifest: yauzl.Entry | undefined;
        let count = 0;
        let bytes = 0;
        for await (const entry of zip.eachEntry()) {
            count++;
            bytes += entry.uncompressedSize;
            if (count > 200 || bytes > 20 * 1024 * 1024 || entry.isEncrypted() || !entry.canDecodeFileData() || entry.fileName.split('/').some(part => part === '..') || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new AuthError(400, '技能压缩包内容不安全或过大。');
            if (/(^|\/)SKILL\.md$/i.test(entry.fileName)) {
                if (manifest) throw new AuthError(400, '每次只能导入一个 SKILL.md。');
                manifest = entry;
            }
        }
        if (!manifest || manifest.uncompressedSize > 50000) throw new AuthError(400, '需要小于 50 KB 的 SKILL.md。');
        const stream = await zip.openReadStreamPromise(manifest);
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of stream) {
            length += chunk.length;
            if (length > 50000) throw new AuthError(400, 'SKILL.md 过大。');
            chunks.push(Buffer.from(chunk));
        }
        const content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (!content.trim()) throw new AuthError(400, '技能内容为空。');
        const name = content.match(/^name:\s*['"]?([^\r\n'"]+)/m)?.[1]?.trim() || manifest.fileName.split('/').slice(-2, -1)[0] || 'Imported skill';
        return { name: name.slice(0, 200), content };
    } finally { zip.close(); }
}
