import { URL } from 'url';

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

/**
 * Yönlendirmeleri takip eden, çerez toplayan basit GET istemcisi.
 * Video/octet-stream yanıtlarında gövde okunmaz (diski/ram'i şişirmemek için).
 */
export async function request(rawUrl, options = {}) {
    const {
        referer,
        headers = {},
        maxRedirects = 6,
        timeoutMs = 20000,
    } = options;

    let current = assertSafeUrl(rawUrl).href;

    for (let hop = 0; hop <= maxRedirects; hop++) {
        assertSafeUrl(current);

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
                method: 'GET',
                headers: requestHeaders,
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

        let body = '';
        if (!isBinary) {
            body = await response.text();
            if (body.length > 4_000_000) body = body.slice(0, 4_000_000);
        } else {
            discardBody(response);
        }

        return { finalUrl: current, status, contentType, headers: response.headers, body };
    }

    throw new Error('Çok fazla yönlendirme var.');
}

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
