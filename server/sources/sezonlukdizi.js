import { request } from '../net.js';
import {
    absoluteUrl,
    createCache,
    decodeHtmlEntities,
    extractMeta,
    normalizeWhitespace,
    slugFromUrl,
    stripTags,
    toInt,
} from './util.js';

const BASE = 'https://sezonlukdizi.cc';
const cache = createCache(10 * 60_000);

function yearFromTitle(title) {
    const match = /\((\d{4})\)\s*$/.exec(title || '');
    return match ? match[1] : null;
}

function mapSearchItem(item) {
    const url = absoluteUrl(BASE, item.url);
    const title = decodeHtmlEntities(item.title || '').trim();
    return {
        source: 'sezonlukdizi',
        sourceLabel: 'Sezonluk Dizi',
        id: item.did ?? null,
        slug: slugFromUrl(url),
        title,
        year: yearFromTitle(title),
        poster: absoluteUrl(BASE, item.image),
        rating: item.imdb ? String(item.imdb) : null,
        description: normalizeWhitespace(item.description || ''),
        type: 'series',
        url,
    };
}

async function search(query) {
    const body = new URLSearchParams({ q: query }).toString();
    const response = await request(`${BASE}/ajax/arama.asp`, {
        method: 'POST',
        body,
        referer: `${BASE}/`,
        headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        timeoutMs: 20000,
    });

    let data;
    try {
        data = JSON.parse(response.body);
    } catch {
        throw new Error('Sezonluk Dizi arama yanıtı okunamadı.');
    }

    const series = data?.results?.diziler?.results;
    const results = Array.isArray(series) ? series.map(mapSearchItem) : [];
    return { results, note: null };
}

function parseEpisodeRows(html) {
    const episodes = [];

    for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const row = rowMatch[1];
        const bid = row.match(/\bbid\s*=\s*['"](\d+)['"]/i)?.[1];
        if (!bid) continue;

        const href = row.match(/href\s*=\s*['"]([^'"]+\.html)['"]/i)?.[1];
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTags(m[1]));
        if (cells.length < 3) continue;

        const seasonCell = cells.find(cell => /Sezon/i.test(cell));
        const episodeCell = cells.find(cell => /Bölüm/i.test(cell));
        const season = toInt(seasonCell?.match(/(\d+)\s*\.\s*Sezon/i)?.[1]);
        const episode = toInt(episodeCell?.match(/(\d+)\s*\.\s*Bölüm/i)?.[1]);
        if (!season || !episode) continue;

        const episodeIndex = cells.indexOf(episodeCell);
        const title = cells[episodeIndex + 1] || null;
        const date = cells.find(cell => /^\d{2}\.\d{2}\.\d{4}$/.test(cell)) || null;

        episodes.push({
            id: bid,
            season,
            episode,
            title,
            date,
            url: absoluteUrl(BASE, href),
        });
    }

    return episodes;
}

async function details(input = {}) {
    let pageUrl = input.url || null;
    const slug = input.slug || (pageUrl ? slugFromUrl(pageUrl) : null) || (typeof input.id === 'string' && !/^\d+$/.test(input.id) ? input.id : null);

    if (!pageUrl && slug) pageUrl = `${BASE}/diziler/${slug}.html`;
    if (!pageUrl) throw new Error('Dizi adresi belirtilmedi.');

    let parsedPage;
    try {
        parsedPage = new URL(pageUrl);
    } catch {
        throw new Error('Geçersiz dizi adresi.');
    }
    if (!/(^|\.)sezonlukdizi\.cc$/i.test(parsedPage.hostname)) {
        throw new Error('Bu adres Sezonluk Dizi kaynağına ait değil.');
    }

    const cacheKey = `details:${pageUrl}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const page = await request(pageUrl, {
        referer: `${BASE}/`,
        cacheTtlMs: 5 * 60_000,
        timeoutMs: 25000,
    });

    const title = extractMeta(page.body, 'og:title')?.replace(/\s*izle\s*-\s*Sezonluk Dizi.*$/i, '').trim()
        || stripTags(page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
            .replace(/\s*izle\s*-\s*Sezonluk Dizi.*$/i, '')
            .trim();

    const poster = extractMeta(page.body, 'og:image');
    const description = extractMeta(page.body, 'og:description');
    const did = page.body.match(/id=["']dizidetay["'][^>]*data-id=["']([^"']+)/i)?.[1]
        || page.body.match(/data-id=["']([^"']+)["'][^>]*id=["']dizidetay/i)?.[1]
        || null;

    const finalSlug = slug || slugFromUrl(page.finalUrl);
    const episodesUrl = `${BASE}/bolumler/${finalSlug}.html`;

    let episodes = [];
    try {
        const episodesPage = await request(episodesUrl, {
            referer: page.finalUrl,
            cacheTtlMs: 5 * 60_000,
            timeoutMs: 25000,
        });
        episodes = parseEpisodeRows(episodesPage.body);
    } catch {
        episodes = [];
    }

    const seasonMap = new Map();
    for (const episode of episodes) {
        if (!seasonMap.has(episode.season)) {
            seasonMap.set(episode.season, {
                season: episode.season,
                label: `${episode.season}. Sezon`,
                episodes: [],
            });
        }
        seasonMap.get(episode.season).episodes.push(episode);
    }

    const seasons = [...seasonMap.values()].sort((a, b) => a.season - b.season);
    for (const season of seasons) {
        season.episodes.sort((a, b) => a.episode - b.episode);
    }

    const result = {
        source: 'sezonlukdizi',
        sourceLabel: 'Sezonluk Dizi',
        id: did,
        slug: finalSlug,
        title: title || finalSlug,
        poster,
        description,
        type: 'series',
        url: page.finalUrl,
        seasons,
        episodeCount: episodes.length,
        playerTypes: [
            { id: '1', label: 'Türkçe Altyazılı' },
            { id: '0', label: 'Türkçe Dublaj' },
        ],
    };

    cache.set(cacheKey, result);
    return result;
}

function orderAlternatives(items) {
    const score = item => {
        const name = String(item.baslik || '').toLowerCase();
        if (/filemoon|byse/.test(name)) return 0;
        if (/vidmoly/.test(name)) return 1;
        if (/streamtape/.test(name)) return 2;
        if (/dood|voe|mixdrop/.test(name)) return 3;
        return 10;
    };

    return [...items].sort((a, b) => score(a) - score(b));
}

async function getAlternatives(bid, dil) {
    const key = `alt:${bid}:${dil}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const response = await request(`${BASE}/ajax/dataAlternatif22.asp`, {
        method: 'POST',
        body: new URLSearchParams({ bid: String(bid), dil: String(dil) }).toString(),
        referer: `${BASE}/`,
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        timeoutMs: 20000,
    });

    let data;
    try {
        data = JSON.parse(response.body);
    } catch {
        throw new Error('Sezonluk Dizi alternatif listesi okunamadı.');
    }

    const items = Array.isArray(data?.data) ? data.data : [];
    cache.set(key, items, 10 * 60_000);
    return items;
}

async function getEmbedUrl(alternativeId) {
    const key = `embed:${alternativeId}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const response = await request(`${BASE}/ajax/dataEmbed22.asp`, {
        method: 'POST',
        body: new URLSearchParams({ id: String(alternativeId) }).toString(),
        referer: `${BASE}/`,
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        timeoutMs: 20000,
    });

    const iframe = response.body.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/i);
    const src = iframe ? decodeHtmlEntities(iframe[1]) : null;
    if (!src) throw new Error('Sezonluk Dizi embed adresi alınamadı.');

    if (/reCAPTCHA/i.test(src)) {
        const error = new Error('Bu kaynak CAPTCHA istiyor.');
        error.captcha = true;
        throw error;
    }

    const absolute = absoluteUrl(BASE, src);
    cache.set(key, absolute, 5 * 60_000);
    return absolute;
}

async function play(input = {}) {
    const bid = input.bid ?? input.id;
    const dil = String(input.dil ?? '1');

    if (!bid) throw new Error('Bölüm kimliği eksik.');

    const descriptor = {
        kind: 'sezonlukdizi',
        bid: String(bid),
        dil,
        title: input.title || null,
        label: input.label || input.title || null,
    };

    const alternatives = orderAlternatives(await getAlternatives(bid, dil));
    if (alternatives.length === 0) {
        throw new Error('Bu bölüm için oynatılabilir kaynak bulunamadı.');
    }

    let lastError = null;
    for (const alternative of alternatives.slice(0, 6)) {
        try {
            const embedUrl = await getEmbedUrl(alternative.id);
            return {
                descriptor,
                embedUrl,
                title: input.title || null,
                provider: alternative.baslik || null,
            };
        } catch (error) {
            lastError = error;
            if (!error.captcha) {
                // Ağ hatasıysa diğer alternatifi dene.
                continue;
            }
        }
    }

    if (lastError?.captcha) {
        throw new Error(
            'Sezonluk Dizi\'nin tüm kaynakları CAPTCHA istiyor. JetFilmizle üzerinden deneyin.'
        );
    }

    throw new Error(lastError?.message || 'Sezonluk Dizi kaynağı açılamadı.');
}

export const sezonlukdizi = {
    id: 'sezonlukdizi',
    label: 'Sezonluk Dizi',
    description: 'Diziler (Türkçe altyazılı / dublaj)',
    types: ['series'],
    search,
    details,
    play,
};
