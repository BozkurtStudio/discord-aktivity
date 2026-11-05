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
 * Object ise HER ZAMAN Batı Avrupa'da çalışır; istek oradan çıkar.
 *
 * TEŞHİS:  {worker}/?diag=1
 *   Yürütmenin yapıldığı yeri (via) ve gerçek çıkış bölgesini (colo) döner.
 *
 * KURULUM (dashboard'a girmeden):
 *   npx wrangler login
 *   npx wrangler deploy -c cloudflare/wrangler.toml
 * Sonra Render → Environment → OUTBOUND_RELAY = <deploy adresi>
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

// İsteği sabit olarak Batı Avrupa'dan çıkaran Durable Object.
export class RelayRegion {
    async fetch(request) {
        const url = new URL(request.url);
        if (url.searchParams.get('diag') === '1') return diag(request, 'do');
        return relay(request, 'do');
    }
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const isDiag = url.searchParams.get('diag') === '1';
        if (!isDiag && !url.searchParams.get('url')) {
            return json({ error: 'url parametresi gerekli' }, 400);
        }

        const stub = env && env.RELAY_REGION ? getStub(env) : null;
        if (stub) {
            try {
                return await stub.fetch(request);
            } catch (err) {
                const note = `do-error: ${err?.message || err}`;
                return isDiag ? diag(request, note) : relay(request, note);
            }
        }
        return isDiag ? diag(request, 'no-do') : relay(request, 'no-do');
    },
};

function getStub(env) {
    const id = env.RELAY_REGION.idFromName('europe');
    return env.RELAY_REGION.get(id, { locationHint: 'weur' });
}

async function relay(request, via) {
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
        return json({ error: `kaynağa ulaşılamadı: ${err?.message || err}` }, 502);
    }

    const outHeaders = new Headers(CORS_HEADERS);
    for (const [key, value] of response.headers) {
        if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
        outHeaders.set(key, value);
    }
    outHeaders.set('x-relay-via', via);

    const setCookies =
        typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (setCookies.length) outHeaders.set('x-relay-set-cookie', setCookies.join('\n'));

    return new Response(response.body, { status: response.status, headers: outHeaders });
}

async function diag(request, via) {
    let colo = null;
    let ip = null;
    try {
        const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
        const text = await res.text();
        colo = /^colo=(.+)$/m.exec(text)?.[1] || null;
        ip = /^ip=(.+)$/m.exec(text)?.[1] || null;
    } catch (err) {
        colo = `hata: ${err?.message || err}`;
    }
    return json(
        {
            via,
            egressColo: colo,
            egressIp: ip,
            incomingColo: request.cf?.colo || null,
            incomingCountry: request.cf?.country || null,
        },
        200,
    );
}

function json(body, status) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' },
    });
}
