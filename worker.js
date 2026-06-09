/**
 * Cloudflare Worker — прокси для Яндекс.Диска
 *
 * Деплой:
 *  1. Зайди на https://workers.cloudflare.com (бесплатный аккаунт)
 *  2. Create application → Create Worker
 *  3. Замени весь код на этот файл → Deploy
 *  4. Скопируй URL воркера (вида https://yd-proxy.ИМЯ.workers.dev)
 *  5. Вставь его в index.html в константу WORKER_URL
 */

const YD_PUBLIC_KEY = 'https://disk.yandex.ru/d/WsdOWS-Wscddew';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Disposition',
};

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // Путь к файлу, например /Блок 1 - .../Урок 1 - .../video.mp4
    const rawPath = decodeURIComponent(new URL(request.url).pathname);

    // Яндекс.Диск хранит имена в той кодировке, в которой они загружены.
    // macOS загружает в NFD, веб-интерфейс Диска создаёт в NFC.
    // Пробуем NFD → NFC → исходный вариант, берём первый успешный.
    let href = null;
    for (const norm of ['NFD', 'NFC', null]) {
      const filePath = norm ? rawPath.normalize(norm) : rawPath;
      const apiUrl = 'https://cloud-api.yandex.net/v1/disk/public/resources/download'
        + '?public_key=' + encodeURIComponent(YD_PUBLIC_KEY)
        + '&path=' + encodeURIComponent(filePath);
      const apiResp = await fetch(apiUrl);
      if (apiResp.ok) { href = (await apiResp.json()).href; break; }
    }

    if (!href) {
      return new Response('File not found: ' + rawPath, {
        status: 404, headers: CORS,
      });
    }

    // Проксируем запрос к Яндекс CDN, пробрасывая Range (нужен для перемотки видео)
    const proxyReq = { headers: {} };
    const range = request.headers.get('Range');
    if (range) proxyReq.headers['Range'] = range;

    const ydResp = await fetch(href, proxyReq);

    // Копируем нужные заголовки из ответа Яндекса
    const headers = { ...CORS };
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range',
                     'Accept-Ranges', 'Content-Disposition']) {
      const v = ydResp.headers.get(h);
      if (v) headers[h] = v;
    }

    return new Response(ydResp.body, { status: ydResp.status, headers });
  },
};
