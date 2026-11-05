import crypto from 'crypto';
import { request } from '../net.js';
import { createCache } from './util.js';

// Byse / Filemoon oynatıcısı, kaynak listesini AES-256-GCM ile şifreliyor.
// Şifre çözme tamamen sunucu tarafında yapılıyor.

const cache = createCache(3 * 60_000);

function b64urlToBuffer(value) {
    let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4 !== 0) text += '=';
    return Buffer.from(text, 'base64');
}

function extractCode(url) {
    try {
        const parsed = new URL(url);
        const match = parsed.pathname.match(/^\/(?:e|d|v|embed)\/([\w-]+)/i);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

function pickKey(keyParts, version) {
    const parts = Array.isArray(keyParts) ? keyParts.filter(Boolean) : [];
    if (parts.length === 0) return null;

    const v = Number.isFinite(version) ? version : 0;
    const preferred = [];

    // 1 tabanlı [version, 31 - version] çifti (array: [v-1, 30-v])
    if (v >= 1 && v <= parts.length) {
        preferred.push([parts[v - 1], parts[30 - v]]);
        preferred.push([parts[v - 1], parts[31 - v]]);
        preferred.push([parts[v], parts[30 - v]]);
    }

    for (const pair of preferred) {
        const selected = pair.filter(Boolean);
        if (selected.length !== 2) continue;
        const key = Buffer.concat(selected.map(b64urlToBuffer));
        if (key.length === 32) return key;
    }

    // Beklenen çift bulunamazsa 32 bayt eden ilk çifti dene.
    for (let i = 0; i < parts.length; i++) {
        const a = b64urlToBuffer(parts[i]);
        if (a.length >= 32) continue;
        for (let j = i + 1; j < parts.length; j++) {
            const b = b64urlToBuffer(parts[j]);
            if (a.length + b.length === 32) return Buffer.concat([a, b]);
        }
    }

    return null;
}

function decryptPlayback(playback) {
    const algorithm = String(playback?.algorithm || '').toUpperCase();
    if (algorithm && algorithm !== 'AES-256-GCM') {
        throw new Error(`Desteklenmeyen şifreleme: ${algorithm}`);
    }

    const version = parseInt(playback.version, 10);
    const key = pickKey(playback.key_parts, version);
    if (!key) throw new Error('Byse şifreleme anahtarı çözülemedi.');

    const iv = b64urlToBuffer(playback.iv);
    const payload = b64urlToBuffer(playback.payload);
    if (payload.length <= 16) throw new Error('Byse şifreli verisi geçersiz.');

    const tag = payload.subarray(payload.length - 16);
    const data = payload.subarray(0, payload.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');

    return JSON.parse(plain);
}

function normalizeTracks(tracks) {
    if (!Array.isArray(tracks)) return [];
    return tracks
        .map(track => {
            const url = track.file || track.url || track.src;
            if (!url) return null;
            return {
                url,
                label: track.label || track.lang || 'Altyazı',
                lang: track.lang || null,
            };
        })
        .filter(Boolean);
}

export async function resolveByse(url) {
    const code = extractCode(url);
    if (!code) throw new Error('Byse video kodu bulunamadı.');

    const cached = cache.get(code);
    if (cached) return cached;

    const embedUrl = `https://bysejikuar.com/e/${code}`;
    const apiUrl = `https://bysejikuar.com/api/videos/${code}/`;

    const response = await request(apiUrl, {
        referer: embedUrl,
        headers: { Accept: 'application/json' },
        timeoutMs: 20000,
    });

    let payload;
    try {
        payload = JSON.parse(response.body);
    } catch {
        throw new Error('Byse API yanıtı okunamadı.');
    }

    if (!payload?.playback) {
        throw new Error('Byse oynatma verisi bulunamadı.');
    }

    const decrypted = decryptPlayback(payload.playback);
    const sources = Array.isArray(decrypted.sources) ? decrypted.sources : [];

    const playable = sources
        .filter(source => source && source.url)
        .sort((a, b) => (b.height || 0) - (a.height || 0));

    if (playable.length === 0) {
        throw new Error('Byse kaynak listesi boş.');
    }

    const best = playable[0];
    const result = {
        url: best.url,
        type: best.mime_type?.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(best.url)
            ? 'hls'
            : 'file',
        referer: embedUrl,
        source: 'Filemoon',
        title: payload.title || null,
        tracks: normalizeTracks(decrypted.tracks || payload.tracks),
        qualities: playable.map(source => ({
            label: source.label || (source.height ? `${source.height}p` : null),
            height: source.height || null,
            url: source.url,
        })),
    };

    cache.set(code, result);
    return result;
}

export const byse = {
    hosts: ['bysejikuar.com'],
    resolve: resolveByse,
};
