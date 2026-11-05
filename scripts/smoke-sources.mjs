#!/usr/bin/env node
// Kaynak adaptörleri için uçtan uca duman testi.
// Kullanım: sunucu açıkken `node scripts/smoke-sources.mjs`
// Sunucu adresi: SMOKE_BASE (varsayılan http://localhost:3000)

const BASE = (process.env.SMOKE_BASE || 'http://localhost:3000').replace(/\/$/, '');

let failures = 0;

function ok(label, detail = '') {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, error) {
    failures++;
    console.error(`  ✗ ${label} — ${error?.message || error}`);
}

async function getJson(path) {
    const response = await fetch(`${BASE}${path}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

async function postJson(path, body) {
    const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

console.log(`\nKaynak testleri: ${BASE}\n`);

try {
    const { sources } = await getJson('/api/sources');
    if (!Array.isArray(sources) || sources.length === 0) throw new Error('Kaynak listesi boş.');
    ok('Kaynak listesi', sources.map(source => source.id).join(', '));

    const szdSearch = await getJson(`/api/search?source=sezonlukdizi&q=${encodeURIComponent('breaking bad')}`);
    const szdResult = szdSearch.results?.[0];
    if (!szdResult) throw new Error('Sezonluk Dizi sonucu bulunamadı.');
    ok('Sezonluk Dizi araması', szdResult.title);

    const szdDetails = await getJson(
        `/api/details?source=sezonlukdizi&url=${encodeURIComponent(szdResult.url)}`
    );
    const szdEpisode = szdDetails.seasons?.[0]?.episodes?.[0];
    if (!szdEpisode) throw new Error('Sezonluk Dizi bölüm listesi boş.');
    ok('Sezonluk Dizi bölümleri', `${szdDetails.episodeCount} bölüm`);

    const szdPlay = await postJson('/api/play', {
        descriptor: {
            kind: 'sezonlukdizi',
            bid: szdEpisode.id,
            dil: '1',
            title: `${szdDetails.title} S${szdEpisode.season}E${szdEpisode.episode}`,
        },
    });
    if (!szdPlay.url) throw new Error('Sezonluk Dizi oynatma adresi boş.');
    ok('Sezonluk Dizi oynatma', szdPlay.source);

    const jetSearch = await getJson(`/api/search?source=jetfilmizle&q=${encodeURIComponent('dark knight')}`);
    const jetResult = jetSearch.results?.find(result => result.type === 'movie');
    if (!jetResult) throw new Error('JetFilmizle film sonucu bulunamadı.');
    ok('JetFilmizle araması', jetResult.title);

    const jetDetails = await getJson(
        `/api/details?source=jetfilmizle&url=${encodeURIComponent(jetResult.url)}`
    );
    const jetSource = jetDetails.sources?.[0];
    if (!jetSource) throw new Error('JetFilmizle kaynak listesi boş.');
    ok('JetFilmizle film kaynakları', `${jetDetails.sources.length} kaynak`);

    const jetPlay = await postJson('/api/play', {
        descriptor: {
            kind: 'jetfilmizle',
            filmId: jetDetails.id,
            playerType: jetSource.playerType,
            sourceIndex: jetSource.index,
            title: jetDetails.title,
        },
    });
    if (!jetPlay.url) throw new Error('JetFilmizle oynatma adresi boş.');
    ok('JetFilmizle oynatma', jetPlay.source);
} catch (error) {
    fail('Test akışı', error);
}

if (failures > 0) {
    console.error(`\n${failures} test başarısız.\n`);
    process.exit(1);
}

console.log('\nTüm testler geçti.\n');
