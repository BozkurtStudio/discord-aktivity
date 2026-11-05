// Kaynak adaptörlerinin ortak HTML/metin yardımcıları.

const NAMED_ENTITIES = new Map([
    ['amp', '&'],
    ['quot', '"'],
    ['apos', "'"],
    ['lt', '<'],
    ['gt', '>'],
    ['nbsp', ' '],
    ['ndash', '–'],
    ['mdash', '—'],
    ['hellip', '…'],
    ['rsquo', '’'],
    ['lsquo', '‘'],
    ['ldquo', '“'],
    ['rdquo', '”'],
    ['ccedil', 'ç'],
    ['Ccedil', 'Ç'],
    ['gbreve', 'ğ'],
    ['Gbreve', 'Ğ'],
    ['dotlessi', 'ı'],
    ['I', 'I'],
    ['ouml', 'ö'],
    ['Ouml', 'Ö'],
    ['scedil', 'ş'],
    ['Scedil', 'Ş'],
    ['uuml', 'ü'],
    ['Uuml', 'Ü'],
]);

export function decodeHtmlEntities(value) {
    if (!value) return '';
    return String(value)
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            try {
                return String.fromCodePoint(parseInt(hex, 16));
            } catch {
                return '';
            }
        })
        .replace(/&#(\d+);/g, (_, dec) => {
            try {
                return String.fromCodePoint(parseInt(dec, 10));
            } catch {
                return '';
            }
        })
        .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => {
            return NAMED_ENTITIES.get(name) ?? match;
        });
}

export function stripTags(value) {
    return decodeHtmlEntities(
        String(value || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
    )
        .replace(/\s+/g, ' ')
        .trim();
}

export function absoluteUrl(base, href) {
    if (!href) return null;
    const raw = decodeHtmlEntities(String(href)).trim();
    if (!raw) return null;
    try {
        return new URL(raw, base).href;
    } catch {
        return null;
    }
}

export function extractMeta(html, key) {
    if (!html) return null;

    const patterns = [
        new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, 'i'),
    ];

    for (const re of patterns) {
        const match = re.exec(html);
        if (match) return decodeHtmlEntities(match[1]).trim();
    }
    return null;
}

export function parseAttributes(tag) {
    const attrs = {};
    const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let match;
    while ((match = re.exec(tag))) {
        attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
    }
    return attrs;
}

/**
 * Metin içinde `startIndex`te bulunan `{` ile başlayan dengeli JSON
 * nesnesini çıkarır. String içindeki süslü parantezleri saymaz.
 */
export function extractBalancedObject(text, startIndex) {
    if (!text || startIndex < 0 || text[startIndex] !== '{') return null;

    let depth = 0;
    let quote = null;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
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

        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(startIndex, i + 1);
        }
    }

    return null;
}

export function toInt(value, fallback = null) {
    const parsed = parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

export function slugFromUrl(url) {
    if (!url) return null;
    try {
        const path = new URL(url).pathname;
        const last = path.split('/').filter(Boolean).pop() || '';
        return last.replace(/\.html?$/i, '');
    } catch {
        return null;
    }
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Basit TTL önbelleği (adaptörler için)
export function createCache(defaultTtlMs = 60_000) {
    const store = new Map();

    return {
        get(key) {
            const hit = store.get(key);
            if (!hit) return null;
            if (hit.expires <= Date.now()) {
                store.delete(key);
                return null;
            }
            return hit.value;
        },
        set(key, value, ttlMs = defaultTtlMs) {
            if (store.size > 200) {
                let i = 0;
                for (const k of store.keys()) {
                    if (i++ >= 40) break;
                    store.delete(k);
                }
            }
            store.set(key, { value, expires: Date.now() + ttlMs });
        },
        delete(key) {
            store.delete(key);
        },
        clear() {
            store.clear();
        },
    };
}
