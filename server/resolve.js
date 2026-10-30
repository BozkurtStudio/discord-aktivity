import crypto from 'crypto';
import { request, assertSafeUrl } from './net.js';

/**
 * Embed sayfalarından doğrudan oynatılabilir (mp4 / m3u8) adres çıkarır.
 *
 * Desteklenenler:
 *  - Doğrudan MP4 / M3U8 / WebM bağlantıları
 *  - Pixeldrain (/u/, /d/, /api/file/)
 *  - Filemoon (packed JS çözümü ile)
 *  - Vidmoly
 *  - Streamtape (parçalı get_video linki)
 *  - Doodstream (pass_md5 akışı)
 *  - Voe (JS yönlendirme + hls)
 *  - MixDrop (wurl)
 *  - Diğer birçok kaynak için genel "sayfada m3u8/mp4 ara" yedeği
 */

export class ResolveError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ResolveError';
    }
}

const HLS_RE = /\.m3u8(?:$|[?#])/i;
const FILE_RE = /\.(?:mp4|webm|m4v|mov|mkv)(?:$|[?#])/i;

const JUNK_RE = new RegExp(
    '(?:^|[./_-])(?:' +
    [
        'ads?',
        'advert',
        'banner',
        'doubleclick',
        'googletag',
        'google',
        'preview',
        'thumb',
        'thumbnail',
        'sprite',
        'trailer',
        'sample',
        'teaser',
        'logo',
        'poster',
        'jwplayer',
        'videojs',
        'hls\\.min',
        'dash\\.all',
    ].join('|') +
    ')(?:[./_-]|$)',
    'i'
);

const MEDIA_EXT_RE = /\.(?:m3u8|mp4|webm|m4v|mov|mkv)(?:$|[?#])/i;

const STATIC_ASSET_RE =
    /\.(?:js|mjs|css|html?|json|xml|txt|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map)(?:$|[?#])/i;

// ------------------------------------------------------------
// Girdi temizleme
// ------------------------------------------------------------

function extractUrl(input) {
    if (typeof input !== 'string') throw new ResolveError('URL gerekli.');

    let text = input.trim();
    if (!text) throw new ResolveError('URL gerekli.');

    // Kullanıcı iframe kodunu yapıştırdıysa src'yi al
    const iframe = text.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/i);
    if (iframe) {
        text = iframe[1];
    } else {
        const httpMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
        if (httpMatch) {
            text = httpMatch[0];
        } else if (/^\/\/[^\s]+$/.test(text)) {
            text = `https:${text}`;
        }
    }

    text = text
        .replace(/&amp;/gi, '&')
        .replace(/&#x2f;/gi, '/')
        .replace(/&#47;/g, '/')
        .replace(/[),.;]+$/, '');

    if (!/^https?:\/\//i.test(text)) {
        throw new ResolveError('Geçerli bir http(s) URL bulunamadı.');
    }

    return text;
}

function makeResult(url, referer, source, typeHint) {
    const type = typeHint || (HLS_RE.test(url) ? 'hls' : 'file');
    return { url, type, referer: referer || null, source };
}

function isDirect(url) {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();

    if (/\.(?:m3u8|mp4|webm|m4v|mov)$/.test(path)) return true;

    // Pixeldrain API zaten doğrudan dosya akışı veriyor
    if (
        /(^|\.)pixeldrain\.com$/.test(parsed.hostname) &&
        path.startsWith('/api/file/')
    ) {
        return true;
    }

    return false;
}

// ------------------------------------------------------------
// JS kaçışlarını çözme
// ------------------------------------------------------------

function decodeJsEscapes(text) {
    return text
        .replace(/\\u002[fF]/g, '/')
        .replace(/\\u0026/g, '&')
        .replace(/\\u003[dD]/g, '=')
        .replace(/\\\//g, '/')
        .replace(/&#x2f;/gi, '/')
        .replace(/&#47;/g, '/')
        .replace(/&amp;/gi, '&');
}

// ------------------------------------------------------------
// p.a.c.k.e.r (Dean Edwards) çözücü
// ------------------------------------------------------------

const BASE62_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function numberToToken(value, radix) {
    if (!Number.isFinite(radix) || radix < 2 || radix > 62) return value.toString(36);
    if (value === 0) return '0';

    let out = '';
    let n = value;
    while (n > 0) {
        out = BASE62_DIGITS[n % radix] + out;
        n = Math.floor(n / radix);
    }
    return out;
}

function readStringLiteral(source) {
    const text = String(source).trimStart();
    const quote = text[0];
    if (quote !== '"' && quote !== "'" && quote !== '`') return null;

    let out = '';
    for (let i = 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === quote) return out;
        if (ch !== '\\') {
            out += ch;
            continue;
        }

        const next = text[++i];
        if (next === undefined) break;

        switch (next) {
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'v': out += '\v'; break;
            case '0': out += '\0'; break;
            case 'x': {
                out += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
                i += 2;
                break;
            }
            case 'u': {
                if (text[i + 1] === '{') {
                    const end = text.indexOf('}', i + 2);
                    if (end === -1) break;
                    out += String.fromCodePoint(parseInt(text.slice(i + 2, end), 16));
                    i = end;
                } else {
                    out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
                    i += 4;
                }
                break;
            }
            default:
                out += next;
        }
    }
    return out;
}

function findClosing(text, start, open, close) {
    let depth = 0;
    let quote = null;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (quote) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === quote) quote = null;
            continue;
        }

        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            continue;
        }

        if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function splitTopLevel(text, separator) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let escaped = false;
    let last = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (quote) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === quote) quote = null;
            continue;
        }

        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === separator && depth === 0) {
            parts.push(text.slice(last, i));
            last = i + 1;
        }
    }

    parts.push(text.slice(last));
    return parts;
}

function decodePacked(payload, radix, count, symtab) {
    let out = payload;
    for (let c = count - 1; c >= 0; c--) {
        const word = symtab[c];
        if (!word) continue;

        const token = numberToToken(c, radix);
        if (!token) continue;

        out = out.replace(
            new RegExp('\\b' + escapeRegExp(token) + '\\b', 'g'),
            () => word
        );
    }
    return out;
}

function unpackBlocks(text) {
    const results = [];
    const marker = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*(?:,\s*d\s*)?\)\s*\{/g;

    let match;
    while ((match = marker.exec(text))) {
        const braceStart = match.index + match[0].lastIndexOf('{');
        const braceEnd = findClosing(text, braceStart, '{', '}');
        if (braceEnd === -1) continue;

        let index = braceEnd + 1;
        while (index < text.length && /\s/.test(text[index])) index++;
        if (text[index] !== '(') continue;

        const argsEnd = findClosing(text, index, '(', ')');
        if (argsEnd === -1) continue;

        const args = splitTopLevel(text.slice(index + 1, argsEnd), ',');
        if (args.length < 4) continue;

        try {
            const payload = readStringLiteral(args[0]);
            const radix = parseInt(args[1].trim(), 10);
            const count = parseInt(args[2].trim(), 10);
            const symtabRaw = readStringLiteral(args[3]);

            if (
                payload === null ||
                symtabRaw === null ||
                !Number.isFinite(radix) ||
                !Number.isFinite(count)
            ) {
                continue;
            }

            results.push(decodePacked(payload, radix, count, symtabRaw.split('|')));
        } catch {
            // bozuk packer bloğunu atla
        }

        marker.lastIndex = Math.max(marker.lastIndex, argsEnd);
    }

    return results;
}

function unpackAll(source, depth = 2) {
    const results = [];
    const seen = new Set();
    let queue = [source];

    for (let level = 0; level < depth; level++) {
        const next = [];
        for (const text of queue) {
            for (const unpacked of unpackBlocks(text)) {
                if (seen.has(unpacked)) continue;
                seen.add(unpacked);
                results.push(unpacked);
                next.push(unpacked);
            }
        }
        if (next.length === 0) break;
        queue = next;
    }

    return results;
}

// ------------------------------------------------------------
// Sayfa içinden medya adresi bulma
// ------------------------------------------------------------

function collectMediaUrls(text) {
    const scored = new Map();

    const add = (raw, bonus = 0) => {
        if (!raw) return;

        let url = String(raw)
            .trim()
            .replace(/&amp;/gi, '&')
            .replace(/[)\].,;'"]+$/g, '');

        if (url.startsWith('//')) url = `https:${url}`;
        if (!/^https?:\/\//i.test(url)) return;
        if (STATIC_ASSET_RE.test(url)) return;
        if (!MEDIA_EXT_RE.test(url) && bonus < 5) return;
        if (JUNK_RE.test(url)) return;

        let score = bonus;
        if (HLS_RE.test(url)) score += 10;
        else if (/\.mp4(?:$|[?#])/i.test(url)) score += 6;
        else if (FILE_RE.test(url)) score += 3;
        if (/master/i.test(url)) score += 2;
        if (/index\.m3u8/i.test(url)) score += 1;
        if (/\/ads?\//i.test(url)) score -= 20;

        scored.set(url, Math.max(scored.get(url) || 0, score));
    };

    // 1) Oynatıcı kaynak alanları: file:, source:, hls:, wurl: ...
    //    (uzantısız akış adresleri de olabilir, bu yüzden bonus yüksek)
    const strongFieldRe =
        /["']?(?:file|source|hls|playlist|video_url|wurl)["']?\s*[:=]\s*(["'])([^"'\\]+)\1/gi;
    for (const match of text.matchAll(strongFieldRe)) add(match[2], 8);

    // 2) src / url alanları: bunlardan sadece medya uzantılı olanları al
    const weakFieldRe =
        /["']?(?:src|url)["']?\s*[:=]\s*(["'])([^"'\\]+)\1/gi;
    for (const match of text.matchAll(weakFieldRe)) add(match[2], 0);

    // 3) Sayfadaki tüm medya uzantılı URL'ler
    const urlRe = /(?:https?:)?\/\/[^\s"'`<>()\\]+/gi;
    for (const match of text.matchAll(urlRe)) add(match[0], 0);

    return [...scored.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([url]) => url);
}

function findMedia(html) {
    if (!html) return null;

    const decoded = decodeJsEscapes(html);
    const chunks = [decoded, ...unpackAll(decoded)];

    for (const chunk of chunks) {
        const candidates = collectMediaUrls(decodeJsEscapes(chunk));
        if (candidates.length > 0) {
            const url = candidates[0];
            return {
                url,
                type: HLS_RE.test(url)
                    ? 'hls'
                    : FILE_RE.test(url)
                        ? 'file'
                        : 'unknown',
            };
        }
    }

    return null;
}

async function resolveFromPage(embedUrl, source, options = {}) {
    const page = await request(embedUrl, {
        referer: options.referer || `${new URL(embedUrl).origin}/`,
    });

    const found = findMedia(page.body);
    if (!found) {
        throw new ResolveError(
            `${source} sayfasında oynatılabilir bir adres bulunamadı. ` +
            'Sayfa korumalı / Cloudflare arkasında olabilir.'
        );
    }

    return makeResult(found.url, page.finalUrl, source, found.type);
}

// ------------------------------------------------------------
// Streamtape: link birkaç JS string'ine bölünmüş oluyor
// ------------------------------------------------------------

function extractStreamtapeLink(html, embedUrl) {
    const direct = html.match(/https?:\/\/[^"'\\\s<>]+?get_video\?[^"'\\\s<>]+/i);
    if (direct) return direct[0].replace(/&amp;/gi, '&');

    const index = html.indexOf('get_video');
    if (index === -1) return null;

    const scriptStart = Math.max(0, html.lastIndexOf('<script', index));
    const scriptEnd = html.indexOf('</script>', index);
    const chunk = html.slice(scriptStart, scriptEnd === -1 ? undefined : scriptEnd);

    const parts = [...chunk.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map(m => m[2]);
    const joined = parts.join('').replace(/\\\//g, '/');

    const match =
        joined.match(/(?:https?:)?\/\/[^"'\\\s<>]*get_video\?[^"'\\\s<>]*/i) ||
        joined.match(/\/get_video\?[^"'\\\s<>]*/i);

    if (!match) return null;

    let link = match[0];
    if (link.startsWith('//')) link = `https:${link}`;
    else if (link.startsWith('/')) link = new URL(link, embedUrl).href;

    return link.replace(/&amp;/gi, '&');
}

// ------------------------------------------------------------
// Doodstream: pass_md5 + token akışı
// ------------------------------------------------------------

function randomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
    return out;
}

async function resolveDoodstream(embedUrl) {
    const page = await request(embedUrl, { referer: `${new URL(embedUrl).origin}/` });

    const passPath = page.body.match(/\/pass_md5\/[^"'\s<>]+/i)?.[0];
    if (!passPath) {
        throw new ResolveError('Doodstream pass_md5 bağlantısı bulunamadı.');
    }

    const passUrl = new URL(passPath, page.finalUrl).href;
    const pass = await request(passUrl, { referer: page.finalUrl });
    const base = pass.body.trim();

    if (!/^https?:\/\//i.test(base)) {
        throw new ResolveError('Doodstream doğrudan adres üretilemedi.');
    }

    const token = passPath.split('/').filter(Boolean).pop();
    const direct =
        `${base}${randomString(10)}` +
        `?token=${encodeURIComponent(token)}` +
        `&expiry=${Date.now()}`;

    return makeResult(direct, page.finalUrl, 'Doodstream', 'file');
}

// ------------------------------------------------------------
// Voe: JS yönlendirmesi ardından hls kaynağı
// ------------------------------------------------------------

async function resolveVoe(embedUrl) {
    let page = await request(embedUrl, { referer: 'https://voe.sx/' });

    for (let i = 0; i < 2; i++) {
        const redirect = page.body.match(
            /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i
        );
        if (!redirect) break;

        let next;
        try {
            next = new URL(redirect[1], page.finalUrl).href;
        } catch {
            break;
        }

        const sameHost =
            new URL(next).hostname === new URL(page.finalUrl).hostname;
        if (!sameHost || next === page.finalUrl) break;

        page = await request(next, { referer: page.finalUrl });
    }

    const found = findMedia(page.body);
    if (!found) {
        throw new ResolveError('Voe sayfasında HLS kaynağı bulunamadı.');
    }

    return makeResult(found.url, page.finalUrl, 'Voe', found.type);
}

// ------------------------------------------------------------
// Kaynak tanımları
// ------------------------------------------------------------

const HANDLERS = [
    {
        name: 'Pixeldrain',
        test: host => host === 'pixeldrain.com' || host.endsWith('.pixeldrain.com'),
        resolve: async url => {
            const parsed = new URL(url);
            const match =
                parsed.pathname.match(/^\/(?:u|d|file)\/([\w-]+)/i) ||
                parsed.pathname.match(/^\/api\/file\/([\w-]+)/i);

            if (!match) {
                if (/^\/l\//i.test(parsed.pathname)) {
                    throw new ResolveError(
                        'Pixeldrain liste linkleri desteklenmiyor. Tek dosya linki (/u/...) kullanın.'
                    );
                }
                throw new ResolveError('Pixeldrain linki tanınamadı.');
            }

            const id = match[1];
            return makeResult(
                `https://pixeldrain.com/api/file/${id}`,
                `https://pixeldrain.com/u/${id}`,
                'Pixeldrain',
                'file'
            );
        },
    },
    {
        name: 'Filemoon',
        test: host => /^filemoon\./i.test(host),
        resolve: url => resolveFromPage(url, 'Filemoon'),
    },
    {
        name: 'Vidmoly',
        test: host => /^vidmoly\./i.test(host),
        resolve: url => resolveFromPage(url, 'Vidmoly'),
    },
    {
        name: 'Streamtape',
        test: host => /^streamtape\./i.test(host),
        resolve: async url => {
            const page = await request(url, { referer: `${new URL(url).origin}/` });
            const link = extractStreamtapeLink(page.body, page.finalUrl);

            if (!link) {
                throw new ResolveError('Streamtape video linki çıkarılamadı.');
            }

            return makeResult(link, page.finalUrl, 'Streamtape', 'file');
        },
    },
    {
        name: 'Doodstream',
        test: host => /dood|d000d|dooood|ds2play/i.test(host),
        resolve: url => resolveDoodstream(url),
    },
    {
        name: 'Voe',
        test: host => /^voe\./i.test(host),
        resolve: url => resolveVoe(url),
    },
    {
        name: 'MixDrop',
        test: host => /^mixdrop\./i.test(host),
        resolve: async url => {
            const page = await request(url, { referer: `${new URL(url).origin}/` });
            const wurl = page.body.match(
                /(?:MDCore\.)?wurl\s*[:=]\s*["']([^"']+)["']/i
            );

            if (wurl) {
                let direct = wurl[1];
                if (direct.startsWith('//')) direct = `https:${direct}`;
                return makeResult(direct, page.finalUrl, 'MixDrop', 'file');
            }

            const found = findMedia(page.body);
            if (!found) {
                throw new ResolveError('MixDrop video adresi bulunamadı.');
            }
            return makeResult(found.url, page.finalUrl, 'MixDrop', found.type);
        },
    },
];

// ------------------------------------------------------------
// Genel yedek: sayfayı indir, içinden medya adresi çıkar
// ------------------------------------------------------------

async function resolveGeneric(url) {
    const origin = `${new URL(url).origin}/`;
    const page = await request(url, { referer: origin });

    // URL zaten bir video/playlist döndürüyorsa doğrudan kullan
    if (/^(?:video|audio)\//i.test(page.contentType) || /mpegurl/i.test(page.contentType)) {
        const type =
            HLS_RE.test(page.finalUrl) || /mpegurl/i.test(page.contentType)
                ? 'hls'
                : 'file';
        return makeResult(page.finalUrl, origin, new URL(url).hostname, type);
    }

    const found = findMedia(page.body);
    if (!found) {
        throw new ResolveError(
            'Bu bağlantıdan doğrudan video adresi çıkarılamadı. ' +
            'MP4/M3U8 linki veya desteklenen bir embed adresi kullanın.'
        );
    }

    return makeResult(found.url, page.finalUrl, new URL(url).hostname, found.type);
}

// Uzantısız akış adreslerinde içerik türünü başlıktan/ilk baytlardan anlamaya çalışır.
async function probeType(url, referer) {
    try {
        const probe = await request(url, {
            referer: referer || `${new URL(url).origin}/`,
            headers: { Range: 'bytes=0-1023' },
            timeoutMs: 10000,
        });

        if (/mpegurl/i.test(probe.contentType)) return 'hls';
        if (probe.body.trimStart().startsWith('#EXTM3U')) return 'hls';
        return 'file';
    } catch {
        return 'file';
    }
}

async function finalizeResult(result) {
    if (!result || result.type !== 'unknown') return result;
    return { ...result, type: await probeType(result.url, result.referer) };
}

// ------------------------------------------------------------
// Dışa açılan fonksiyon
// ------------------------------------------------------------

export async function resolveVideoUrl(input) {
    const raw = extractUrl(input);
    const parsed = assertSafeUrl(raw);

    if (isDirect(parsed.href)) {
        return makeResult(
            parsed.href,
            `${parsed.origin}/`,
            'Doğrudan bağlantı',
            HLS_RE.test(parsed.href) ? 'hls' : 'file'
        );
    }

    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();

    for (const handler of HANDLERS) {
        if (handler.test(host)) {
            return await finalizeResult(await handler.resolve(parsed.href, host));
        }
    }

    return await finalizeResult(await resolveGeneric(parsed.href));
}

