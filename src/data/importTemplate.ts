// The sample CSV behind the importer's "Download example" button, and the one
// place that says what a column is called.
//
// The columns here are not a suggestion: they are exactly the keys
// previewCsvImport() in workspace/csvImport.ts reads off each row. Any other
// column in the file is parsed and then ignored, which is the failure the
// example exists to prevent -- the format used to be described in prose only,
// so the first import attempt was usually a header-name guess.
//
// `aliases` is what makes an exported file re-importable. The profile exporter
// used to write `proxy` and `status` while the importer read `proxy_name` and
// `status_name`, so a file this app produced could not be fed back into it:
// every row reported a proxy it could not parse, because it was reading a
// column that was not there. The exporter now writes the canonical names, and
// the aliases keep every file exported before that fix working.
import {normalizeHeaderKey, toCsv} from '../lib/csv';

export type ImportColumn = {
  name: string;
  required?: boolean;
  aliases?: string[];
  note: string;
};

// name is the only column the importer will refuse a row without. A row with
// no readable proxy is reported too, but as something to fix rather than a
// reason to throw the row away -- see ImportIssue in workspace/csvImport.ts.
export const importColumns: ImportColumn[] = [
  {
    name: 'name',
    required: true,
    aliases: ['profile_name'],
    note: 'Profile name. A row without one is skipped.',
  },
  {
    name: 'proxy_name',
    required: true,
    aliases: ['proxy', 'proxy_url'],
    note: 'Connection string: http:// or socks5:// then host:port, with an optional ' +
      ':username:password. socks5://username:password@host:port and a bare ' +
      'host:port:username:password work too. Include the credentials if the proxy needs ' +
      'them — most exports from other tools leave them out, and a proxy that needs a login ' +
      'and has none will fail its check. Proxies are matched and reused by ' +
      'type/host/port/username, so repeating one does not duplicate it.',
  },
  {
    name: 'proxy_mode',
    note: 'assigned (default), direct for a profile that deliberately uses no proxy, or ' +
      'free_proxy. A direct row is not reported as missing a proxy.',
  },
  {
    name: 'profile_id',
    aliases: ['id'],
    note: 'Re-importing with the same id updates that profile and reclaims its existing ' +
      'browser directory, cookies and sessions. Letters, digits, dot, dash and underscore ' +
      'only. Left empty, a new id is generated.',
  },
  {name: 'status_name', aliases: ['status'], note: 'Defaults to Ready.'},
  {
    name: 'folder',
    aliases: ['folder_name'],
    note: 'The folder this profile belongs in. Nothing is created from this value on its ' +
      'own -- you choose what happens to it after reviewing the import.',
  },
  {name: 'tags', note: 'Comma-separated. Semicolons work too.'},
  {name: 'start_url', note: 'Page the profile opens on launch.'},
  {name: 'created_at', note: 'ISO timestamp. Defaults to the time of import.'},
  {
    name: 'os',
    note: 'Windows 11, Windows 10, macOS, Ubuntu, Android or iOS. Picks a matching device ' +
      'identity. Anything else falls back to Windows 11.',
  },
  {name: 'browser_version', note: 'Auto, or a specific Chrome version. Defaults to Auto.'},
  {name: 'user_agent', note: 'Used verbatim when set. Left empty, it is derived from the OS.'},
  {name: 'language', note: 'Accept-Language header, or "Auto from proxy".'},
  {name: 'timezone', note: 'IANA zone name, or "Auto from proxy".'},
];

const keysByColumn = new Map(importColumns.map((column) =>
  [column.name, [column.name, ...(column.aliases || [])].map(normalizeHeaderKey)]));

// Reads one canonical column off a parsed row, falling back through that
// column's aliases. Trimmed here so every caller gets the same treatment --
// `created_at` used to reach Date.parse with whatever whitespace the file had
// while its neighbours were trimmed individually at the point of use.
export function columnValue(row: Record<string, string>, column: string): string {
  for (const key of keysByColumn.get(column) || [normalizeHeaderKey(column)]) {
    const value = row[key];
    if (value !== undefined && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

// Documentation ranges (RFC 5737 / 3849) rather than anything routable, so a
// copied-and-run example cannot point at someone else's host.
const exampleRows: Record<string, string>[] = [
  {
    name: 'Facebook warmup 01',
    proxy_name: 'socks5://198.51.100.10:1080:proxy-user:proxy-pass',
    profile_id: 'fb-warmup-001',
    status_name: 'Ready',
    folder: 'Facebook',
    tags: 'warmup, facebook',
    start_url: 'https://www.facebook.com/',
    created_at: '2026-01-15T09:00:00.000Z',
    os: 'Windows 11',
  },
  {
    // The credential-less shape. The trailing colons are optional now, so this
    // row is also the example that they are.
    name: 'Shop EU 02',
    proxy_name: 'http://203.0.113.44:8080',
    profile_id: 'shop-eu-002',
    status_name: 'Active',
    folder: 'Storefronts',
    tags: 'shop',
    created_at: '',
    os: 'macOS',
  },
  {
    // A profile that wants no proxy at all, which is a different thing from a
    // profile whose proxy is missing.
    name: 'Local QA 03',
    proxy_mode: 'direct',
    profile_id: 'local-qa-003',
    status_name: 'Ready',
    os: 'Android',
  },
];

export function profileImportExampleCsv() {
  return toCsv(importColumns.map((column) => column.name), exampleRows, (row) => row);
}

// The proxy-list twin, behind the proxy importer's own "Download example".
// A bare list of connection strings rather than a table, because that is the
// shape a vendor hands out -- the headed form has its own example below.
//
// Every line here round-trips through parseProxyList unchanged, and the hosts
// are documentation ranges (RFC 5737) rather than anything routable, so a file
// imported as-is cannot point a browser at someone else's machine.
export function proxyImportExampleList() {
  return [
    '# Example proxy list for EasyDeck.',
    '# One proxy per line. Lines starting with # are ignored.',
    '#',
    '# host:port:username:password -- what most vendors hand out.',
    '198.51.100.10:1080:proxy-user:proxy-pass',
    '198.51.100.11:1080:proxy-user:proxy-pass',
    '',
    '# The same four fields with commas, semicolons, tabs or pipes between them.',
    '198.51.100.12,1080,proxy-user,proxy-pass',
    '198.51.100.13;1080;proxy-user;proxy-pass',
    '',
    '# Credentials in front of the host, either way round the @ falls.',
    'proxy-user:proxy-pass@198.51.100.14:1080',
    '198.51.100.15:1080@proxy-user:proxy-pass',
    '',
    '# No credentials? Leave them off, or leave the trailing colons empty.',
    '203.0.113.20:8080',
    '203.0.113.21:8080::',
    '',
    '# A scheme in front sets that line\'s type on its own, whatever the Type',
    '# selector in the dialog says.',
    'http://203.0.113.30:3128:shop-eu:s3cret',
    'socks5://198.51.100.40:9050:warmup:pa55',
    '',
    '# A hostname works exactly like an IP.',
    'gate.example-proxies.test:7000:rotating-user:rotating-pass',
    '',
  ].join('\n');
}

// The headed form, for the other half of what people are handed: a spreadsheet.
// Its columns are the canonical names, but the importer matches every alias in
// COLUMN_ALIASES -- "IP"/"Port"/"Login"/"Pass" reads the same as this does, in
// any column order.
//
// A `type` column is included because it is the one thing a headed file can say
// that the dialog's single Type selector cannot: a mixed list of HTTP and SOCKS5
// endpoints has no one answer, and a row that names its own protocol keeps it.
export function proxyImportExampleCsv() {
  return [
    'name,type,host,port,username,password',
    'Berlin 1,socks5,198.51.100.10,1080,proxy-user,proxy-pass',
    'Berlin 2,socks5,198.51.100.11,1080,proxy-user,proxy-pass',
    'Shop EU,http,203.0.113.30,3128,shop-eu,s3cret',
    // No credentials on this one, and a password with a comma in it on the
    // next -- both round-trip, the second because the cell is quoted.
    'Open relay,http,203.0.113.20,8080,,',
    'Rotating,socks5,gate.example-proxies.test,7000,rotating-user,"pa55,word"',
    '',
  ].join('\n');
}
