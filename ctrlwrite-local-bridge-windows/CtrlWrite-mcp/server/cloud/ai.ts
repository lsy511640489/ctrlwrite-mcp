import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { AuthError } from '../authStore';

export const aiInputSchema = z.object({
    operation: z.enum(['text', 'image']),
    config: z.object({ provider: z.enum(['gemini', 'openai', 'claude', 'openrouter', 'deepseek', 'relay']), apiKey: z.string().min(1).max(4096), model: z.string().min(1).max(200), baseUrl: z.string().max(2048).optional(), protocol: z.enum(['openai', 'gemini']).optional() }),
    systemPrompt: z.string().max(50000).default(''), userPrompt: z.string().min(1).max(100000)
});
export type AIInput = z.infer<typeof aiInputSchema>;
const defaults: Record<string, string> = { openai: 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta', claude: 'https://api.anthropic.com/v1', openrouter: 'https://openrouter.ai/api/v1', deepseek: 'https://api.deepseek.com' };
const blocked = new BlockList();
const blockedIPv6 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96], ['2001:db8::', 32], ['2002::', 16], ['64:ff9b::', 96]] as const) blockedIPv6.addSubnet(address, prefix, 'ipv6');
export const publicAddress = (address: string) => isIP(address) === 4 ? !blocked.check(address, 'ipv4') : isIP(address) === 6 ? !blockedIPv6.check(address, 'ipv6') : false;

export function aiTarget(input: AIInput, allowed: string[]) {
    const base = (input.config.baseUrl?.trim() || defaults[input.config.provider] || '').replace(/\/+$/, '');
    if (!allowed.map(value => value.trim().replace(/\/+$/, '')).includes(base)) throw new AuthError(400, '此模型服务地址尚未被管理员允许。');
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || isIP(url.hostname)) throw new AuthError(400, '模型服务需要使用允许的 HTTPS 域名。');
    return base;
}

async function post(url: URL, headers: Record<string, string>, payload: object) {
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(value => !publicAddress(value.address))) throw new AuthError(400, '模型地址不能指向私有网络。');
    const content = JSON.stringify(payload);
    return new Promise<any>((resolve, reject) => {
        const upstream = request(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(content) }, lookup: ((_hostname: string, options: any, callback: any) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family)) as any }, response => {
            const chunks: Buffer[] = [];
            let length = 0;
            response.on('data', chunk => {
                length += chunk.length;
                if (length > 12 * 1024 * 1024) upstream.destroy(new Error('Model response too large.'));
                else chunks.push(Buffer.from(chunk));
            });
            response.on('error', reject);
            response.on('end', () => {
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) return reject(new Error('模型服务请求失败，状态码 ' + response.statusCode));
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch { reject(new Error('模型服务返回了无效内容。')); }
            });
        });
        const timer = setTimeout(() => upstream.destroy(new Error('模型请求超时。')), 180000);
        upstream.on('error', reject);
        upstream.on('close', () => clearTimeout(timer));
        upstream.end(content);
    });
}

export async function executeAI(input: AIInput, allowed: string[]) {
    const base = aiTarget(input, allowed);
    const { provider, apiKey, model, protocol } = input.config;
    const gemini = provider === 'gemini' || protocol === 'gemini';
    const image = input.operation === 'image';
    if (image && provider === 'claude') throw new AuthError(400, '此服务不支持图片生成。');
    const suffix = gemini ? `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent` : provider === 'claude' ? '/messages' : image ? '/images/generations' : '/chat/completions';
    const payload = gemini ? { contents: [{ parts: [{ text: input.userPrompt }] }], systemInstruction: { parts: [{ text: input.systemPrompt }] }, generationConfig: image ? { responseModalities: ['TEXT', 'IMAGE'] } : { maxOutputTokens: 4096 } }
        : provider === 'claude' ? { model, system: input.systemPrompt, messages: [{ role: 'user', content: input.userPrompt }], max_tokens: 4096 }
        : image ? { model, prompt: input.userPrompt, n: 1, size: '1024x1024', response_format: 'b64_json' }
        : { model, messages: [{ role: 'system', content: input.systemPrompt }, { role: 'user', content: input.userPrompt }], max_tokens: 4096 };
    const headers = gemini ? { 'x-goog-api-key': apiKey } : provider === 'claude' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${apiKey}` };
    const result = await post(new URL(base + suffix), headers, payload);
    if (image) {
        if (gemini) {
            for (const part of result.candidates?.[0]?.content?.parts || []) {
                if (part.inlineData?.data && /^image\/(png|jpeg|webp|gif)$/.test(part.inlineData.mimeType)) return { image: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` };
            }
        } else if (typeof result.data?.[0]?.b64_json === 'string') return { image: 'data:image/png;base64,' + result.data[0].b64_json };
        throw new Error('模型没有返回可用图片，请选择支持 base64 图片输出的服务。');
    }
    const text = gemini ? result.candidates?.[0]?.content?.parts?.map((part: any) => part.text || '').join('') : provider === 'claude' ? result.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') : result.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回有效文字。');
    return { text };
}
