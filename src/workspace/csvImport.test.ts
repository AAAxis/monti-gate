import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseCsv, toCsv} from '../lib/csv';
import {importColumns, profileImportExampleCsv} from '../data/importTemplate';
import {
  planCsvImport, previewCsvImport, profileExportRow, resolveRow, reviseRow,
} from './csvImport';
import type {FolderDecision, ImportLibrary} from './csvImport';
import type {ScoutFolder, ScoutProfile, ScoutProxy} from '../types';

const empty: ImportLibrary = {profiles: [], proxies: [], folders: []};

function preview(csv: string, library: ImportLibrary = empty) {
  return previewCsvImport(parseCsv(csv), library);
}

function commit(
    csv: string,
    library: ImportLibrary = empty,
    folder: FolderDecision = {kind: 'per-row'}) {
  return planCsvImport(preview(csv, library).rows, folder, library);
}

// The file the user actually hit this with: an export from this app, which its
// own importer then refused row by row.
const legacyCsv = readFileSync(
    join(__dirname, '__fixtures__', 'legacy-profiles-export.csv'), 'utf8');

describe('the exported file this importer used to reject', () => {
  it('reads every row', () => {
    const result = preview(legacyCsv);
    expect(result.rows).toHaveLength(10);
    expect(result.blockedCount).toBe(0);
    expect(result.rows.flatMap((row) => row.issues.filter((issue) => issue.blocking))).toEqual([]);
  });

  // The exact symptom: `proxy` vs `proxy_name` meant the reader parsed an empty
  // string and reported the word "unknown", which appears nowhere in the file.
  it('finds the proxy in the legacy `proxy` column', () => {
    const [first] = preview(legacyCsv).rows;
    expect(first.proxy).toMatchObject({type: 'socks5', host: '204.252.87.159', port: 47403});
  });

  it('finds the status in the legacy `status` column', () => {
    expect(preview(legacyCsv).rows.every((row) => row.status === 'Review')).toBe(true);
  });

  it('splits semicolon-separated tags from the legacy export', () => {
    const row = preview(legacyCsv).rows.find((item) => item.name.startsWith('satisha'));
    expect(row?.tags).toEqual(['order8470416', 'migration', 'facebook']);
  });

  it('keeps the Android rows on Android with their own user-agent', () => {
    const row = preview(legacyCsv).rows.find((item) => item.name.startsWith('satisha'));
    expect(row?.fingerprint.os).toBe('Android');
    expect(row?.fingerprint.user_agent).toContain('Android 10; K');
  });

  it('creates ten profiles and ten proxies, and skips nothing', () => {
    const {result} = commit(legacyCsv);
    expect(result.created).toBe(10);
    expect(result.proxiesCreated).toBe(10);
    expect(result.skipped).toEqual([]);
    // The bug that made this urgent: rows counted as skipped *and* created, the
    // profile written with no proxy at all.
    expect(result.created + result.skipped.length).toBe(10);
  });

  it('files nothing anywhere unless asked', () => {
    const {result, touchedProfiles} = commit(legacyCsv, empty, {kind: 'unfiled'});
    expect(result.foldersCreated).toBe(0);
    expect(touchedProfiles.every(({profile}) => profile.folder_id === null)).toBe(true);
  });

  it('uses the folder name verbatim, with no "Imported" prefix', () => {
    const {newFolders} = commit(legacyCsv);
    expect(newFolders.map((folder) => folder.name).sort()).toEqual(['5 July', '8 July']);
  });
});

describe('required columns', () => {
  it('blocks a row with no name', () => {
    const [row] = preview('name,proxy_name\n,socks5://1.2.3.4:1080').rows;
    expect(row.blocked).toBe(true);
    expect(row.issues[0]).toMatchObject({field: 'name', blocking: true});
  });

  it('blocks a row whose proxy will not parse, and says which line', () => {
    const {result} = commit('name,proxy_name\nAlice,nonsense');
    expect(result.created).toBe(0);
    expect(result.skipped[0].reason).toContain('Row 2');
    expect(result.skipped[0].reason).toContain('nonsense');
  });

  // A profile that wants no proxy is not a profile whose proxy went missing.
  it('allows a proxy-less row when proxy_mode is direct', () => {
    const {result, touchedProfiles} = commit('name,proxy_mode\nAlice,direct');
    expect(result.created).toBe(1);
    expect(touchedProfiles[0].profile.proxy_id).toBeNull();
    expect(touchedProfiles[0].profile.proxy_mode).toBe('direct');
  });

  it('blocks a profile_id that cannot be a directory name', () => {
    const [bad] = preview('name,proxy_name,profile_id\nA,1.2.3.4:1,../escape').rows;
    expect(bad.blocked).toBe(true);
    expect(bad.issues.some((issue) => issue.field === 'profile_id' && issue.blocking)).toBe(true);
  });
});

describe('fingerprint columns', () => {
  // normalizeOsPreset() answers 'macOS' for anything it does not recognise, so
  // reaching for it here would have turned every profile in a file with no os
  // column into a Mac.
  it('does not turn a missing OS into macOS', () => {
    const [row] = preview('name,proxy_name\nAlice,1.2.3.4:1080').rows;
    expect(row.fingerprint.os).toBe('Windows 11');
  });

  it('reports an unknown OS without blocking the row', () => {
    const [row] = preview('name,proxy_name,os\nAlice,1.2.3.4:1080,Solaris').rows;
    expect(row.blocked).toBe(false);
    expect(row.issues.some((issue) => issue.field === 'os')).toBe(true);
    expect(row.fingerprint.os).toBe('Windows 11');
  });

  it('reports an unknown timezone without blocking the row', () => {
    const [row] = preview('name,proxy_name,timezone\nAlice,1.2.3.4:1080,Mars/Olympus').rows;
    expect(row.blocked).toBe(false);
    expect(row.issues.some((issue) => issue.field === 'timezone')).toBe(true);
  });

  it('keeps a recognised timezone', () => {
    const [row] = preview('name,proxy_name,timezone\nAlice,1.2.3.4:1080,Europe/Berlin').rows;
    expect(row.fingerprint.timezone).toBe('Europe/Berlin');
  });
});

describe('proxies', () => {
  const existing: ScoutProxy = {
    id: 'p1', name: 'p1', type: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'a',
  };

  it('reuses a proxy already in the library', () => {
    const {result} = commit('name,proxy_name\nAlice,socks5://1.2.3.4:1080:u:a',
        {...empty, proxies: [existing]});
    expect(result.proxiesReused).toBe(1);
    expect(result.proxiesCreated).toBe(0);
  });

  it('matches an untyped legacy proxy rather than duplicating it', () => {
    const untyped = {...existing, type: undefined};
    const {result} = commit('name,proxy_name\nAlice,socks5://1.2.3.4:1080:u:a',
        {...empty, proxies: [untyped]});
    expect(result.proxiesCreated).toBe(0);
    expect(result.proxiesReused).toBe(1);
  });

  // The password is not part of the dedupe key, so a rotated one used to match
  // the old record and be dropped on the floor.
  it('updates a stored password instead of discarding the new one', () => {
    const {result, upsertProxies} = commit('name,proxy_name\nAlice,socks5://1.2.3.4:1080:u:NEW',
        {...empty, proxies: [existing]});
    expect(result.proxiesUpdated).toBe(1);
    expect(upsertProxies[0].password).toBe('NEW');
  });

  it('counts one proxy shared by two rows once', () => {
    const {result} = commit(
        'name,proxy_name\nA,socks5://1.2.3.4:1080\nB,socks5://1.2.3.4:1080');
    expect(result.proxiesCreated).toBe(1);
    expect(result.proxiesReused).toBe(1);
  });
});

describe('reviseRow', () => {
  it('clears the proxy problem when the user retypes it', () => {
    const [row] = preview('name,proxy_name\nAlice,nonsense').rows;
    expect(row.blocked).toBe(true);
    const fixed = reviseRow(row, {proxyText: 'socks5://1.2.3.4:1080'}, empty);
    expect(fixed.blocked).toBe(false);
    expect(fixed.proxy).toMatchObject({host: '1.2.3.4', port: 1080});
  });

  it('accepts one of the library proxies instead', () => {
    const proxy: ScoutProxy = {id: 'p9', name: 'p9', type: 'http', host: '9.9.9.9', port: 80};
    const library = {...empty, proxies: [proxy]};
    const [row] = previewCsvImport(parseCsv('name,proxy_name\nAlice,nonsense'), library).rows;
    const fixed = reviseRow(row, {proxyId: 'p9'}, library);
    expect(fixed.blocked).toBe(false);
    expect(fixed.matchedProxyId).toBe('p9');
  });
});

describe('folders', () => {
  const csv = 'name,proxy_name,folder\nA,1.2.3.4:1,Team\nB,1.2.3.4:2,Team';

  it('reports what the file asks for without creating it', () => {
    const result = preview(csv);
    expect(result.folders).toEqual([{name: 'Team', existingFolderId: null, rowCount: 2}]);
  });

  it('matches an existing folder by name, case-insensitively', () => {
    const folder: ScoutFolder = {id: 'f1', name: 'team'};
    const {result, touchedProfiles} = commit(csv, {...empty, folders: [folder]});
    expect(result.foldersCreated).toBe(0);
    expect(touchedProfiles.every(({profile}) => profile.folder_id === 'f1')).toBe(true);
  });

  it('makes one folder for two rows that share a name', () => {
    expect(commit(csv).result.foldersCreated).toBe(1);
  });

  it('puts everything in one chosen folder when told to', () => {
    const {touchedProfiles} = commit(csv, empty, {kind: 'existing', folderId: 'chosen'});
    expect(touchedProfiles.every(({profile}) => profile.folder_id === 'chosen')).toBe(true);
  });
});

describe('updating by profile_id', () => {
  const existing: ScoutProfile = {
    id: 'keep-me',
    name: 'Old',
    created_at: '2020-01-01T00:00:00.000Z',
    fingerprint: {os: 'iOS', user_agent: 'iphone'},
  };

  it('updates rather than duplicating, and keeps the identity it had', () => {
    const {result, touchedProfiles} = commit(
        'name,proxy_name,profile_id\nNew,1.2.3.4:1,keep-me',
        {...empty, profiles: [existing]});
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    expect(touchedProfiles[0].profile.name).toBe('New');
    // The fingerprint is what a logged-in session was built on; a CSV is not a
    // good enough reason to change it out from under one.
    expect(touchedProfiles[0].profile.fingerprint?.os).toBe('iOS');
    expect(touchedProfiles[0].profile.created_at).toBe('2020-01-01T00:00:00.000Z');
  });
});

// Who a profile is assigned to is set in the app, by a person looking at a
// roster -- never by a file. A CSV can only carry a name or an email, and one
// from another tool names people who are not on this team at all, so honouring
// such a column would import a screenful of "Former member".
//
// The import dialog's own "Assign these profiles to" picker is the supported
// way to do this, and it applies to created rows only.
describe('an assignee column in the file', () => {
  const teammate = '11111111-1111-1111-1111-111111111111';

  it('is ignored under every name it might arrive under', () => {
    const {touchedProfiles} = commit(
        'name,proxy_mode,assigned_to,assignee,owner,assigned\n' +
        `A,direct,${teammate},anna@example.com,Anna,Anna`);
    expect(touchedProfiles).toHaveLength(1);
    expect(touchedProfiles[0].profile.assigned_to).toBeUndefined();
  });

  // The column list is the contract the Source step prints and the example CSV
  // round-trips. Adding an assignee to it later would silently start honouring
  // files that name people, so the absence is pinned rather than assumed.
  it('is not one of the documented columns', () => {
    const names = importColumns.map((column) => column.name);
    expect(names).not.toContain('assigned_to');
    expect(names).not.toContain('assignee');
    expect(names).not.toContain('owner');
  });

  // An assignment must not survive an export→import round trip either: the
  // exporting workspace's user ids mean nothing in the importing one.
  it('is not written out by the exporter', () => {
    const row = profileExportRow(
        {id: 'a', name: 'A', proxy_mode: 'direct', assigned_to: teammate}, null, null);
    expect(Object.keys(row)).not.toContain('assigned_to');
    expect(Object.values(row)).not.toContain(teammate);
  });
});

// createdIds, which the import dialog assigns, is derived from this flag in
// useProfileActions.importFromCsv. A row that flipped to exists=true would be
// an update quietly taking on the importer's chosen assignee.
describe('which rows count as created', () => {
  const existing: ScoutProfile = {id: 'keep-me', name: 'Old'};

  it('marks new rows as inserts and matched rows as updates', () => {
    const {touchedProfiles} = commit(
        'name,proxy_mode,profile_id\nNew,direct,\nOld,direct,keep-me',
        {...empty, profiles: [existing]});
    const inserted = touchedProfiles.filter(({exists}) => !exists);
    const updated = touchedProfiles.filter(({exists}) => exists);
    expect(inserted.map(({profile}) => profile.name)).toEqual(['New']);
    expect(updated.map(({profile}) => profile.id)).toEqual(['keep-me']);
  });
});

describe('tags', () => {
  it('trims past the limit and says so without blocking', () => {
    const [row] = preview('name,proxy_name,tags\nA,1.2.3.4:1,"a, b, c, d, e, f"').rows;
    expect(row.tags).toHaveLength(5);
    expect(row.blocked).toBe(false);
    expect(row.issues.some((issue) => issue.field === 'tags')).toBe(true);
    expect(commit('name,proxy_name,tags\nA,1.2.3.4:1,"a, b, c, d, e, f"').result.tagsTrimmed)
        .toBe(1);
  });
});

describe('export round-trip', () => {
  const proxy: ScoutProxy = {
    id: 'p1', name: 'p1', type: 'socks5', host: '5.6.7.8', port: 9050,
    username: 'user', password: 'p@ss',
  };
  const folder: ScoutFolder = {id: 'f1', name: 'Storefronts'};
  const profile: ScoutProfile = {
    id: 'shop-eu-002',
    name: 'Shop, EU "02"',
    status: 'Review',
    folder_id: 'f1',
    proxy_id: 'p1',
    proxy_mode: 'assigned',
    tags: ['shop', 'eu'],
    start_url: 'https://example.test/',
    created_at: '2026-06-18T20:56:00.000Z',
    fingerprint: {
      os: 'Android',
      browser_version: 'Auto',
      user_agent: 'Mozilla/5.0 (Linux; Android 10; K), like Gecko',
      language: 'Auto from proxy',
      timezone: 'Europe/Berlin',
    },
  };
  const library: ImportLibrary = {profiles: [profile], proxies: [proxy], folders: [folder]};
  const csv = toCsv(importColumns.map((column) => column.name), [profile],
      (item) => profileExportRow(item, proxy, folder));

  it('exports a file its own reader accepts', () => {
    const result = preview(csv, library);
    expect(result.blockedCount).toBe(0);
    expect(result.rows[0].issues).toEqual([]);
  });

  it('updates the profile it came from instead of duplicating it', () => {
    const {result} = planCsvImport(preview(csv, library).rows, {kind: 'per-row'}, library);
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
  });

  it('reuses the proxy and the folder rather than making new ones', () => {
    const {result} = planCsvImport(preview(csv, library).rows, {kind: 'per-row'}, library);
    expect(result.proxiesCreated).toBe(0);
    expect(result.proxiesReused).toBe(1);
    expect(result.proxiesUpdated).toBe(0);
    expect(result.foldersCreated).toBe(0);
  });

  it('preserves every field it claims to carry', () => {
    const [row] = preview(csv, library).rows;
    expect(row.name).toBe('Shop, EU "02"');
    expect(row.status).toBe('Review');
    expect(row.folder).toBe('Storefronts');
    expect(row.tags).toEqual(['shop', 'eu']);
    expect(row.startUrl).toBe('https://example.test/');
    expect(row.createdAt).toBe('2026-06-18T20:56:00.000Z');
    expect(row.proxy).toMatchObject({host: '5.6.7.8', port: 9050, username: 'user', password: 'p@ss'});
    expect(row.fingerprint.os).toBe('Android');
    expect(row.fingerprint.user_agent).toBe('Mozilla/5.0 (Linux; Android 10; K), like Gecko');
    expect(row.fingerprint.timezone).toBe('Europe/Berlin');
  });

  it('survives a second round-trip unchanged', () => {
    const committed = planCsvImport(preview(csv, library).rows, {kind: 'per-row'}, library);
    const again = toCsv(importColumns.map((column) => column.name),
        committed.touchedProfiles.map(({profile: item}) => item),
        (item) => profileExportRow(item, proxy, folder));
    expect(again).toBe(csv);
    // The old importer renamed folders to "Imported <name>" on the way in, so a
    // second pass produced "Imported Imported 5 July".
    expect(planCsvImport(preview(again, library).rows, {kind: 'per-row'}, library)
        .result.foldersCreated).toBe(0);
  });
});

// F16's definition of done: "Download the template yields a header CSV that
// round-trips back through import." It did not -- the example advertised a
// "host:port::" proxy shape and column names the exporter never wrote.
describe('the downloadable example', () => {
  it('imports cleanly', () => {
    const result = preview(profileImportExampleCsv());
    expect(result.blockedCount).toBe(0);
    expect(result.rows.flatMap((row) => row.issues)).toEqual([]);
  });

  it('covers the proxy shapes it claims to', () => {
    const [withCreds, withoutCreds, noProxy] = preview(profileImportExampleCsv()).rows;
    expect(withCreds.proxy).toMatchObject({username: 'proxy-user', password: 'proxy-pass'});
    expect(withoutCreds.proxy).toMatchObject({type: 'http', port: 8080});
    expect(noProxy.proxy).toBeNull();
    expect(noProxy.proxyMode).toBe('direct');
  });
});

describe('resolveRow', () => {
  it('is pure: previewing mints nothing and writes nothing', () => {
    const library: ImportLibrary = {profiles: [], proxies: [], folders: []};
    const result = previewCsvImport(parseCsv('name,proxy_name\nA,1.2.3.4:1080'), library);
    expect(library.profiles).toEqual([]);
    expect(library.proxies).toEqual([]);
    expect(result.rows[0].profileId).toBe('');
  });

  it('gives the same answer twice for the same input', () => {
    const input = {
      line: 2, name: 'A', profileId: 'a', status: '', folder: '', tagsText: '',
      startUrl: '', createdAt: '', proxyMode: 'assigned' as const,
      proxyText: '1.2.3.4:1080', proxyId: '', os: 'Ubuntu', browserVersion: '',
      userAgent: '', language: '', timezone: '',
    };
    expect(resolveRow(input, empty).fingerprint).toEqual(resolveRow(input, empty).fingerprint);
  });
});
