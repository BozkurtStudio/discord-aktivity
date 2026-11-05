/**
 * Discord Aktivite — dış ağ geçidi (relay) Worker
 * ================================================
 *
 * NEDEN: Kaynak siteler (sezonlukdizi.cc, jetfilmizle.app, videopark.top ...)
 * Cloudflare WAF ile veri merkezi IP'lerinden gelen istekleri 403 ile
 * engelliyor. Render'ın çıkış IP'si de bu engellenen grupta. Bu Worker, isteği
 * Cloudflare'in kendi ağından çıkararak engeli aşar.
 *
 * KURULUM (2 dakika):
 *   1. https://dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. İsim ver (ör. "dc-relay") → Deploy
 *   3. "Edit code" → bu dosyanın tamamını yapıştır → Deploy
 *   4. Sana verilen adresi kopyala: https://dc-relay.<alt-alan>.workers.dev
 *   5. Render → Environment → ekle:
 *          OUTBOUND_RELAY = https://dc-relay.<alt-alan>.workers.dev
 *   6. Render'ı yeniden başlat → /api/diag adresini aç, hepsi 200 olmalı.
 *
 * NOT: Worker adresi sunucu tarafında (Render env) tutulur, tarayıcıya
 * gönderilmez; yani adresin kendisi bir nevi sırdır. Adresi bilen biri onu
 * vekil olarak kullanabilir; paylaşma.
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

export default {
    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const requestUrl = new URL(request.url);
        const target = requestUrl.searchParams.get('url');
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
            return json({ error: `kaynağa ulaşılamadı: ${err?.message || err}` }, 502);
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
    },
};

function json(body, status) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' },
    });
}
