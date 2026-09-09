import {comparable} from './text';
import {countryName} from '../data/folderIcons';
import type {ScoutProfile, ScoutProxy, CloudState} from '../types';

// What the country columns and the country search agree a proxy's country is.
//
// The check endpoints do not agree with each other: some hand back
// "United States", some only "US" (see resolveProxyLocation in main.cjs), so
// proxy.country is whichever of the two that proxy's lookup happened to land
// on. Rendering the stored string as-is meant a table full of "US" that the
// "United States" the move dialog seeds its search with could not match --
// eleven proxies ticked, and "No proxies match that search" over them.
export function proxyCountryLabel(proxy: ScoutProxy) {
  const stored = proxy.country?.trim();
  if (stored && stored.length > 2) {
    return stored;
  }
  const code = (stored || proxy.country_code)?.trim();
  return code ? countryName(code) : '';
}

// Everything a proxy can be searched by, as one lowercase haystack. Both the
// table and the move dialog filter through this so they can never disagree
// about whether a proxy matches -- the country name is in here even when the
// row only ever stored the code.
export function proxySearchText(proxy: ScoutProxy) {
  return [proxy.name, proxy.host, String(proxy.port || ''), proxy.username,
    proxy.country, proxy.country_code, proxyCountryLabel(proxy), proxy.type]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
}

export function proxyOptionLabel(proxy: ScoutProxy) {
  const name = proxy.name || `${proxy.host}:${proxy.port || ''}`;
  const type = (proxy.type || 'http').toUpperCase();
  const port = proxy.port ? proxy.port : 'no port';
  return `${name} · ${type} · ${proxy.host}:${port}`;
}

// There used to be a second, stricter parser here -- parseProxyConnectionString,
// an anchored /^(http|socks5):\/\/([^:]+):(\d+):([^:]*):(.*)$/ used by the
// profile CSV importer alone. It required all five groups, so a perfectly good
// "socks5://204.252.87.159:47403" was rejected for having no trailing
// ":user:pass", which is exactly what this app's own profile export wrote. Two
// parsers meant the proxy-list importer could advertise "203.0.113.20:8080" in
// its example while the profile importer refused the same string. There is now
// one: parseProxyLink, below.

export function proxyDedupeKey(type: string, host: string, port: number, username: string) {
  return [type, host, port, username].join('|').toLowerCase();
}

// Every key an existing proxy should be found under. Normally one -- but a
// proxy saved before `type` was a field has no type, and keying it as 'http'
// (the old fallback) meant a CSV row saying socks5://same-host:same-port never
// matched it and imported a duplicate instead. An untyped record answers to
// both, and the import fills the type in rather than creating a second row.
export function proxyDedupeKeys(proxy: Pick<ScoutProxy, 'type' | 'host' | 'port' | 'username'>) {
  const types = proxy.type ? [proxy.type] : ['http', 'socks5'];
  return types.map((type) => proxyDedupeKey(type, proxy.host, proxy.port, proxy.username || ''));
}

// Accepts either a real URL (http://user:pass@host:port, socks5://...) or the
// colon-delimited "type:host:port:user:pass" shorthand people paste from proxy
// vendors, which is not a URL at all.
export function parseProxyLink(value: string): Omit<ScoutProxy, 'id' | 'name'> | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `socks5://${trimmed}`;
    const url = new URL(withProtocol);
    const protocol = url.protocol.replace(':', '').toLowerCase();
    const type = protocol.startsWith('http') ? 'http' : 'socks5';
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      // Not a usable URL, but that does not make it unusable -- and it used to
      // end here. "socks5://host:port:user:p@ss" parses *successfully* as a
      // URL, because the @ makes everything before it userinfo and leaves "ss"
      // as the hostname; the port then comes out empty and the whole line was
      // rejected. Any @ in a password did this, which is most of them.
      return fromShorthand(trimmed);
    }
    return {
      type,
      host: url.hostname,
      port,
      username: decodeURIComponent(url.username || '') || undefined,
      password: decodeURIComponent(url.password || '') || undefined,
    };
  } catch {
    // "socks5://host:port:user:pass" lands here rather than in the URL branch
    // above -- ":1080:user:pass" is not a valid URL port, so the parse throws.
    return fromShorthand(trimmed);
  }
}

// The separators a proxy line puts between its fields.
//
// A vendor list is colon-delimited, a spreadsheet export is comma- or
// semicolon-delimited, and a file saved out of a table is tab-delimited -- but
// the field *order* is the same handful either way, so the separator is the only
// thing that has to vary. This parser used to split on ':' and nothing else,
// which is why a proxy list saved as .csv reported every one of its lines
// unreadable while the identical list saved as .txt imported fine.
//
// The space is deliberately absent. With it, "not a proxy: really" pasted into a
// password field parses as a proxy, and a line the user never meant as one is a
// worse failure than a line this refuses.
const FIELD_SEPARATORS = [':', ',', ';', '\t', '|'];
const ANY_SEPARATOR = /[:,;\t|]/;

// A scheme named at the front of a line, in any of the forms one arrives in:
// "socks5://host", the slashless "socks5:host" shorthand, and the "socks5,host"
// a spreadsheet writes when the type is its first column.
const TYPE_PREFIX = /^(https?|socks5?)(:\/\/|[:,;\t|])/i;

// True when the line itself named a protocol, so the caller knows its own
// one-type-for-the-whole-file selector is not allowed to reassign this row.
// Exported because both the list importer and the paste splitter have to ask
// exactly this question, and they used to ask it with two different regexes.
export function namesProxyType(raw: string) {
  return TYPE_PREFIX.test(raw.trim());
}

// Whether a value has anything in it for the parser to divide on. The column
// importer asks this of a host cell: with a separator the cell is an endpoint to
// be split, without one it is a bare host whose port is in the next column --
// and parseProxyLink would reject that for having no port at all.
export function hasProxySeparator(value: string) {
  return ANY_SEPARATOR.test(value);
}

function proxyTypeNamed(value: string | undefined): 'http' | 'socks5' | null {
  const name = value?.trim().toLowerCase();
  if (name === 'http' || name === 'https') {
    return 'http';
  }
  if (name === 'socks' || name === 'socks5') {
    return 'socks5';
  }
  return null;
}

// Every way a line might divide into fields, best first: one separator at a
// time, so a password containing a comma survives a colon-delimited line, and
// then a mixed split as the last resort -- "host:port,user,pass" is a real shape
// and neither single separator reads it.
function fieldSplits(text: string): string[][] {
  const splits = FIELD_SEPARATORS
      .filter((separator) => text.includes(separator))
      .map((separator) => text.split(separator));
  if (ANY_SEPARATOR.test(text)) {
    splits.push(text.split(ANY_SEPARATOR));
  }
  // Empty segments are kept (no filter(Boolean)): dropping them silently
  // shifted a password into the username slot for "host:port::pass".
  return splits.map((parts) => parts.map((part) => part.trim()));
}

// The two field orders in circulation, given one candidate division of a line.
function fromParts(parts: string[]): Omit<ScoutProxy, 'id' | 'name'> | null {
  const named = proxyTypeNamed(parts[0]);
  const type = named || 'socks5';
  const rest = named ? parts.slice(1) : parts;
  // host:port:user:pass, the order every vendor list uses.
  if (rest[0] && isPort(rest[1])) {
    return {
      type,
      host: rest[0],
      port: Number(rest[1]),
      username: rest[2] || undefined,
      password: rest[3] || undefined,
    };
  }
  // user:pass:host:port -- the other order in circulation, and the reason
  // this does not simply read slots 0 and 1. Only accepted when the third
  // segment actually looks like a host and the fourth like a port, so a
  // password that happens to be numeric cannot turn a line inside out.
  if (rest.length === 4 && looksLikeProxyHost(rest[2]) && isPort(rest[3])) {
    return {
      type,
      host: rest[2],
      port: Number(rest[3]),
      username: rest[0] || undefined,
      password: rest[1] || undefined,
    };
  }
  return null;
}

// "host:port", with an optional scheme in front. Returns null for anything else,
// which is what tells the two halves of an @-form apart.
function asEndpoint(text: string) {
  const prefix = TYPE_PREFIX.exec(text);
  const type = prefix ? proxyTypeNamed(prefix[1]) : null;
  const body = prefix ? text.slice(prefix[0].length) : text;
  for (const parts of fieldSplits(body)) {
    if (parts.length === 2 && parts[0] && isPort(parts[1])) {
      return {type, host: parts[0], port: Number(parts[1])};
    }
  }
  return null;
}

// The other half of an @-form. Split on the FIRST separator only, so a password
// full of colons stays one password rather than becoming three fields nobody
// asked for. Never fails -- which side is the endpoint is asEndpoint's decision,
// not this one's.
function asCredentials(text: string) {
  const prefix = TYPE_PREFIX.exec(text);
  const type = prefix ? proxyTypeNamed(prefix[1]) : null;
  const body = prefix ? text.slice(prefix[0].length) : text;
  const at = body.search(ANY_SEPARATOR);
  if (at === -1) {
    return {type, username: body || undefined, password: undefined};
  }
  return {
    type,
    username: body.slice(0, at) || undefined,
    password: body.slice(at + 1) || undefined,
  };
}

// The delimited vendor shorthand, with or without a scheme in front, and with or
// without an @ dividing the credentials from the endpoint.
function fromShorthand(trimmed: string): Omit<ScoutProxy, 'id' | 'name'> | null {
  // Flattening "://" to ":" makes a scheme-prefixed line the same shape as
  // the bare shorthand; without this the leading "//" stayed glued to the
  // host and every such line imported a hostname curl could not resolve.
  const flat = trimmed.replace(/^([a-z][a-z0-9+.-]*):\/\//i, '$1:');
  // The LAST @, so a password containing one survives -- most provider
  // passwords do, and that is what broke the URL branch above.
  const at = flat.lastIndexOf('@');
  if (at > 0 && at < flat.length - 1) {
    const left = flat.slice(0, at);
    const right = flat.slice(at + 1);
    // Endpoint on the right first: that is the URL convention, and it settles
    // "user:1080@host:8080", where both sides read as an endpoint.
    for (const [endpointText, credentialText] of [[right, left], [left, right]]) {
      const endpoint = asEndpoint(endpointText);
      if (!endpoint) {
        continue;
      }
      const credentials = asCredentials(credentialText);
      return {
        type: endpoint.type || credentials.type || 'socks5',
        host: endpoint.host,
        port: endpoint.port,
        username: credentials.username,
        password: credentials.password,
      };
    }
  }
  for (const parts of fieldSplits(flat)) {
    const parsed = fromParts(parts);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

// One connection string, as it should land in a form that has a field per part.
//
// This is the pure half of what the proxy editor has always done on paste, split
// out because the CSV import's per-row proxy popover needs exactly the same
// decision and a second copy of it is how this file ended up with two parsers
// once already (see the note above parseProxyLink).
//
// `strict` is for the fields that are not the host: a paste into Password is only
// a connection string when what parsed out of it really looks like one, because
// "hunter2:1080" parses just as cleanly as a proxy does.
export function splitPastedConnection(raw: string, {strict = false} = {}):
    (Omit<ScoutProxy, 'id' | 'name'> & {explicitType: boolean}) | null {
  // No separator, nothing to split -- and parseProxyLink would happily read a
  // bare word as a hostname, which is not what a paste into Username meant.
  // Any of the separators, not just the colon: a line copied out of a
  // spreadsheet cell arrives comma-delimited, and refusing to split it here was
  // the paste half of the same bug that made a .csv proxy list unreadable.
  if (!ANY_SEPARATOR.test(raw)) {
    return null;
  }
  const parsed = parseProxyLink(raw);
  if (!parsed) {
    return null;
  }
  const trimmed = raw.trim();
  // Two deliberately different tests, and they must stay different. The guard
  // asks "is this unambiguously a URL", which needs the slashes; explicitType
  // asks "did the user name a protocol", which the "socks5:host:port" shorthand
  // does without them. One regex for both would either let a password through
  // the guard or drop the type off the shorthand.
  if (strict && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !looksLikeProxyHost(parsed.host)) {
    return null;
  }
  return {...parsed, explicitType: namesProxyType(trimmed)};
}

// A proxy as one string, the inverse of parseProxyLink.
//
// Both halves of the userinfo are percent-encoded because provider passwords are
// full of the characters that would otherwise re-parse as structure -- an @
// splits userinfo from host, a : splits user from password. parseProxyLink
// decodes them back, so this round-trips whatever was typed.
export function formatProxyLink(
    proxy: Pick<ScoutProxy, 'type' | 'host' | 'port' | 'username' | 'password'>) {
  const type = proxy.type || 'socks5';
  const endpoint = `${proxy.host}:${proxy.port}`;
  // No credentials means no userinfo at all, rather than an empty ":@". Both
  // parse back to the same proxy, but only one of them is what the user sees in
  // the cell and would recognise as the line their file contained.
  if (!proxy.username && !proxy.password) {
    return `${type}://${endpoint}`;
  }
  const user = encodeURIComponent(proxy.username || '');
  const pass = encodeURIComponent(proxy.password || '');
  return `${type}://${user}:${pass}@${endpoint}`;
}

function isPort(value: string | undefined) {
  if (!value || !/^\d{1,5}$/.test(value)) {
    return false;
  }
  const port = Number(value);
  return port > 0 && port < 65536;
}

// An IPv4 literal, a bracketed IPv6 one, or a dotted hostname. Deliberately
// stricter than "not empty": this is only ever asked about a segment whose
// position is ambiguous, and a credential is far more likely than a hostname
// with no dot in it.
//
// Exported for the proxy editor, which offers to split a pasted line in every
// field including Password -- a password of "hunter2:1080" parses perfectly
// well as a connection string, and this is what stops it being treated as one.
export function looksLikeProxyHost(value: string | undefined) {
  if (!value) {
    return false;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) ||
    /^\[[0-9a-f:]+\]$/i.test(value) ||
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value);
}

// The name a proxy gets when the source gave us none -- every vendor list is
// bare connection strings, and "206.251.200.171:47450" is what the user
// recognises a row by. Kept identical to the fallback in useProxyActions.save
// so a hand-added proxy and an imported one are named the same way.
export function defaultProxyName(host: string, port: number) {
  return `${host}:${port}`;
}

// parseProxyList and its ParsedProxyLine used to live here. They moved to
// lib/proxyList.ts when the list gained a column path: a whole file is a
// different subject from a single connection string, and this is the module
// everything in the app imports a proxy helper from.

export function matchedProxyForProfile(profile: ScoutProfile, proxies: ScoutProxy[]) {
  const current = proxies.find((proxy) =>
    comparable(proxy.id) === comparable(profile.proxy_id));
  if (current) {
    return current;
  }
  const profileName = comparable(profile.name);
  return proxies.find((proxy) => {
    const proxyName = comparable(proxy.name);
    return proxyName === `${profileName} proxy` ||
      proxyName === profileName ||
      proxyName.startsWith(`${profileName} `);
  }) || null;
}

// Which profiles are actually holding this proxy. Assignment is many-to-one --
// nothing stops two profiles pointing at the same proxy -- so this returns a
// list rather than a profile, and the table's "Assigned to" column says "+2"
// instead of pretending there is one answer.
//
// Trashed profiles do not count. A soft-deleted profile is not launching
// anything, so a proxy held only by one is free to be reused.
export function profilesUsingProxy(proxy: ScoutProxy, profiles: ScoutProfile[]) {
  return profiles.filter((profile) =>
    !profile.deleted_at && comparable(profile.proxy_id) === comparable(proxy.id));
}

// Defined over profilesUsingProxy rather than repeating its filter, so the
// Assigned/Not-assigned dropdown and the column that names the profiles can
// never disagree about what "assigned" means.
export function isProxyAssigned(proxy: ScoutProxy, profiles: ScoutProfile[]) {
  return profilesUsingProxy(proxy, profiles).length > 0;
}

export function repairProxyAssignments(state: CloudState) {
  let repaired = 0;
  const profiles = state.profiles.map((profile) => {
    const proxy = matchedProxyForProfile(profile, state.proxies);
    if (!proxy) {
      return profile;
    }
    const alreadyAssigned = comparable(profile.proxy_id) === comparable(proxy.id);
    const alreadyAssignedMode = (profile.proxy_mode || 'assigned') === 'assigned';
    if (alreadyAssigned && alreadyAssignedMode) {
      return profile;
    }
    repaired++;
    return {...profile, proxy_id: proxy.id, proxy_mode: 'assigned' as const};
  });
  return {state: {...state, profiles}, repaired};
}
