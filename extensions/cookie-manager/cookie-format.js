// Cookie parsing/writing shared by background.js, popup.js and editor.js.
//
// A plain-JS port of launcher/src/lib/cookieFile.ts (itself a port of the
// parsing in electron/main.cjs -- see that file's header). Deliberately
// duplicated: this extension is loaded raw by Chrome with no build step, so
// it can import nothing. launcher/src/lib/cookieFormatDrift.test.ts asserts
// the two stay byte-identical -- change one, change the other.
//
// Loaded via importScripts() in the service worker and <script src> in
// pages; the CJS branch exists only for the drift test.
(function(root) {
  'use strict';

  function normalizeCookieUrl(cookie) {
    if (cookie.url) {
      return String(cookie.url);
    }
    const domain = String(cookie.domain || '').replace(/^\./, '');
    const pathPart = cookie.path || '/';
    return `${cookie.secure ? 'https' : 'http'}://${domain}${pathPart}`;
  }

  // Accepts every field spelling the wild throws at us: EditThisCookie and
  // Cookie-Editor use httpOnly/sameSite/expirationDate, some exporters use
  // http_only/same_site/expiration_date, and Netscape files use expires. A
  // cookie with no name, or with neither a domain nor a url, cannot be set
  // at all and is dropped rather than passed on broken.
  function normalizeCookie(cookie) {
    if (!cookie || typeof cookie !== 'object') {
      return null;
    }
    const raw = cookie;
    const name = String(raw.name || '').trim();
    const value = String(raw.value ?? '');
    const domain = String(raw.domain || '').trim();
    if (!name || (!domain && !raw.url)) {
      return null;
    }
    const normalized = {
      url: normalizeCookieUrl(raw),
      name,
      value,
      domain: domain || undefined,
      path: raw.path || '/',
      secure: Boolean(raw.secure),
      httpOnly: Boolean(raw.httpOnly || raw.http_only),
      sameSite: raw.sameSite || raw.same_site || 'lax',
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

  // The tab-delimited cookies.txt curl and wget write. Seven fields; the
  // value is rejoined because a value may itself contain tabs.
  function parseNetscapeCookies(raw) {
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
        .filter((cookie) => cookie !== null);
  }

  // JSON first, Netscape on parse failure. Both a bare array and the
  // {cookies: [...]} envelope the browser extensions emit are accepted.
  function parseCookieContent(raw) {
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.cookies;
      if (!Array.isArray(list)) {
        return [];
      }
      return list.map(normalizeCookie).filter((cookie) => cookie !== null);
    } catch (error) {
      return parseNetscapeCookies(raw);
    }
  }

  // A bare array, not the {cookies: [...]} envelope: both round-trip through
  // parseCookieContent and through main.cjs, and the bare array is what
  // Cookie-Editor's own importer accepts.
  function toCookieJson(cookies) {
    const bare = cookies.map(({url, name, value, domain, path, secure, httpOnly, sameSite,
      expirationDate}) => ({
      url, name, value, domain, path, secure, httpOnly, sameSite,
      ...(expirationDate === undefined ? {} : {expirationDate}),
    }));
    return JSON.stringify(bare, null, 2);
  }

  // The seven tab-delimited fields, in the order parseNetscapeCookies reads
  // them back. The second field is the "include subdomains" flag, which by
  // convention is TRUE exactly when the domain has a leading dot.
  //
  // Lossy, and unavoidably so: the format has no slot for httpOnly or
  // sameSite, so a re-imported cookie comes back httpOnly:false,
  // sameSite:'lax'. That is enough to make a session cookie stop working
  // while the count still matches, which is exactly the sort of failure
  // that looks like nothing went wrong -- so JSON is the format to reach for
  // unless something downstream demands this one.
  function toNetscapeCookies(cookies) {
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
  // hand-edited row in the database can be anything. An export is not the
  // place to throw over one bad line, so the raw value goes through as the
  // domain and the rest of the file still lands.
  function hostnameOf(url) {
    try {
      return new URL(url).hostname;
    } catch (error) {
      return url;
    }
  }

  // "Session" when there is no expiry, "Expired" when it has passed,
  // otherwise the date. The editor shows this instead of a raw epoch
  // because the whole point of opening a set is to find out whether it is
  // still good.
  function cookieExpiryLabel(cookie) {
    if (!cookie.expirationDate) {
      return 'Session';
    }
    const when = new Date(cookie.expirationDate * 1000);
    if (Number.isNaN(when.getTime())) {
      return 'Session';
    }
    return when.getTime() < Date.now() ? 'Expired' : when.toISOString().slice(0, 10);
  }

  // Distinct domains, most-used first -- the order the editor's domain
  // filter offers them in, so the site the set is actually for is at the
  // top.
  function cookieDomains(cookies) {
    const counts = new Map();
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

  // The change-detection signature background.js keys pushes off. Same
  // fields, same order as the seedSignature it replaces.
  function jarSignature(cookies) {
    return cookies
        .map((cookie) =>
          `${cookie.domain || ''}\t${cookie.path || '/'}\t${cookie.name || ''}\t${cookie.value || ''}`)
        .join('\n');
  }

  const api = {
    normalizeCookie, parseCookieContent, parseNetscapeCookies,
    toCookieJson, toNetscapeCookies, cookieExpiryLabel, cookieDomains,
    jarSignature,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ScoutCookieFormat = api;
  }
})(globalThis);
