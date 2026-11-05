import { request } from '../net.js';
import {
    absoluteUrl,
    createCache,
    decodeHtmlEntities,
    extractMeta,
    normalizeWhitespace,
    parseAttributes,
    stripTags,
    toInt,
} from './util.js';

const BASE = 'https://jetfilmizle.app';
const cache = createCache(5 * 60_000);

function mapSearchItem(item) {
    const url = absoluteUrl(BASE, item.url);
    const isSeries = item.type === 'dizi' || /\/dizi\//i.test(url || '');
    return {
        source: 'jetfilmizle',
        sourceLabel: 'JetFilmizle',
        id: item.id ?? null,
        slug: url ? new URL(url).pathname.split('/').filter(Boolean).pop() : null,
        title: normalizeWhitespace(item.title || ''),
        originalTitle: normalizeWhitespace(item.original_title || '') || null,
        year: item.year || null,
        poster: item.poster || null,
        rating: item.rating || null,
        description: normalizeWhitespace(item.description || ''),
        type: isSeries ? 'series' : 'movie',
        url,
    };
}

async function search(query) {
    const response = await request(`${BASE}/arama-json?q=${encodeURIComponent(query)}`, {
        referer: `${BASE}/`,
        headers: { Accept: 'application/json' },
        timeoutMs: 20000,
    });

    let data;
    try {
        data = JSON.parse(response.body);
    } catch {
        throw new Error('JetFilmizle arama yanıtı okunamadı.');
    }

    const results = Array.isArray(data?.results) ? data.results.map(mapSearchItem) : [];
    return { results, note: null };
}

function buttonList(html) {
    const buttons = [];
    const re = /<button([^>]*)>([\s\S]*?)<\/button>/gi;
    let match;
    while ((match = re.exec(html))) {
        const attrs = parseAttributes(match[1]);
        buttons.push({
            attrs,
            classes: String(attrs.class || '').split(/\s+/),
            text: normalizeWhitespace(stripTags(match[2])),
        });
    }
    return buttons;
}

function detailsFromHtml(html, pageUrl) {
    const filmId = html.match(/name=["']film_id["'][^>]*value=["']([^"']+)/i)?.[1]
        || html.match(/value=["']([^"']+)["'][^>]*name=["']film_id/i)?.[1]
        || null;

    const dataAttr = name => {
        const match = html.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
        return match ? decodeHtmlEntities(match[1]).trim() : null;
    };

    const titleFromMeta = extractMeta(html, 'og:title');
    const title = dataAttr('data-film-title')
        || (titleFromMeta ? titleFromMeta.replace(/\s*\(\d{4}\)\s*$/, '').trim() : null)
        || stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
            .replace(/\s*\([^)]*\)\s*$/, '')
            .trim();

    const year = dataAttr('data-film-year')
        || (titleFromMeta?.match(/\((\d{4})\)/)?.[1] ?? null);
    const rating = dataAttr('data-film-rating') || null;
    const poster = dataAttr('data-film-cover') || extractMeta(html, 'og:image');
    const description = extractMeta(html, 'og:description');
    const isSeries = /\/dizi\//i.test(pageUrl);

    const buttons = buttonList(html);

    const playerTypes = [];
    const seenTypes = new Set();
    for (const button of buttons) {
        if (!button.classes.includes('player-type-btn')) continue;
        const id = button.attrs['data-player-type'];
        if (!id || seenTypes.has(id)) continue;
        seenTypes.add(id);
        playerTypes.push({ id, label: button.text || id });
    }

    const sources = [];
    for (const button of buttons) {
        if (!button.classes.includes('player-source-btn')) continue;
        if (button.classes.includes('episode-btn')) continue;
        const playerType = button.attrs['data-player-type'];
        const index = toInt(button.attrs['data-source-index']);
        if (!playerType || index === null) continue;
        sources.push({
            playerType,
            index,
            label: button.text || `Kaynak ${index + 1}`,
        });
    }

    const seasonMap = new Map();
    const episodes = [];

    for (const button of buttons) {
        if (!button.classes.includes('episode-btn')) continue;
        const playerType = button.attrs['data-player-type'];
        const season = toInt(button.attrs['data-season']);
        const episode = toInt(button.attrs['data-episode']);
        const sourceIndex = toInt(button.attrs['data-source-index']);
        if (!playerType || season === null || episode === null || sourceIndex === null) continue;

        const key = `${playerType}:${season}`;
        if (!seasonMap.has(key)) {
            seasonMap.set(key, {
                playerType,
                season,
                label: `${season}. Sezon`,
                episodes: [],
            });
        }

        const item = {
            episode,
            season,
            sourceIndex,
            label: button.text || `E${episode}`,
        };

        seasonMap.get(key).episodes.push(item);
        episodes.push({ ...item, playerType });
    }

    const seasons = [...seasonMap.values()].sort((a, b) => {
        if (a.playerType !== b.playerType) return a.playerType.localeCompare(b.playerType);
        return a.season - b.season;
    });

    for (const season of seasons) {
        season.episodes.sort((a, b) => a.episode - b.episode);
    }

    return {
        source: 'jetfilmizle',
        sourceLabel: 'JetFilmizle',
        id: filmId,
        slug: new URL(pageUrl).pathname.split('/').filter(Boolean).pop(),
        title: title || 'JetFilmizle içeriği',
        year,
        rating,
        poster,
        description,
        type: isSeries ? 'series' : 'movie',
        url: pageUrl,
        playerTypes,
        sources,
        seasons,
        episodes,
    };
}

async function details(input = {}) {
    let pageUrl = input.url || null;
    if (!pageUrl && input.slug) {
        pageUrl = `${BASE}/${input.type === 'series' ? 'dizi' : 'film'}/${input.slug}`;
    }
    if (!pageUrl && input.id) {
        throw new Error('İçerik adresi belirtilmedi.');
    }
    if (!pageUrl) throw new Error('İçerik adresi belirtilmedi.');

    let parsedPage;
    try {
        parsedPage = new URL(pageUrl);
    } catch {
        throw new Error('Geçersiz içerik adresi.');
    }
    if (!/(^|\.)jetfilmizle\.app$/i.test(parsedPage.hostname)) {
        throw new Error('Bu adres JetFilmizle kaynağına ait değil.');
    }

    const key = `details:${pageUrl}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const page = await request(pageUrl, {
        referer: `${BASE}/`,
        cacheTtlMs: 5 * 60_000,
        timeoutMs: 30000,
    });

    const result = detailsFromHtml(page.body, page.finalUrl);
    cache.set(key, result);
    return result;
}

function sourceIndexCandidates(detailsData, descriptor) {
    const playerType = descriptor.playerType;
    const season = toInt(descriptor.season);
    const episode = toInt(descriptor.episode);

    if (season !== null && episode !== null) {
        const seen = new Set();
        const ordered = [];
        for (const item of detailsData.episodes || []) {
            if (item.playerType !== playerType) continue;
            if (item.season !== season || item.episode !== episode) continue;
            if (seen.has(item.sourceIndex)) continue;
            seen.add(item.sourceIndex);
            ordered.push(item.sourceIndex);
        }
        return ordered;
    }

    return (detailsData.sources || [])
        .filter(item => item.playerType === playerType)
        .map(item => item.index);
}

// Seçilen kaynak doğrudan akış vermiyorsa aynı dildeki diğer kaynakları dener.
async function expand(descriptor) {
    if (!descriptor?.url) return [descriptor];

    let detailsData;
    try {
        detailsData = await details({ url: descriptor.url });
    } catch {
        return [descriptor];
    }

    const selected = toInt(descriptor.sourceIndex, 0);
    const candidates = sourceIndexCandidates(detailsData, descriptor);
    const ordered = [selected, ...candidates.filter(index => index !== selected)];

    return ordered.slice(0, 5).map(sourceIndex => ({ ...descriptor, sourceIndex }));
}

async function play(input = {}) {
    const filmId = input.filmId ?? input.id;
    const playerType = input.playerType || 'dublaj';
    const sourceIndex = toInt(input.sourceIndex ?? input.index, 0);

    if (!filmId) throw new Error('İçerik kimliği eksik.');

    const descriptor = {
        kind: 'jetfilmizle',
        filmId: String(filmId),
        playerType,
        sourceIndex,
        season: input.season ?? null,
        episode: input.episode ?? null,
        title: input.title || null,
        label: input.label || input.title || null,
    };

    const body = new URLSearchParams({
        film_id: String(filmId),
        source_index: String(sourceIndex),
        player_type: playerType,
    }).toString();

    const response = await request(`${BASE}/jetplayer`, {
        method: 'POST',
        body,
        referer: input.url || `${BASE}/`,
        headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        timeoutMs: 20000,
    });

    const iframe = response.body.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/i);
    if (!iframe) {
        throw new Error('JetFilmizle oynatıcı adresi alınamadı.');
    }

    return {
        descriptor,
        embedUrl: absoluteUrl(BASE, iframe[1]),
        title: input.title || null,
    };
}

export const jetfilmizle = {
    id: 'jetfilmizle',
    label: 'JetFilmizle',
    description: 'Filmler ve diziler (dublaj / altyazılı)',
    types: ['movie', 'series'],
    search,
    details,
    play,
    expand,
};
