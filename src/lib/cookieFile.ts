// Reading, writing and describing cookie files, for the renderer.
//
// This is a TypeScript port of the parsing in electron/main.cjs (see
// normalizeCookieUrl / normalizeCookie / parseNetscapeCookies /
// parseCookieContent / cookieRawFromDataUrl there). It is deliberately
// duplicated rather than shared: electron/ holds only .cjs files that Electron
// loads directly, nothing compiles them (`dist` is `vite build &&
// electron-builder`, and electron-builder ships electron/**/* raw), so a shared
// module would mean inventing a whole build phase for seventy lines of field
// coercion. An IPC round trip for a pure function would be worse still.
//
// THE CONTRACT THAT MUST NOT DRIFT is the object shape normalizeCookie()
// returns. The inspector writes that shape into cookie_sets.cookies and
// re-uploads it as the very file main.cjs later parses back and hands to
// chrome.cookies.set(). Change the shape in one place and you must change it in
// the other.
//
// Everything below the parsers -- the row ids, the export writers, the expiry
// and domain helpers -- is renderer-only and has no counterpart in main.cjs.

// One cookie, in the shape chrome.cookies.set() accepts. `expirationDate` is in
// SECONDS (millisecond values are coerced down on the way in); its absence
// means a session cookie.
export type CookieEntry = {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  expirationDate?: number;
};

// A CookieEntry with a stable key, because useSelection<T extends {id: string}>
// and React's key both need one and a cookie has no natural id.
//
// The identity triple RFC 6265 actually uses is (domain, path, name), but a
// scraped file routinely contains genuine duplicates of it -- so the index goes
// in front. Without it two duplicate rows collapse into one and deleting either
// deletes both.
export type CookieRow = CookieEntry & {id: string};

export function normalizeCookieUrl(cookie: Record<string, unknown>): string {
  if (cookie.url) {
    return String(cookie.url);
  }
  const domain = String(cookie.domain || '').replace(/^\./, '');
  const pathPart = (cookie.path as string) || '/';
  return `${cookie.secure ? 'https' : 'http'}://${domain}${pathPart}`;
}

// Accepts every field spelling the wild throws at us: EditThisCookie and
// Cookie-Editor use httpOnly/sameSite/expirationDate, some exporters use
// http_only/same_site/expiration_date, and Netscape files use expires. A cookie
// with no name, or with neither a domain nor a url, cannot be set at all and is
// dropped rather than passed on broken.
export function normalizeCookie(cookie: unknown): CookieEntry | null {
  if (!cookie || typeof cookie !== 'object') {
    return null;
  }
  const raw = cookie as Record<string, unknown>;
  const name = String(raw.name || '').trim();
  const value = String(raw.value ?? '');
  const domain = String(raw.domain || '').trim();
  if (!name || (!domain && !raw.url)) {
    return null;
  }
  const normalized: CookieEntry = {
    url: normalizeCookieUrl(raw),
    name,
    value,
    domain: domain || undefined,
    path: (raw.path as string) || '/',
    secure: Boolean(raw.secure),
    httpOnly: Boolean(raw.httpOnly || raw.http_only),
    sameSite: (raw.sameSite as string) || (raw.same_site as string) || 'lax',
  };
  const expirationDate = Number(raw.expirationDate || raw.expiration_date || raw.expires);
  if (Number.isFinite(expirationDate) && expirationDate > 0) {
    // Anything past the year 2286 in seconds is really milliseconds.
    normalized.expirationDate = expirationDate > 10000000000 ?
      Math.floor(expirationDate / 1000) :
      expirationDate;
  }
  return normalized;
}

// The tab-delimited cookies.txt curl and wget write. Seven fields; the value is
// rejoined because a value may itself contain tabs.
export function parseNetscapeCookies(raw: string): CookieEntry[] {
  return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const parts = line.split('\t');
        if (parts.length < 7) {
          return null;
        }
        const [domain, , pathPart, secure, expires, name, ...valueParts] = parts;
        return normalizeCookie({
          domain,
          path: pathPart || '/',
          secure: secure.toUpperCase() === 'TRUE',
          expirationDate: Number(expires),
          name,
          value: valueParts.join('\t'),
        });
      })
      .filter((cookie): cookie is CookieEntry => cookie !== null);
}

// JSON first, Netscape on parse failure. Both a bare array and the
// {cookies: [...]} envelope the browser extensions emit are accepted.
export function parseCookieContent(raw: string): CookieEntry[] {
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.cookies;
    if (!Array.isArray(list)) {
      return [];
    }
    return list.map(normalizeCookie).filter((cookie): cookie is CookieEntry => cookie !== null);
  } catch {
    return parseNetscapeCookies(raw);
  }
}

// The data: fallback uploadCookieFile produces when the Storage bucket is
// unwritable. Returns null for anything that is not a data: URL, so callers can
// use it as the "is this inline?" test.
export function cookieRawFromDataUrl(url: string): string | null {
  const match = /^data:([^,]*?)(;base64)?,(.*)$/i.exec(String(url || ''));
  if (!match) {
    return null;
  }
  const [, , base64, body] = match;
  if (!base64) {
    return decodeURIComponent(body);
  }
  // atob gives latin-1 bytes; the file is UTF-8, so re-decode it as such --
  // otherwise any non-ASCII cookie value comes back mojibake.
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// The cookie_sets.cookies jsonb column, which we wrote ourselves but which a
// hand-edit in the Supabase dashboard could have left as anything. Re-normalize
// rather than trusting it.
export function cookiesFromJsonValue(value: unknown): CookieEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeCookie).filter((cookie): cookie is CookieEntry => cookie !== null);
}

export function withRowIds(cookies: CookieEntry[]): CookieRow[] {
  return cookies.map((cookie, index) => ({
    ...cookie,
    id: `${index}:${cookie.domain || ''}|${cookie.path}|${cookie.name}`,
  }));
}

// A bare array, not the {cookies: [...]} envelope: both round-trip through
// parseCookieContent and through main.cjs, and the bare array is what
// Cookie-Editor's own importer accepts.
export function toCookieJson(cookies: CookieEntry[]): string {
  const bare = cookies.map(({url, name, value, domain, path, secure, httpOnly, sameSite,
    expirationDate}) => ({
    url, name, value, domain, path, secure, httpOnly, sameSite,
    ...(expirationDate === undefined ? {} : {expirationDate}),
  }));
  return JSON.stringify(bare, null, 2);
}

// The seven tab-delimited fields, in the order parseNetscapeCookies reads them
// back. The second field is the "include subdomains" flag, which by convention
// is TRUE exactly when the domain has a leading dot.
//
// Lossy, and unavoidably so: the format has no slot for httpOnly or sameSite,
// so a re-imported cookie comes back httpOnly:false, sameSite:'lax'. That is
// enough to make a session cookie stop working while the count still matches,
// which is exactly the sort of failure that looks like nothing went wrong --
// so JSON is the format to reach for unless something downstream demands this
// one.
export function toNetscapeCookies(cookies: CookieEntry[]): string {
  const header = '# Netscape HTTP Cookie File\n' +
    '# Exported by Scout Web. Tab-separated; do not edit by hand.\n';
  const lines = cookies.map((cookie) => {
    const domain = cookie.domain || hostnameOf(cookie.url);
    return [
      domain,
      domain.startsWith('.') ? 'TRUE' : 'FALSE',
      cookie.path || '/',
      cookie.secure ? 'TRUE' : 'FALSE',
      String(Math.floor(cookie.expirationDate || 0)),
      cookie.name,
      cookie.value,
    ].join('\t');
  });
  return `${header}${lines.join('\n')}\n`;
}

// normalizeCookie guarantees a domain or a url, not a *parseable* url -- a
// hand-edited row in the database can be anything. An export is not the place
// to throw over one bad line, so the raw value goes through as the domain and
// the rest of the file still lands.
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// "Session" when there is no expiry, "Expired" when it has passed, otherwise
// the date. The inspector shows this instead of a raw epoch because the whole
// point of opening a set is to find out whether it is still good.
export function cookieExpiryLabel(cookie: CookieEntry): string {
  if (!cookie.expirationDate) {
    return 'Session';
  }
  const when = new Date(cookie.expirationDate * 1000);
  if (Number.isNaN(when.getTime())) {
    return 'Session';
  }
  return when.getTime() < Date.now() ? 'Expired' : when.toISOString().slice(0, 10);
}

export function isCookieExpired(cookie: CookieEntry): boolean {
  return Boolean(cookie.expirationDate) && cookie.expirationDate! * 1000 < Date.now();
}

// Distinct domains, most-used first -- the order the inspector's domain filter
// offers them in, so the site the set is actually for is at the top.
export function cookieDomains(cookies: CookieEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const cookie of cookies) {
    const domain = cookie.domain || '';
    if (domain) {
      counts.set(domain, (counts.get(domain) || 0) + 1);
    }
  }
  return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([domain]) => domain);
}

// UTF-8 safe base64, for handing an edited file back to uploadCookieFile (which
// takes base64 and does its own atob). btoa alone throws on any non-ASCII
// cookie value, which real session cookies do contain.
export function cookieFileToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// The bytes a native file picker hands back, as the text the parser wants.
//
// The picker's payload is base64 of the file, because that is what survives an
// IPC boundary intact whatever the encoding turns out to be. Both the library
// upload path and the import dialog's preview have to decode it, and they must
// agree about what a file contains -- the dialog says "43 cookies" and the
// upload is what actually lands.
export function decodeCookieBase64(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
