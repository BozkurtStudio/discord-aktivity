/**
 * Discord Aktivite — dış ağ geçidi (relay) Worker
 * ================================================
 *
 * NEDEN: Kaynak siteler (sezonlukdizi.cc, jetfilmizle.app, videopark.top ...)
 * Cloudflare WAF ile veri merkezi IP'lerinden gelen istekleri engelliyor.
 * Render'ın çıkış IP'si de engellenen grupta. Bu Worker, isteği Cloudflare'in
 * kendi ağından çıkararak engeli aşar.
 *
 * NEDEN DURABLE OBJECT: sezonlukdizi gibi bazı siteler ABD çıkışını da
 * engelliyor. Worker normalde çağıranın bulunduğu bölgede çalışır (Render
 * ABD'de olduğu için PDX). `locationHint: 'weur'` ile sabitlenen bir Durable
 * Object ise HER ZAMAN Batı Avrupa'da çalışır; istek oradan çıkar ve engel
 * aşılır.
 *
 * KURULUM (dashboard'a girmeden):
 *   npx wrangler login
 *   npx wrangler deploy -c cloudflare/wrangler.toml
 * Sonra Render → Environment → OUTBOUND_RELAY = <deploy adresi>
 *
 * PROTOKOL:
 *   POST  {worker}/?url=<hedef-url>
 *   Başlıklar: x-relay-method (asıl HTTP metodu), x-relay-referer (opsiyonel),
 *              ve hedefe iletilecek diğer başlıklar (User-Agent, Cookie ...).
 *   Gövde: asıl isteğin gövdesi (POST form vb.).
 *   Yanıt: hedefin durum kodu + başlıkları + gövdesi. Çerezler, tarayıcı
 *          Set-Cookie'yi okuyamadığı için x-relay-set-cookie başlığına
 *          satır satır yazılır.
 */

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
};

// Worker'a gelen başlıklardan hedefe iletilmeyecek olanlar.
const SKIP_REQUEST_HEADERS = new Set([
    'host',
    'connection',
    'content-length',
    'accept-encoding',
    'x-relay-method',
    'x-relay-referer',
    'origin',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-real-ip',
    'cdn-loop',
]);

// Hedef yanıtından istemciye aktarılmayacak başlıklar.
const SKIP_RESPONSE_HEADERS = new Set([
    'content-encoding',
    'content-length',
    'transfer-encoding',
    'connection',
    'set-cookie',
    'cf-cache-status',
    'cf-ray',
]);

// Asıl işi yapan bölge-sabitli Durable Object (Batı Avrupa).
export class RelayRegion {
    async fetch(request) {
        return relay(request);
    }
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const target = new URL(request.url).searchParams.get('url');
        if (!target) return json({ error: 'url parametresi gerekli' }, 400);

        // Durable Object varsa oradan geçir; yoksa doğrudan işle.
        if (env && env.RELAY_REGION) {
            try {
                const id = env.RELAY_REGION.idFromName('europe');
                const stub = env.RELAY_REGION.get(id, { locationHint: 'weur' });
                return await stub.fetch(request);
            } catch (err) {
                // DO erişilemezse doğrudan (çağıranın bölgesinden) dene.
                return relay(request, err);
            }
        }

        return relay(request);
    },
};

async function relay(request, doError) {
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return json({ error: 'url parametresi gerekli' }, 400);

    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch {
        return json({ error: 'geçersiz url' }, 400);
    }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        return json({ error: 'yalnızca http/https desteklenir' }, 400);
    }

    const method = (request.headers.get('x-relay-method') || 'GET').toUpperCase();

    const headers = new Headers();
    for (const [key, value] of request.headers) {
        const lower = key.toLowerCase();
        if (SKIP_REQUEST_HEADERS.has(lower) || lower.startsWith('cf-')) continue;
        headers.set(key, value);
    }
    const referer = request.headers.get('x-relay-referer');
    if (referer) headers.set('referer', referer);
    // Sıkıştırmayı istemiyoruz; gövdeyi olduğu gibi aktarıyoruz.
    headers.set('accept-encoding', 'identity');

    let response;
    try {
        response = await fetch(targetUrl.toString(), {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : await request.text(),
            redirect: 'manual',
        });
    } catch (err) {
        const detail = `${err?.message || err}${doError ? ` (DO: ${doError.message || doError})` : ''}`;
        return json({ error: `kaynağa ulaşılamadı: ${detail}` }, 502);
    }

    const outHeaders = new Headers(CORS_HEADERS);
    for (const [key, value] of response.headers) {
        if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
        outHeaders.set(key, value);
    }

    const setCookies =
        typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (setCookies.length) outHeaders.set('x-relay-set-cookie', setCookies.join('\n'));

    return new Response(response.body, { status: response.status, headers: outHeaders });
}

function json(body, status) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' },
    });
}
