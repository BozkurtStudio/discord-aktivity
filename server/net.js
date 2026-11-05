import { URL } from 'url';
import dns from 'dns';

// Barındırma ortamlarında (ör. Render) IPv6 çıkışı bazı kaynak sitelerce
// engellenebiliyor. A kaydı varsa IPv4'ü tercih et; yoksa yine IPv6'ya düşer.
try {
    dns.setDefaultResultOrder('ipv4first');
} catch {
    /* eski Node sürümlerinde yoksa yok say */
}

// Embed sayfalarının çoğu tarayıcı benzeri bir User-Agent bekliyor.
export const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ALLOW_PRIVATE_HOSTS = process.env.ALLOW_PRIVATE_HOSTS === '1';

// Embed sayfalarından alınan çerezler (bazı kaynaklar pass/token için istiyor).
// Sunucu ile oynatıcı aynı IP'den çıktığı için bu çerezler proxy'de de işe yarıyor.
const cookieJar = new Map();

function jarFor(hostname) {
    let jar = cookieJar.get(hostname);
    if (!jar) {
        jar = new Map();
        cookieJar.set(hostname, jar);
    }
    return jar;
}

export function storeSetCookies(targetUrl, setCookieHeaders = []) {
    if (!setCookieHeaders || setCookieHeaders.length === 0) return;
    let hostname;
    try {
        hostname = new URL(targetUrl).hostname;
    } catch {
        return;
    }

    const jar = jarFor(hostname);
    for (const raw of setCookieHeaders) {
        const pair = String(raw).split(';')[0];
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
}

export function cookieHeaderFor(targetUrl) {
    try {
        const jar = cookieJar.get(new URL(targetUrl).hostname);
        if (!jar || jar.size === 0) return '';
        return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    } catch {
        return '';
    }
}

export function clearCookies() {
    cookieJar.clear();
}

const PRIVATE_HOST_RE = new RegExp(
    '^(?:' +
    [
        'localhost',
        '.*\\.localhost',
        '.*\\.local',
        '0\\.0\\.0\\.0',
        '127\\.\\d+\\.\\d+\\.\\d+',
        '10\\.\\d+\\.\\d+\\.\\d+',
        '192\\.168\\.\\d+\\.\\d+',
        '169\\.254\\.\\d+\\.\\d+',
        '172\\.(?:1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+',
        '\\[?::1\\]?',
        '\\[?fc[0-9a-f]{2}:.*',
        '\\[?fd[0-9a-f]{2}:.*',
    ].join('|') +
    ')$',
    'i'
);

/**
 * Proxy ve çözümleyiciye giren URL'lerin http(s) olduğundan ve
 * iç ağa (SSRF) gitmediğinden emin olur.
 */
export function assertSafeUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('Geçersiz URL.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Sadece http ve https adresleri destekleniyor.');
    }

    if (!ALLOW_PRIVATE_HOSTS && PRIVATE_HOST_RE.test(parsed.hostname)) {
        throw new Error('Yerel ağ adreslerine erişim kapalı.');
    }

    return parsed;
}

function discardBody(response) {
    try {
        response.body?.cancel();
    } catch {
        // yoksay
    }
}

// ------------------------------------------------------------
// Host bazlı nazik istek sıralaması
// Aynı siteye art arda yüklenmek 429 / Cloudflare challenge tetikliyor.
// ------------------------------------------------------------

const hostNextAllowed = new Map();
const DEFAULT_HOST_INTERVAL_MS = 120;

function hostIntervalFor(hostname) {
    const host = hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'sezonlukdizi.cc') return 550;
    if (host === 'jetfilmizle.app') return 250;
    if (host === 'bysejikuar.com') return 250;
    if (host === 'videopark.top') return 150;
    if (host === 'godrive.erikkalinina1994.workers.dev') return 150;
    return DEFAULT_HOST_INTERVAL_MS;
}

async function throttleHost(hostname, overrideMs = null) {
    const interval = overrideMs ?? hostIntervalFor(hostname);
    if (interval <= 0) return;

    const now = Date.now();
    const next = hostNextAllowed.get(hostname) || 0;
    const wait = Math.max(0, next - now);
    hostNextAllowed.set(hostname, Math.max(now, next) + interval);
    if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
    }
}

// ------------------------------------------------------------
// Basit TTL önbelleği
// ------------------------------------------------------------

const responseCache = new Map();

function cacheGet(key) {
    const hit = responseCache.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
        responseCache.delete(key);
        return null;
    }
    return hit.value;
}

function cacheSet(key, value, ttlMs) {
    if (!ttlMs || ttlMs <= 0) return;
    if (responseCache.size > 300) {
        // En eski kayıtları at
        let i = 0;
        for (const k of responseCache.keys()) {
            if (i++ >= 60) break;
            responseCache.delete(k);
        }
    }
    responseCache.set(key, { value, expires: Date.now() + ttlMs });
}

export function clearResponseCache() {
    responseCache.clear();
}

// ------------------------------------------------------------
// Karakter kodlaması
// ------------------------------------------------------------

const CHARSET_ALIASES = new Map([
    ['iso-8859-9', 'windows-1254'],
    ['latin5', 'windows-1254'],
    ['cp1254', 'windows-1254'],
    ['utf8', 'utf-8'],
]);

function normalizeCharset(charset) {
    if (!charset) return null;
    const value = String(charset).trim().toLowerCase().replace(/^["']|["']$/g, '');
    return CHARSET_ALIASES.get(value) || value;
}

function charsetFromContentType(contentType) {
    const match = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
    return normalizeCharset(match?.[1]);
}

function decodeBody(buffer, contentType, explicitEncoding) {
    const charset = normalizeCharset(explicitEncoding) || charsetFromContentType(contentType) || 'utf-8';
    try {
        return new TextDecoder(charset).decode(buffer);
    } catch {
        try {
            return new TextDecoder('windows-1254').decode(buffer);
        } catch {
            return buffer.toString('utf8');
        }
    }
}

// ------------------------------------------------------------
// İstek istemcisi
// ------------------------------------------------------------

/**
 * Yönlendirmeleri takip eden, çerez toplayan basit istemci.
 * GET ve POST (form) destekler, charset'i Content-Type'tan çözer,
 * aynı hosta yapılan istekleri kısa aralıklarla sıraya sokar.
 *
 * Video/octet-stream yanıtlarında gövde okunmaz (diski/ram'i şişirmemek için).
 */
export async function request(rawUrl, options = {}) {
    const {
        referer,
        headers = {},
        maxRedirects = 6,
        timeoutMs = 20000,
        method: initialMethod = 'GET',
        body: initialBody = null,
        encoding = null,
        cacheTtlMs = 0,
        maxBytes = 4_000_000,
        hostIntervalMs = null,
    } = options;

    let method = String(initialMethod || 'GET').toUpperCase();
    let body = initialBody;

    if (body instanceof URLSearchParams) body = body.toString();
    if (typeof body === 'string') {
        // Form gövdesi için varsayılan içerik tipi
        if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }
    }

    let current = assertSafeUrl(rawUrl).href;

    const cacheable = method === 'GET' && cacheTtlMs > 0;
    const cacheKey = cacheable
        ? `${method} ${current} ${headers.Accept || ''} ${headers.Referer || referer || ''} ${encoding || ''}`
        : null;

    if (cacheKey) {
        const cached = cacheGet(cacheKey);
        if (cached) return cached;
    }

    for (let hop = 0; hop <= maxRedirects; hop++) {
        const parsedCurrent = assertSafeUrl(current);
        await throttleHost(parsedCurrent.hostname, hostIntervalMs);

        const requestHeaders = {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            ...headers,
        };
        if (referer) requestHeaders.Referer = referer;

        const cookies = cookieHeaderFor(current);
        if (cookies) requestHeaders.Cookie = cookies;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response;
        try {
            response = await fetch(current, {
                method,
                headers: requestHeaders,
                body: method === 'GET' || method === 'HEAD' ? undefined : body,
                redirect: 'manual',
                signal: controller.signal,
            });
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('Kaynak sunucu zaman aşımına uğradı.');
            }
            throw new Error(`Kaynağa bağlanılamadı: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }

        const setCookies =
            typeof response.headers.getSetCookie === 'function'
                ? response.headers.getSetCookie()
                : [];
        storeSetCookies(current, setCookies);

        const status = response.status;
        const location = response.headers.get('location');

        if (status >= 300 && status < 400 && location) {
            discardBody(response);

            // 303 (ve tarayıcı davranışı olarak 301/302) POST'u GET'e çevirir.
            if (
                method !== 'GET' &&
                method !== 'HEAD' &&
                (status === 301 || status === 302 || status === 303)
            ) {
                method = 'GET';
                body = null;
            }

            current = new URL(location, current).href;
            continue;
        }

        if (status >= 400) {
            discardBody(response);
            throw new Error(`Kaynak ${status} HTTP hatası döndürdü.`);
        }

        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const isBinary =
            /^(?:video|audio|image)\//.test(contentType) ||
            contentType.includes('octet-stream');

        let text = '';
        if (!isBinary) {
            const buffer = Buffer.from(await response.arrayBuffer());
            const slice = buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
            text = decodeBody(slice, contentType, encoding);
        } else {
            discardBody(response);
        }

        const result = {
            finalUrl: current,
            status,
            contentType,
            headers: response.headers,
            body: text,
        };

        if (cacheKey) cacheSet(cacheKey, result, cacheTtlMs);
        return result;
    }

    throw new Error('Çok fazla yönlendirme var.');
}

// ------------------------------------------------------------
// Proxy başlıkları
// ------------------------------------------------------------

/**
 * Proxy'nin hedefe göndereceği başlıklar. Referer/Origin olmadan
 * Filemoon, Vidmoly, Streamtape gibi kaynaklar 403 döndürüyor.
 */
export function buildProxyHeaders(targetUrl, options = {}) {
    const { range, referer } = options;
    const target = assertSafeUrl(targetUrl);

    let refererValue = referer;
    if (!refererValue || !/^https?:\/\//i.test(refererValue)) {
        refererValue = `${target.origin}/`;
    }

    const headers = {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Referer': refererValue,
        'Origin': new URL(refererValue).origin,
        'Connection': 'keep-alive',
    };

    if (range) headers.Range = range;

    const cookies = cookieHeaderFor(targetUrl);
    if (cookies) headers.Cookie = cookies;

    return headers;
}
