// Bookmark favicons, fetched from the bookmarked site itself.
//
// Deliberately NOT routed through Google's /s2/favicons or DuckDuckGo's ip3:
// Scout is an anti-detect product, and handing a third party the list of
// domains its users bookmark (from the users' own IPs) is exactly the kind of
// leak the product exists to prevent. The cost is that some sites have no
// discoverable icon -- those fall back to the letter monogram in the renderer.
//
// Everything is cached on disk under userData/Favicons so a host is fetched
// once, not once per launch. Misses are cached too, with a shorter TTL, so a
// site that has no icon today can still pick one up later.

const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
// Backstop for the document fetch only. Big sites inline enough script to blow
// well past the image cap -- Instagram's homepage alone is over half a megabyte
// -- and aborting there used to lose the icon entirely. In practice the read
// stops at </head> long before this.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;

// A browser-shaped UA. Several CDNs 403 an unrecognised agent outright, which
// would turn every icon into a monogram.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// --- SSRF guard -------------------------------------------------------------
//
// Bookmark urls are NOT trusted input. shared_bookmarks is an org-scoped table,
// so any member can add a row that every other member's main process will then
// fetch. Without this guard a bookmark pointed at http://127.0.0.1:39219 would
// make each launcher issue requests against its own local API server, and
// RFC1918 targets would turn the fleet into an internal network scanner.
//
// So: resolve the host up front, refuse anything that lands on a private or
// otherwise reserved address, and then pin the connection to the address we
// vetted -- re-resolving inside the socket would reopen the hole via DNS
// rebinding. Redirects re-enter fetchOnce and are re-validated the same way.

const ALLOWED_PORTS = new Set(['', '80', '443']);

function ipv4Blocked(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||                              // 0.0.0.0/8 "this network"
    a === 10 ||                             // RFC1918
    a === 127 ||                            // loopback
    (a === 100 && b >= 64 && b <= 127) ||   // CGNAT 100.64/10
    (a === 169 && b === 254) ||             // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||    // RFC1918
    (a === 192 && b === 0) ||               // IETF protocol assignments
    (a === 192 && b === 168) ||             // RFC1918
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224                                // multicast, reserved, broadcast
  );
}

function ipv6Blocked(ip) {
  const value = ip.toLowerCase().split('%')[0];
  // ::ffff:127.0.0.1 and friends must be judged on the embedded v4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) {
    return ipv4Blocked(mapped[1]);
  }
  if (value === '::' || value === '::1') {
    return true;
  }
  return (
    /^f[cd][0-9a-f]{2}:/.test(value) ||     // unique local fc00::/7
    /^fe[89ab][0-9a-f]:/.test(value) ||     // link-local fe80::/10
    /^ff[0-9a-f]{2}:/.test(value)           // multicast
  );
}

function addressBlocked(ip) {
  return ip.includes(':') ? ipv6Blocked(ip) : ipv4Blocked(ip);
}

/**
 * Resolve a hostname and return the single address we are willing to talk to,
 * or null when the host is not safe to reach. Every resolved address has to
 * pass -- a host that returns one public and one loopback record is rejected
 * outright rather than gambling on ordering.
 */
async function resolveSafeAddress(hostname) {
  let records;
  try {
    records = await dns.promises.lookup(hostname, {all: true, verbatim: true});
  } catch {
    return null;
  }
  if (!records || !records.length) {
    return null;
  }
  if (records.some((record) => addressBlocked(record.address))) {
    return null;
  }
  return records[0];
}

/** Sniff the real type; plenty of servers label .ico files as text/plain. */
function sniffMime(buffer, contentType) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return 'image/x-icon';
  }
  const head = buffer.subarray(0, 400).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  if (contentType && contentType.startsWith('image/')) return contentType.split(';')[0].trim();
  return null;
}

async function fetchOnce(targetUrl, redirectsLeft, options = {}) {
  const maxBytes = options.maxBytes || MAX_BYTES;
  const stopAtHead = Boolean(options.stopAtHead);

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  // Non-standard ports are where the interesting internal services live, and no
  // real favicon needs one.
  if (!ALLOWED_PORTS.has(parsed.port)) {
    return null;
  }
  const pinned = await resolveSafeAddress(parsed.hostname);
  if (!pinned) {
    return null;
  }

  return new Promise((resolve) => {
    const client = parsed.protocol === 'https:' ? https : http;
    // Note the .toString(): handing http.get a URL *instance* together with an
    // options object merges the two by assigning onto the URL, which has no
    // `path` property, so every request silently lost its path and resolved
    // null. Passing the href string takes Node's documented parse path instead.
    const request = client.get(
      parsed.toString(),
      {
        headers: {'User-Agent': USER_AGENT, Accept: '*/*'},
        timeout: REQUEST_TIMEOUT_MS,
        // Connect to the address we already vetted instead of resolving again
        // at socket time, which a rebinding DNS server could answer differently
        // the second time. TLS still verifies against parsed.hostname.
        lookup: (hostname, lookupOptions, callback) => {
          if (lookupOptions && lookupOptions.all) {
            callback(null, [{address: pinned.address, family: pinned.family}]);
            return;
          }
          callback(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          response.resume();
          // Re-entering fetchOnce re-runs the protocol/port/address checks, so a
          // public host cannot bounce us onto an internal one via a 302.
          let next;
          try {
            next = new URL(location, parsed).toString();
          } catch {
            resolve(null);
            return;
          }
          resolve(fetchOnce(next, redirectsLeft - 1, options));
          return;
        }
        if (status !== 200) {
          response.resume();
          resolve(null);
          return;
        }

        const chunks = [];
        let total = 0;
        let settled = false;
        // Rolling overlap so a `</head>` split across two chunks is still seen.
        let tail = '';

        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            body: Buffer.concat(chunks),
            contentType: String(response.headers['content-type'] || '').toLowerCase(),
            finalUrl: parsed.toString(),
          });
        };
        const abandon = () => {
          if (settled) return;
          settled = true;
          resolve(null);
        };

        response.on('data', (chunk) => {
          total += chunk.length;
          chunks.push(chunk);
          // Icon links live in <head>, so there is no reason to download the
          // megabytes of inlined script that follow it.
          if (stopAtHead) {
            const text = tail + chunk.toString('latin1');
            if (text.includes('</head>')) {
              request.destroy();
              finish();
              return;
            }
            tail = text.slice(-8);
          }
          if (total > maxBytes) {
            request.destroy();
            abandon();
          }
        });
        response.on('end', finish);
        response.on('error', abandon);
      },
    );

    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function fetchImage(targetUrl) {
  const result = await fetchOnce(targetUrl, MAX_REDIRECTS);
  if (!result || !result.body.length) return null;
  const mime = sniffMime(result.body, result.contentType);
  if (!mime) return null;
  return {mime, body: result.body};
}

/** Pull icon hrefs out of <head>, best (largest / most specific) first. */
function parseIconHrefs(html, baseUrl) {
  const hrefs = [];
  const linkTag = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkTag.exec(html)) !== null) {
    const tag = match[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag);
    if (!rel) continue;
    const relValue = rel[1].toLowerCase();
    if (!/\b(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)\b/.test(relValue)) {
      continue;
    }
    const href = /\bhref\s*=\s*["']([^"']+)/i.exec(tag);
    if (!href) continue;
    const sizes = /\bsizes\s*=\s*["']?(\d+)/i.exec(tag);
    try {
      hrefs.push({
        url: new URL(href[1], baseUrl).toString(),
        // Prefer a declared size; apple-touch-icons are reliably high-res.
        weight: sizes ? Number(sizes[1]) : relValue.includes('apple-touch') ? 180 : 32,
      });
    } catch {
      // Unresolvable href; skip it.
    }
  }
  return hrefs.sort((a, b) => b.weight - a.weight).map((entry) => entry.url);
}

function cacheKey(host) {
  return host.replace(/[^a-z0-9.-]/gi, '_');
}

function readCache(cacheDir, host) {
  const file = path.join(cacheDir, `${cacheKey(host)}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - (raw.fetchedAt || 0);
    const ttl = raw.dataUri ? HIT_TTL_MS : MISS_TTL_MS;
    if (age > ttl) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(cacheDir, host, dataUri) {
  try {
    fs.mkdirSync(cacheDir, {recursive: true});
    fs.writeFileSync(
      path.join(cacheDir, `${cacheKey(host)}.json`),
      JSON.stringify({dataUri: dataUri || null, fetchedAt: Date.now()}),
    );
  } catch (error) {
    console.log('[favicon] cache write failed:', error && error.message);
  }
}

/**
 * Resolve a bookmark URL to a data: URI for its favicon, or null when the site
 * has none. Safe to call on every render -- repeat calls hit the disk cache.
 */
async function resolveFavicon(cacheDir, rawUrl) {
  let origin;
  let host;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    origin = parsed.origin;
    host = parsed.host;
  } catch {
    return null;
  }

  const cached = readCache(cacheDir, host);
  if (cached) return cached.dataUri;

  // The conventional location first -- one request resolves most sites.
  let image = await fetchImage(`${origin}/favicon.ico`);

  if (!image) {
    // Otherwise read the document and take the best <link rel="icon">.
    const page = await fetchOnce(origin, MAX_REDIRECTS, {maxBytes: MAX_HTML_BYTES, stopAtHead: true});
    if (page && /text\/html/.test(page.contentType)) {
      const candidates = parseIconHrefs(page.body.toString('utf8'), page.finalUrl);
      for (const candidate of candidates) {
        image = await fetchImage(candidate);
        if (image) break;
      }
    }
  }

  const dataUri = image ? `data:${image.mime};base64,${image.body.toString('base64')}` : null;
  writeCache(cacheDir, host, dataUri);
  return dataUri;
}

module.exports = {resolveFavicon};
