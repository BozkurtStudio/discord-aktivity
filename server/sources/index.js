import { resolveVideoUrl } from '../resolve.js';
import { createCache } from './util.js';
import { sezonlukdizi } from './sezonlukdizi.js';
import { jetfilmizle } from './jetfilmizle.js';

const adapters = [sezonlukdizi, jetfilmizle];
const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));
const resolvedCache = createCache(4 * 60_000);

export function listSources() {
    return adapters.map(adapter => ({
        id: adapter.id,
        label: adapter.label,
        description: adapter.description,
        types: adapter.types,
    }));
}

export function getSource(id) {
    const adapter = byId.get(String(id || ''));
    if (!adapter) {
        const error = new Error(`Bilinmeyen kaynak: ${id}`);
        error.statusCode = 400;
        throw error;
    }
    return adapter;
}

function descriptorKey(descriptor) {
    const { title, label, ...rest } = descriptor || {};
    const keys = Object.keys(rest).sort();
    return keys.map(key => `${key}=${String(rest[key])}`).join('&');
}

/**
 * Bir seçimi (kaynak + bölüm/film) taze bir oynatma adresine çevirir.
 * Byse/Videopark imzalı adresleri süreli olduğu için sonuç kısa süre cache'lenir.
 */
export async function resolveDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== 'object' || !descriptor.kind) {
        const error = new Error('Oynatma tanımı eksik.');
        error.statusCode = 400;
        throw error;
    }

    const key = descriptorKey(descriptor);
    const cached = resolvedCache.get(key);
    if (cached) return cached;

    const adapter = getSource(descriptor.kind);
    const candidates = typeof adapter.expand === 'function'
        ? await adapter.expand(descriptor)
        : [descriptor];

    let lastError = null;

    for (const candidate of candidates.length > 0 ? candidates : [descriptor]) {
        try {
            const selection = await adapter.play(candidate);
            const resolved = await resolveVideoUrl(selection.embedUrl);

            const result = {
                ...resolved,
                descriptor: candidate,
                sourceLabel: adapter.label,
                provider: selection.provider || resolved.source || adapter.label,
                title: descriptor.title || selection.title || resolved.title || null,
            };

            resolvedCache.set(key, result);
            return result;
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Video oynatma adresi alınamadı.');
}

export function invalidateDescriptor(descriptor) {
    if (!descriptor) return;
    resolvedCache.delete(descriptorKey(descriptor));
}
