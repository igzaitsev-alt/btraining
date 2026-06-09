/**
 * Cloudflare Worker — прокси для Яндекс.Диска
 * VERSION: 3
 */

const YD_PUBLIC_KEY = 'https://disk.yandex.ru/d/WsdOWS-Wscddew';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Disposition',
};

// Fetch file download URL from Yandex Disk public API.
// Instead of encoding the path directly into the URL (where Cloudflare may
// re-normalize percent-encoding), we build the URL with the path as a
// pre-encoded query string to prevent any Unicode normalization by the
// fetch URL parser.
async function ydDownloadHref(filePath) {
  // Manually build the full API URL using encoded path
  const base = 'https://cloud-api.yandex.net/v1/disk/public/resources/download';
  const params = 'public_key=' + encodeURIComponent(YD_PUBLIC_KEY)
               + '&path=' + encodeURIComponent(filePath);
  const apiUrl = base + '?' + params;
  const r = await fetch(new Request(apiUrl, { method: 'GET' }));
  if (r.ok) return (await r.json()).href;
  return null;
}

// List a folder on Yandex Disk and return items array, or null on failure.
async function ydList(folderPath) {
  const base = 'https://cloud-api.yandex.net/v1/disk/public/resources';
  const params = 'public_key=' + encodeURIComponent(YD_PUBLIC_KEY)
               + '&path=' + encodeURIComponent(folderPath)
               + '&limit=200';
  const r = await fetch(base + '?' + params);
  if (!r.ok) return null;
  const data = await r.json();
  return data._embedded?.items || [];
}

// Resolve a path like /FolderA/FolderB/file.mp4 by:
// 1. Listing root, finding FolderA by normalized name match
// 2. Listing FolderA, finding FolderB
// 3. Listing FolderB, finding file.mp4
// 4. Returning the download href for the exact stored path
async function resolveByListing(requestedPath) {
  const parts = requestedPath.replace(/^\//, '').split('/');
  let currentPath = '/';

  for (let i = 0; i < parts.length; i++) {
    const wanted = parts[i].normalize('NFC');
    const items = await ydList(currentPath === '/' ? '/' : currentPath);
    if (!items) return null;

    // Find the item whose normalized name matches
    const found = items.find(item => item.name.normalize('NFC') === wanted);
    if (!found) return null;

    if (i === parts.length - 1) {
      // Last part — get download URL using exact stored path
      // Use the item's `path` which is the absolute Disk path
      // For public shares, we need to use the relative path from share root
      // Reconstruct path using actual stored names
      const exactPath = currentPath === '/'
        ? '/' + found.name
        : currentPath + '/' + found.name;
      return await ydDownloadHref(exactPath);
    }

    currentPath = currentPath === '/'
      ? '/' + found.name
      : currentPath + '/' + found.name;
  }
  return null;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    // Debug endpoint: GET /~debug/<path>
    if (url.pathname.startsWith('/~debug')) {
      const testPath = decodeURIComponent(url.pathname.slice(7) || '/test');
      const results = [];

      // Test direct API calls with each normalization
      for (const norm of ['NFD', 'NFC', null]) {
        const filePath = norm ? testPath.normalize(norm) : testPath;
        const base = 'https://cloud-api.yandex.net/v1/disk/public/resources/download';
        const apiUrl = base + '?public_key=' + encodeURIComponent(YD_PUBLIC_KEY) + '&path=' + encodeURIComponent(filePath);
        const r = await fetch(apiUrl);
        results.push({ norm: norm || 'raw', status: r.status, ok: r.ok, sentPath: encodeURIComponent(filePath).substring(0, 80) });
        if (r.ok) break;
      }

      // Also test the listing-based approach
      const hrefByList = await resolveByListing(testPath);

      return new Response(JSON.stringify({ version: 3, testPath, results, hrefByList: hrefByList ? '✓ found' : '✗ not found' }, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const rawPath = decodeURIComponent(url.pathname);

    // First try direct path lookups (NFD → NFC → raw)
    let href = null;
    const debugStatuses = [];
    for (const norm of ['NFD', 'NFC', null]) {
      const filePath = norm ? rawPath.normalize(norm) : rawPath;
      const apiUrl = 'https://cloud-api.yandex.net/v1/disk/public/resources/download'
        + '?public_key=' + encodeURIComponent(YD_PUBLIC_KEY)
        + '&path=' + encodeURIComponent(filePath);
      const apiResp = await fetch(apiUrl);
      debugStatuses.push((norm || 'raw') + ':' + apiResp.status);
      if (apiResp.ok) { href = (await apiResp.json()).href; break; }
    }

    // Fallback: resolve by listing folders (handles mixed NFD/NFC paths)
    if (!href) {
      href = await resolveByListing(rawPath);
      if (href) debugStatuses.push('listing:200');
    }

    if (!href) {
      return new Response('File not found (v3): ' + rawPath + ' | tried: ' + debugStatuses.join(', '), {
        status: 404, headers: CORS,
      });
    }

    const proxyReq = { headers: {} };
    const range = request.headers.get('Range');
    if (range) proxyReq.headers['Range'] = range;

    const ydResp = await fetch(href, proxyReq);

    const headers = { ...CORS };
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range',
                     'Accept-Ranges', 'Content-Disposition']) {
      const v = ydResp.headers.get(h);
      if (v) headers[h] = v;
    }

    return new Response(ydResp.body, { status: ydResp.status, headers });
  },
};
