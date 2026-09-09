// A whole proxy list file, read into rows the import dialog can show.
//
// Split out of lib/proxies.ts, which stays the module about a *single* proxy.
// The reason for the split is the column path below: a file with a header row is
// a different kind of object from a list of connection strings, and reading one
// needs the CSV parser, the header aliases and the "is this even a header"
// decision -- none of which a function that parses "host:port:user:pass" should
// have to carry.
//
// Two paths, decided per file:
//
//   host,port,username,password        <- column path, driven by the header
//   198.51.100.10,1080,user,pass
//
//   198.51.100.10:1080:user:pass       <- line path, one parseProxyLink per line
//   socks5://203.0.113.20:8080
//
// Before this existed there was only the line path, and it split on ':' alone.
// A vendor list saved as .txt imported; the identical list saved as .csv came
// back with every line -- header included -- marked "Not a proxy". The file
// picker accepts .csv, so the failure looked like a bad file rather than a
// parser that had never learned about commas.
import {parseCsv, normalizeHeaderKey} from './csv';
import {
  defaultProxyName, hasProxySeparator, namesProxyType, parseProxyLink, proxyDedupeKey,
  proxyDedupeKeys,
} from './proxies';
import type {ScoutProxy} from '../types';

// One row of a pasted or imported proxy list, already classified against the
// proxies that exist. `duplicate` rows are kept rather than dropped so the
// import preview can say "8 new, 2 already in your list" instead of silently
// importing a different number than the file contained.
export type ParsedProxyLine = {
  line: number;
  raw: string;
  proxy: Omit<ScoutProxy, 'id'> | null;
  duplicate: boolean;
  // False when the row was a bare "host:port:user:pass" and the type is only
  // parseProxyLink's socks5 default, so the import dialog knows which rows its
  // one-type-for-the-file selector is allowed to reassign. A file with a `type`
  // column sets it per row, exactly as a "socks5://" line does.
  explicitType: boolean;
  error?: string;
};

// What a header cell may be called. Every one of these has turned up in a real
// vendor export; `proxy` is there because more than one provider heads the whole
// endpoint column with it.
const COLUMN_ALIASES: Record<string, string[]> = {
  host: ['host', 'ip', 'ip_address', 'address', 'server', 'hostname', 'proxy', 'proxy_host'],
  port: ['port', 'proxy_port'],
  username: ['username', 'user', 'login', 'user_name', 'proxy_user', 'proxy_username'],
  password: ['password', 'pass', 'pwd', 'proxy_pass', 'proxy_password'],
  type: ['type', 'protocol', 'scheme', 'proxy_type'],
  name: ['name', 'label', 'title'],
};

// The header keys parseCsv would produce, as one lookup.
const HEADER_FIELDS = new Map<string, string>(
    Object.entries(COLUMN_ALIASES).flatMap(([field, aliases]) =>
      aliases.map((alias) => [alias, field] as [string, string])));

const PROXY_ERROR = 'Not a proxy — expected host:port:username:password';

// Whether the first line of this file is a header rather than data.
//
// Both halves of the test matter. Two known column names is what makes a header
// a header -- one is a coincidence, and files head their columns "IP" and "Port"
// far more often than a proxy line happens to contain either word. And a line
// that parses as a proxy is data whatever it is called: a host of
// "port.example.com" would otherwise cost the file its first row, silently.
function looksLikeHeader(line: string) {
  if (!line || parseProxyLink(line)) {
    return false;
  }
  const cells = line.split(/[,;\t|]/).map((cell) => normalizeHeaderKey(cell.replace(/^"|"$/g, '')));
  const known = new Set(cells.filter((cell) => HEADER_FIELDS.has(cell)));
  return known.size >= 2;
}

// The first value among a field's aliases that the row actually carries.
function cell(row: Record<string, string>, field: string) {
  for (const alias of COLUMN_ALIASES[field]) {
    const value = row[alias]?.trim();
    if (value) {
      return value;
    }
  }
  return '';
}

// A headed file, read by its columns.
//
// The host cell is put back through parseProxyLink rather than trusted, because
// a "proxy" or "address" column routinely holds the whole endpoint --
// "198.51.100.10:1080", sometimes with the credentials on the end -- and a file
// that names its columns is not a promise that each one holds a single value.
// Explicit port/username/password columns still win over anything found inside
// the host cell, since those are what the file went to the trouble of naming.
// `lineOffset` puts the numbers back where the user's file has them: any comment
// lines above the header were sliced off before parseCsv saw the text, and a row
// reported on line 2 of a file whose header is line 5 is not findable.
function fromColumns(content: string, seen: Set<string>, lineOffset: number): ParsedProxyLine[] {
  return parseCsv(content).map(({row, line: csvLine}): ParsedProxyLine => {
    const line = csvLine + lineOffset;
    const hostCell = cell(row, 'host');
    const portCell = cell(row, 'port');
    const namedType = cell(row, 'type');
    const raw = [hostCell, portCell].filter(Boolean).join(':');
    // A cell with a separator in it is offered to the connection parser: a
    // "proxy" or "address" column routinely holds the whole endpoint, sometimes
    // with the credentials on the end. A cell without one is a bare host, and
    // parseProxyLink would reject it for having no port -- which is exactly what
    // the file put in its own column.
    const endpoint = hasProxySeparator(hostCell) ? parseProxyLink(hostCell) : null;
    const host = endpoint?.host || (hasProxySeparator(hostCell) ? '' : hostCell);
    // The explicit column wins over anything found inside the host cell: that is
    // the value the file went to the trouble of naming.
    const port = portCell ? Number(portCell) : endpoint?.port || 0;

    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return {
        line,
        raw: raw || Object.values(row).filter(Boolean).join(','),
        proxy: null,
        duplicate: false,
        explicitType: false,
        error: hostCell ? PROXY_ERROR : 'No host in this row',
      };
    }

    const type = namedType ?
      (namedType.toLowerCase().startsWith('http') ? 'http' : 'socks5') :
      endpoint?.type || 'socks5';
    const username = cell(row, 'username') || endpoint?.username || undefined;
    const password = cell(row, 'password') || endpoint?.password || undefined;
    const key = proxyDedupeKey(type, host, port, username || '');
    const duplicate = seen.has(key);
    seen.add(key);
    return {
      line,
      raw,
      proxy: {
        type,
        host,
        port,
        username,
        password,
        name: cell(row, 'name') || defaultProxyName(host, port),
      },
      duplicate,
      // A type column is the file naming the protocol, which is the same claim
      // a "socks5://" prefix makes -- so the dialog's selector leaves it alone.
      explicitType: Boolean(namedType),
    };
  });
}

// Splits a proxy list file (or a pasted block) into one result per non-empty
// line. Blank lines and `#` comments are dropped entirely; anything else that
// fails to parse comes back with an error so the review table can show which
// line was wrong -- and let it be fixed -- rather than quietly importing fewer
// proxies than the file held.
//
// Every format parseProxyLink accepts works here: the bare
// "host:port:user:pass" that vendors hand out in any of the delimiters, the
// "socks5://..." URL form, "user:pass@host:port" in either direction, and a
// "type:host:port:user:pass" prefix.
function fromLines(content: string, seen: Set<string>): ParsedProxyLine[] {
  const results: ParsedProxyLine[] = [];
  content.split(/\r?\n/).forEach((rawLine, index) => {
    const raw = rawLine.trim();
    if (!raw || raw.startsWith('#')) {
      return;
    }
    const parsed = parseProxyLink(raw);
    if (!parsed) {
      results.push({line: index + 1, raw, proxy: null, duplicate: false, explicitType: false,
        error: PROXY_ERROR});
      return;
    }
    const type = parsed.type || 'socks5';
    const key = proxyDedupeKey(type, parsed.host, parsed.port, parsed.username || '');
    // Duplicates are matched against the file's own earlier lines too, so a
    // list that repeats a proxy imports it once.
    const duplicate = seen.has(key);
    seen.add(key);
    results.push({
      line: index + 1,
      raw,
      proxy: {...parsed, type, name: defaultProxyName(parsed.host, parsed.port)},
      duplicate,
      explicitType: namesProxyType(raw),
    });
  });
  return results;
}

export function parseProxyList(content: string, existing: ScoutProxy[]): ParsedProxyLine[] {
  // Every key an existing proxy answers to, plus every key this file has already
  // used -- one set, threaded through whichever path runs, so a repeated row is
  // a duplicate whether the repeat came from the library or from line four.
  const seen = new Set(existing.flatMap(proxyDedupeKeys));
  const lines = content.split(/\r?\n/);
  // The header is the first line that is neither blank nor a comment -- and if
  // it turns out to be one, the comments above it have to go before parseCsv
  // sees the file, or "# my proxies" becomes the header row.
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    return Boolean(trimmed) && !trimmed.startsWith('#');
  });
  if (start === -1) {
    return [];
  }
  return looksLikeHeader(lines[start].trim()) ?
    fromColumns(lines.slice(start).join('\n'), seen, start) :
    fromLines(content, seen);
}
