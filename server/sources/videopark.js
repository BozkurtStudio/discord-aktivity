import { request } from '../net.js';
import { createCache, extractBalancedObject } from './util.js';

// JetFilmizle'nin kullandığı videopark.top oynatıcısı.
// /go/ ve /vip/ worker API, /apollo/ token API'si, /you/v/ inline HLS kullanır.

const cache = createCache(5 * 60_000);

function normalizeWorkerBase(value) {
    if (!value) return null;
    const cleaned = String(value).replace(/\\\//g, '/').trim();
    if (!/^https?:\/\//i.test(cleaned)) return null;
    return cleaned.replace(/\/+$/, '');
}

function readSourceFile(item) {
    if (!item) return null;
    if (typeof item === 'string') return item;
    return item.file || item.url || null;
}

function collectMp4Sources(data) {
    const list = Array.isArray(data?.mp4Sources) ? data.mp4Sources : [];
    return list
        .map(item => {
            const file = readSourceFile(item);
            if (!file) return null;
            const label = typeof item === 'object'
                ? item.label || item.quality || item.name || null
                : null;
            const height = label ? parseInt(String(label), 10) : NaN;
            return {
                label: label || 'MP4',
                height: Number.isFinite(height) ? height : null,
                url: file,
            };
        })
        .filter(Boolean);
}

function pickHlsSource(data) {
    const direct = data?.hlsSource?.file;
    if (direct) return direct;

    const list = Array.isArray(data?.sources) ? data.sources : [];
    const match = list.find(item => {
        const file = readSourceFile(item);
        if (!file) return false;
        return item?.type === 'hls' || /\.m3u8(?:$|[?#])/i.test(file);
    });
    return readSourceFile(match);
}

function buildStreamResult(data, pageUrl, fallbackTitle) {
    const hlsUrl = pickHlsSource(data);
    const mp4s = collectMp4Sources(data);
    const poster = data?.proxyImage || data?.image || data?.poster || null;
    const title = data?.title && data.title !== String(new URL(pageUrl).searchParams.get('id') || '')
        ? data.title
        : fallbackTitle || null;

    if (hlsUrl) {
        return {
            url: hlsUrl,
            type: 'hls',
            referer: pageUrl,
            source: 'Videopark',
            title,
            poster,
            qualities: [
                { label: 'Auto', height: null, url: hlsUrl },
                ...mp4s,
            ],
        };
    }

    if (mp4s.length > 0) {
        const best = mp4s[0];
        return {
            url: best.url,
            type: 'file',
            referer: pageUrl,
            source: 'Videopark',
            title,
            poster,
            qualities: mp4s,
        };
    }

    throw new Error('Videopark oynatıcısında akış adresi bulunamadı.');
}

async function resolveMovie(pageUrl) {
    const page = await request(pageUrl, {
        referer: 'https://jetfilmizle.app/',
        timeoutMs: 20000,
    });

    const workerMatch = page.body.match(/WORKER_BASE\s*=\s*["']([^"']+)["']/i);
    const videoMatch = page.body.match(/VIDEO_ID\s*=\s*["']?([\w-]+)["']?/i);
    const workerBase = normalizeWorkerBase(workerMatch?.[1]);
    const videoId = videoMatch?.[1];

    if (!workerBase || !videoId) {
        throw new Error('Videopark film oynatıcı bilgileri bulunamadı.');
    }

    let info = null;
    try {
        const infoResponse = await request(`${workerBase}/v/${videoId}/info`, {
            referer: pageUrl,
            headers: { Accept: 'application/json' },
            timeoutMs: 15000,
        });
        info = JSON.parse(infoResponse.body);
    } catch {
        // Bilgi alınamazsa kalitesiz akış adresini kullan.
    }

    const qualities = Array.isArray(info?.qualities)
        ? [...info.qualities].map(q => parseInt(q, 10)).filter(Number.isFinite).sort((a, b) => b - a)
        : [];

    const bestQuality = qualities[0];
    const streamUrl = bestQuality
        ? `${workerBase}/v/${videoId}?q=${bestQuality}`
        : `${workerBase}/v/${videoId}`;

    return {
        url: streamUrl,
        type: 'file',
        referer: pageUrl,
        source: 'Videopark',
        title: info?.title || null,
        poster: info?.poster || null,
        qualities: qualities.map(q => ({
            label: `${q}p`,
            height: q,
            url: `${workerBase}/v/${videoId}?q=${q}`,
        })),
    };
}

async function resolveSeries(pageUrl) {
    const page = await request(pageUrl, {
        referer: 'https://jetfilmizle.app/',
        timeoutMs: 20000,
    });

    const initialIndex = page.body.search(/(?:const|var|let)\s+initial\s*=\s*\{/);
    let initial = null;

    if (initialIndex !== -1) {
        const braceIndex = page.body.indexOf('{', initialIndex);
        const raw = extractBalancedObject(page.body, braceIndex);
        if (raw) {
            try {
                initial = JSON.parse(raw);
            } catch {
                initial = null;
            }
        }
    }

    if (!initial) {
        // Bazı sürümlerde değişken adı farklı olabilir; ilk kaynak bloğunu ara.
        const sourceMatch = page.body.match(
            /["']sources["']\s*:\s*\[\s*\{\s*["']file["']\s*:\s*["']([^"']+)["']/i
        );
        if (!sourceMatch) {
            throw new Error('Videopark dizi kaynağı bulunamadı.');
        }
        initial = { sources: [{ file: sourceMatch[1], type: 'hls' }] };
    }

    const sources = Array.isArray(initial.sources) ? initial.sources : [];
    const playable = sources.filter(source => source?.file);
    if (playable.length === 0) {
        throw new Error('Videopark dizi kaynak listesi boş.');
    }

    const best = playable[0];
    const tracks = Array.isArray(initial.tracks)
        ? initial.tracks
            .map(track => {
                const trackUrl = track.file || track.url;
                if (!trackUrl) return null;
                return {
                    url: trackUrl,
                    label: track.label || track.lang || 'Altyazı',
                    lang: track.lang || null,
                };
            })
            .filter(Boolean)
        : [];

    return {
        url: best.file,
        type: best.type === 'hls' || /\.m3u8(?:$|[?#])/i.test(best.file) ? 'hls' : 'file',
        referer: pageUrl,
        source: 'Videopark',
        title: initial.title || null,
        tracks,
        qualities: playable.map((source, index) => ({
            label: source.label || `Kaynak ${index + 1}`,
            height: null,
            url: source.file,
        })),
    };
}

async function resolveVip(pageUrl) {
    const page = await request(pageUrl, {
        referer: 'https://jetfilmizle.app/',
        timeoutMs: 20000,
    });

    const worker = normalizeWorkerBase(
        page.body.match(/WORKER_URL\s*=\s*["']([^"']+)["']/i)?.[1]
    );
    const videoId = page.body.match(/VIDEO_ID\s*=\s*["']?([\w-]+)["']?/i)?.[1];
    const pubId = page.body.match(/PUB_ID\s*=\s*["']?([\w-]+)["']?/i)?.[1];
    const publisherId = page.body.match(/PUBLISHER_ID\s*=\s*["']?([\w-]+)["']?/i)?.[1];

    if (!worker || !videoId) {
        throw new Error('Videopark VIP oynatıcı bilgileri bulunamadı.');
    }

    const apiUrl = pubId
        ? `${worker}/api/stream?pubId=${encodeURIComponent(pubId)}` +
            `&title=${encodeURIComponent(videoId)}` +
            (publisherId ? `&publisherId=${encodeURIComponent(publisherId)}` : '')
        : `${worker}/api/video?id=${encodeURIComponent(videoId)}`;

    let data;
    try {
        const response = await request(apiUrl, {
            referer: pageUrl,
            headers: { Accept: 'application/json' },
            timeoutMs: 15000,
        });
        data = JSON.parse(response.body);
    } catch {
        throw new Error('Videopark VIP akış bilgileri alınamadı.');
    }

    return buildStreamResult(data, pageUrl, null);
}

// JetFilmizle'nin bazı dizileri JWPlayer tabanlı /titan/ oynatıcısını kullanır.
// Akış (stream_url) ve altyazılar sayfadaki _sd değişkenine gömülüdür.
async function resolveTitan(pageUrl) {
    const page = await request(pageUrl, {
        referer: 'https://jetfilmizle.app/',
        timeoutMs: 20000,
    });

    const marker = page.body.search(/var\s+_sd\s*=\s*\{/);
    if (marker === -1) throw new Error('Videopark titan oynatıcı verisi bulunamadı.');

    const raw = extractBalancedObject(page.body, page.body.indexOf('{', marker));
    let data = null;
    try {
        data = raw ? JSON.parse(raw) : null;
    } catch {
        data = null;
    }
    if (!data?.stream_url) throw new Error('Videopark titan akış adresi bulunamadı.');

    const tracks = Array.isArray(data.subtitles)
        ? data.subtitles
            .map(track => {
                if (!track?.file) return null;
                return {
                    url: track.file,
                    label: track.label || 'Altyazı',
                    lang: track.lang || null,
                };
            })
            .filter(Boolean)
        : [];

    return {
        url: data.stream_url,
        type: 'hls',
        referer: pageUrl,
        source: 'Videopark',
        title: data.title || null,
        poster: data.poster || null,
        tracks,
        qualities: [],
    };
}

async function resolveApollo(pageUrl) {
    const parsed = new URL(pageUrl);
    const videoId = parsed.searchParams.get('id');
    if (!videoId) {
        throw new Error('Videopark Apollo video kimliği eksik.');
    }

    const endpoint = new URL('get_video.php', pageUrl).href;
    const response = await request(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ id: videoId }).toString(),
        referer: pageUrl,
        headers: {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        timeoutMs: 20000,
    });

    let data;
    try {
        data = JSON.parse(response.body);
    } catch {
        throw new Error('Videopark Apollo yanıtı okunamadı.');
    }

    if (!data?.hlsUrl) {
        throw new Error(data?.error || 'Videopark Apollo akış adresi bulunamadı.');
    }

    return {
        url: new URL(data.hlsUrl, pageUrl).href,
        type: 'hls',
        referer: pageUrl,
        source: 'Videopark',
        title: data.title || null,
        poster: data.image || null,
        qualities: [],
    };
}

export async function resolveVideopark(url) {
    const parsed = new URL(url);
    const key = parsed.href;
    const cached = cache.get(key);
    if (cached) return cached;

    let result;
    if (/^\/you\/v\//i.test(parsed.pathname)) {
        result = await resolveSeries(parsed.href);
    } else if (/^\/titan\//i.test(parsed.pathname)) {
        result = await resolveTitan(parsed.href);
    } else if (/^\/vip\//i.test(parsed.pathname)) {
        result = await resolveVip(parsed.href);
    } else if (/^\/apollo\//i.test(parsed.pathname)) {
        result = await resolveApollo(parsed.href);
    } else if (/^\/vk\//i.test(parsed.pathname)) {
        throw new Error('Videopark VK oynatıcısı desteklenmiyor. Başka bir kaynak deneyin.');
    } else if (/^\/mail\//i.test(parsed.pathname)) {
        throw new Error('Videopark Mail.ru oynatıcısı desteklenmiyor. Başka bir kaynak deneyin.');
    } else if (/^\/tr\//i.test(parsed.pathname)) {
        throw new Error('Videopark TRPlay oynatıcısı desteklenmiyor. Başka bir kaynak deneyin.');
    } else if (/^\/jetembed\//i.test(parsed.pathname)) {
        throw new Error('JetGlobal oynatıcısı doğrudan akış vermiyor. Başka bir kaynak deneyin.');
    } else {
        result = await resolveMovie(parsed.href);
    }

    cache.set(key, result);
    return result;
}

export const videopark = {
    hosts: ['videopark.top'],
    resolve: resolveVideopark,
};
