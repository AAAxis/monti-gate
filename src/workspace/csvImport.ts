// Reading a profile inventory CSV, in two passes.
//
// previewCsvImport() is pure and writes nothing -- not even an id for a profile
// it would create. It reports what each row says, what is wrong with it, and
// which existing proxy or profile it lines up with, so the import dialog can
// show the file as a table and let the user fix it before anything is written.
// planCsvImport() then takes the reviewed rows and turns them into the exact
// set of records to save.
//
// The split is not decorative. It is what F16 specified (PreviewImport "without
// creating anything", then CommitImport), and the single-pass version it
// replaces had no way to say "this row needs a proxy" other than to skip the
// row -- which it then did not actually do, so ten rows were reported as
// skipped and created at the same time.
import {columnValue} from '../data/importTemplate';
import {defaultProxyName, parseProxyLink, proxyDedupeKey, proxyDedupeKeys} from '../lib/proxies';
import {isFsSafeId} from '../lib/trash';
import {MAX_PROFILE_TAGS, normalizeTags} from '../lib/tags';
import {fingerprintFromDraftPatch, newProfileDraft, tagsFromDraft} from '../drafts';
import {
  AUTO_FROM_PROXY,
  browserVersionPresets,
  fingerprintPatchForOs,
  languagePresets,
  osPresets,
  timezoneGroups,
} from '../lib/fingerprintPresets';
import {randomProfileColor} from '../lib/profileColors';
import {newId} from './core';
import type {ParsedCsvRow} from '../lib/csv';
import type {ScoutFolder, ScoutProfile, ScoutProxy, ProxyMode} from '../types';

// The library a row is being read against. Passed in rather than reached for so
// the whole module stays pure and testable without a workspace.
export type ImportLibrary = {
  profiles: ScoutProfile[];
  proxies: ScoutProxy[];
  folders: ScoutFolder[];
};

// Which input a problem belongs to, so the dialog can highlight that field
// instead of printing a sentence. `blocking` is the difference between "this
// row cannot be written" and "this row will be written, but not the way the
// file asked" -- an unreadable timezone is worth saying out loud and is not
// worth throwing a profile away over.
export type ImportIssue = {
  field: 'name' | 'profile_id' | 'proxy_name' | 'tags' | 'created_at' |
    'os' | 'browser_version' | 'language' | 'timezone';
  blocking: boolean;
  message: string;
  // What the file actually said, for the dialog to put back in the field it
  // highlights.
  value: string;
};

// The editable state of one row. Kept alongside the resolved row so the dialog
// can hand back a correction and get a freshly validated row out -- see
// reviseRow. Strings rather than parsed values on purpose: this is what is
// bound to the inputs.
export type ImportRowInput = {
  line: number;
  name: string;
  profileId: string;
  status: string;
  folder: string;
  tagsText: string;
  startUrl: string;
  createdAt: string;
  proxyMode: ProxyMode;
  // The connection string, from the file or retyped by the user.
  proxyText: string;
  // An existing proxy picked explicitly in the dialog. Wins over proxyText,
  // which is what "suggest one of my proxies" needs in order to override a
  // line that would not parse.
  proxyId: string;
  os: string;
  browserVersion: string;
  userAgent: string;
  language: string;
  timezone: string;
};

export type ImportRow = {
  input: ImportRowInput;
  line: number;
  name: string;
  profileId: string;
  status: string;
  folder: string;
  tags: string[];
  startUrl: string | null;
  createdAt: string;
  proxyMode: ProxyMode;
  // The proxy this row wants, parsed. Null when the row names none, which is
  // only a problem when proxyMode is 'assigned'.
  proxy: Omit<ScoutProxy, 'id' | 'name'> | null;
  // The existing proxy this row's proxy is the same as, if any -- so the
  // preview can say "reused" without having decided to write anything.
  matchedProxyId: string | null;
  // Set when the matched proxy's stored password differs from the one in the
  // file. Committing updates the stored proxy rather than discarding the new
  // password, which is what used to happen.
  updatesProxyPassword: boolean;
  fingerprint: NonNullable<ScoutProfile['fingerprint']>;
  // The existing profile this row would update, matched by profile_id.
  updatesProfileId: string | null;
  tagsTrimmed: boolean;
  issues: ImportIssue[];
  blocked: boolean;
};

// One distinct folder value the file asked for. Deliberately not acted on:
// naming and creating folders is a decision the user makes after seeing the
// table, so all this does is say what the file wants and whether a folder of
// that name is already there.
export type ImportFolderRequest = {
  name: string;
  existingFolderId: string | null;
  rowCount: number;
};

export type ImportPreview = {
  rows: ImportRow[];
  folders: ImportFolderRequest[];
  createCount: number;
  updateCount: number;
  blockedCount: number;
  newProxyCount: number;
  reusedProxyCount: number;
};

// What to do with the folder column, decided in the dialog rather than here.
export type FolderDecision =
  | {kind: 'unfiled'}
  | {kind: 'existing'; folderId: string}
  | {kind: 'new'; name: string}
  | {kind: 'per-row'};

export type ImportResult = {
  created: number;
  updated: number;
  proxiesCreated: number;
  proxiesReused: number;
  // Existing proxies whose stored password the file replaced.
  proxiesUpdated: number;
  foldersCreated: number;
  // Rows that carried more than MAX_PROFILE_TAGS tags and had the extras
  // dropped. Reported rather than silently trimmed: a CSV written against
  // another tool has no reason to know this app's limit, and losing a tag
  // without being told is the kind of thing found weeks later.
  tagsTrimmed: number;
  skipped: Array<{name: string; reason: string}>;
  // True when the write stopped partway. The counts above are then what was
  // planned, not what landed.
  partial?: boolean;
  // The ids of profiles this import CREATED, as opposed to updated.
  //
  // Filled in by importFromCsv rather than by planCsvImport, which is why it is
  // optional: the planner is pure and cannot know which inserts reached the
  // database. A partial write must not hand back ids it never wrote, because
  // the caller's next act is to assign them to somebody.
  //
  // Created only. Rows the import updated already belong to whoever holds them,
  // and re-pointing a colleague's profile because you re-imported an export is
  // not something the dialog asked for.
  createdIds?: string[];
};

export type ImportPlan = {
  profiles: ScoutProfile[];
  proxies: ScoutProxy[];
  folders: ScoutFolder[];
  upsertProxies: ScoutProxy[];
  newFolders: ScoutFolder[];
  touchedProfiles: Array<{profile: ScoutProfile; exists: boolean}>;
  result: ImportResult;
};

// The row the exporter writes for one profile, in the columns importColumns
// names and the formats the parsers above accept. It lives here, next to the
// reader, because the two used to disagree and nothing said so: the exporter
// wrote `proxy` and `status` while the reader looked for `proxy_name` and
// `status_name`, and a file this app produced could not be fed back into it.
export function profileExportRow(
    profile: ScoutProfile,
    proxy: ScoutProxy | null,
    folder: ScoutFolder | null): Record<string, string> {
  return {
    name: profile.name || '',
    // Without an id the file cannot update what it came from: re-importing
    // minted new ids and duplicated every profile rather than reclaiming its
    // browser directory, cookies and sessions.
    profile_id: profile.id,
    status_name: profile.status || '',
    folder: folder?.name || '',
    // Credentials included. Dropping them left a string the reader could not
    // parse *and* changed its dedupe key, so a re-import could neither read the
    // proxy nor recognise it as one already saved. Plaintext is this app's
    // existing model for proxy credentials -- the proxy exporter next door
    // writes a bare `password` column.
    proxy_name: proxy ?
      `${proxy.type || 'http'}://${proxy.host}:${proxy.port}` +
        `:${proxy.username || ''}:${proxy.password || ''}` :
      '',
    // So a profile that deliberately runs without a proxy round-trips as
    // deliberate, rather than as a row whose proxy went missing.
    proxy_mode: profile.proxy_mode || 'assigned',
    // Comma, not the semicolon this used to write: tagsFromDraft splits on
    // commas, so "a; b; c" came back as a single tag called "a; b; c".
    tags: profile.tags?.join(', ') || '',
    start_url: profile.start_url || '',
    created_at: profile.created_at || '',
    os: profile.fingerprint?.os || '',
    browser_version: profile.fingerprint?.browser_version || '',
    user_agent: profile.fingerprint?.user_agent || '',
    language: profile.fingerprint?.language || '',
    timezone: profile.fingerprint?.timezone || '',
  };
}

const timezoneNames = new Set([
  AUTO_FROM_PROXY,
  ...timezoneGroups.flatMap((group) => group.zones.map((zone) => zone.name)),
]);

// Commas, but semicolons too. tagsFromDraft splits on commas alone, which is
// right for the editor's own field -- but this app's export used to join tags
// with "; ", so every re-imported file arrived with one tag named
// "order8470416; migration; facebook". The exporter writes commas now; this is
// what makes the files it already wrote readable.
function tagsFromCsv(value: string) {
  return tagsFromDraft(value.replace(/;/g, ','));
}

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function proxyModeFrom(value: string): ProxyMode {
  return value === 'direct' || value === 'free_proxy' ? value : 'assigned';
}

// Reads one parsed CSV row into the editable shape, resolving every column
// through its aliases so a file exported before the column names were aligned
// still lands in the right fields.
export function importRowInput({row, line}: ParsedCsvRow): ImportRowInput {
  return {
    line,
    name: columnValue(row, 'name'),
    profileId: columnValue(row, 'profile_id'),
    status: columnValue(row, 'status_name'),
    folder: columnValue(row, 'folder'),
    tagsText: columnValue(row, 'tags'),
    startUrl: columnValue(row, 'start_url'),
    createdAt: columnValue(row, 'created_at'),
    proxyMode: proxyModeFrom(columnValue(row, 'proxy_mode')),
    proxyText: columnValue(row, 'proxy_name'),
    proxyId: '',
    os: columnValue(row, 'os'),
    browserVersion: columnValue(row, 'browser_version'),
    userAgent: columnValue(row, 'user_agent'),
    language: columnValue(row, 'language'),
    timezone: columnValue(row, 'timezone'),
  };
}

// The fingerprint a row describes.
//
// Built through the draft machinery the editor uses rather than a second
// hardcoded table: fingerprintPatchForOs picks a coherent device identity for
// the platform, and only the columns the file actually set are laid over it.
// The version this replaces ignored the os/user_agent/language/timezone columns
// entirely and stamped every imported profile as Windows 11 -- so a re-imported
// Android profile came back as a desktop, carrying a mobile user-agent it no
// longer matched.
function fingerprintFor(input: ImportRowInput, issues: ImportIssue[]) {
  // normalizeOsPreset() is deliberately not used here: it answers 'macOS' for
  // anything it does not recognise, so a file with no os column at all would
  // silently turn every profile into a Mac.
  const os = osPresets.includes(input.os) ? input.os : '';
  if (input.os && !os) {
    issues.push({
      field: 'os',
      blocking: false,
      message: `Unknown OS "${input.os}" — using ${newProfileDraft().fingerprint_os}`,
      value: input.os,
    });
  }
  const patch = {...newProfileDraft(), ...(os ? fingerprintPatchForOs(os) : {})};
  if (os) {
    patch.fingerprint_os = os;
  }
  if (input.browserVersion) {
    if (browserVersionPresets.includes(input.browserVersion)) {
      patch.fingerprint_browser_version = input.browserVersion;
    } else {
      issues.push({
        field: 'browser_version',
        blocking: false,
        message: `Unknown browser version "${input.browserVersion}" — using Auto`,
        value: input.browserVersion,
      });
    }
  }
  if (input.language) {
    if (languagePresets.includes(input.language)) {
      patch.fingerprint_language = input.language;
    } else {
      issues.push({
        field: 'language',
        blocking: false,
        message: `Unknown language "${input.language}" — using ${AUTO_FROM_PROXY}`,
        value: input.language,
      });
    }
  }
  if (input.timezone) {
    if (timezoneNames.has(input.timezone)) {
      patch.fingerprint_timezone = input.timezone;
    } else {
      issues.push({
        field: 'timezone',
        blocking: false,
        message: `Unknown timezone "${input.timezone}" — using ${AUTO_FROM_PROXY}`,
        value: input.timezone,
      });
    }
  }
  // Free text, unlike everything above it -- there is no list of valid
  // user-agents to check against, and an exported one is the whole point of
  // carrying the column.
  if (input.userAgent) {
    patch.fingerprint_user_agent = input.userAgent;
  }
  return fingerprintFromDraftPatch(patch);
}

// Validates one row against the library. Pure, and safe to call again on every
// keystroke -- which is what makes "fix it in the table" possible.
export function resolveRow(input: ImportRowInput, library: ImportLibrary): ImportRow {
  const issues: ImportIssue[] = [];

  if (!input.name) {
    issues.push({field: 'name', blocking: true, message: 'Missing name', value: ''});
  }

  // profile_id is written verbatim on purpose: re-creating a profile with its
  // exact original id is what reclaims an existing browser directory, cookies
  // and logged-in sessions intact. Which is also why a malformed one has to be
  // refused here rather than quietly renumbered.
  if (input.profileId && !isFsSafeId(input.profileId)) {
    issues.push({
      field: 'profile_id',
      blocking: true,
      message: `Profile id "${input.profileId}" can't be a folder name ` +
        '(letters, digits, dot, dash and underscore only)',
      value: input.profileId,
    });
  }

  const chosen = input.proxyId ?
    library.proxies.find((proxy) => proxy.id === input.proxyId) || null :
    null;
  const parsed = chosen ?
    {type: chosen.type, host: chosen.host, port: chosen.port,
      username: chosen.username, password: chosen.password} :
    parseProxyLink(input.proxyText);
  if (input.proxyMode === 'assigned' && !parsed) {
    issues.push({
      field: 'proxy_name',
      blocking: true,
      message: input.proxyText ?
        `Could not read a proxy from "${input.proxyText}"` :
        'No proxy',
      value: input.proxyText,
    });
  }

  let matchedProxyId: string | null = chosen?.id || null;
  let updatesProxyPassword = false;
  if (parsed && !matchedProxyId) {
    const key = proxyDedupeKey(
        parsed.type || 'socks5', parsed.host, parsed.port, parsed.username || '');
    const match = library.proxies.find((proxy) => proxyDedupeKeys(proxy).includes(key));
    matchedProxyId = match?.id || null;
    // Password is not part of the dedupe key, so a rotated password would
    // otherwise match the old record and be dropped on the floor.
    updatesProxyPassword = Boolean(
        match && parsed.password && (match.password || '') !== parsed.password);
  }

  const csvTags = tagsFromCsv(input.tagsText);
  const tags = normalizeTags(csvTags);
  const tagsTrimmed = tags.length < csvTags.length;
  if (tagsTrimmed) {
    issues.push({
      field: 'tags',
      blocking: false,
      message: `Only the first ${MAX_PROFILE_TAGS} tags were kept`,
      value: input.tagsText,
    });
  }

  const parsedDate = Date.parse(input.createdAt);
  if (input.createdAt && !parsedDate) {
    issues.push({
      field: 'created_at',
      blocking: false,
      message: `Could not read the date "${input.createdAt}" — using the time of import`,
      value: input.createdAt,
    });
  }

  const existingProfile = input.profileId ?
    library.profiles.find((profile) => profile.id === input.profileId) || null :
    null;

  return {
    input,
    line: input.line,
    name: input.name,
    profileId: input.profileId,
    status: input.status || 'Ready',
    folder: input.folder,
    tags,
    startUrl: input.startUrl || null,
    createdAt: parsedDate ? new Date(parsedDate).toISOString() : '',
    proxyMode: input.proxyMode,
    proxy: parsed,
    matchedProxyId,
    updatesProxyPassword,
    fingerprint: fingerprintFor(input, issues),
    updatesProfileId: existingProfile?.id || null,
    tagsTrimmed,
    issues,
    blocked: issues.some((issue) => issue.blocking),
  };
}

// Re-validates a row after the user changed something in the table.
export function reviseRow(
    row: ImportRow, patch: Partial<ImportRowInput>, library: ImportLibrary): ImportRow {
  return resolveRow({...row.input, ...patch}, library);
}

export function previewCsvImport(
    parsed: ParsedCsvRow[], library: ImportLibrary): ImportPreview {
  const rows = parsed.map((entry) => resolveRow(importRowInput(entry), library));
  return {rows, ...summarize(rows, library)};
}

// The counters, recomputed from whatever the rows currently say. Split out so
// the dialog can call it after every correction without re-parsing the file.
export function summarize(rows: ImportRow[], library: ImportLibrary) {
  const folders = new Map<string, ImportFolderRequest>();
  // Proxies this file would add, keyed the same way the library is, so two rows
  // sharing one proxy count as one new proxy rather than two.
  const pendingProxies = new Set<string>();
  let createCount = 0;
  let updateCount = 0;
  let blockedCount = 0;
  let newProxyCount = 0;
  let reusedProxyCount = 0;

  for (const row of rows) {
    if (row.blocked) {
      blockedCount++;
      continue;
    }
    if (row.updatesProfileId) {
      updateCount++;
    } else {
      createCount++;
    }
    if (row.proxy) {
      if (row.matchedProxyId) {
        reusedProxyCount++;
      } else {
        const key = proxyDedupeKey(
            row.proxy.type || 'socks5', row.proxy.host, row.proxy.port, row.proxy.username || '');
        if (pendingProxies.has(key)) {
          reusedProxyCount++;
        } else {
          pendingProxies.add(key);
          newProxyCount++;
        }
      }
    }
    if (row.folder) {
      const request = folders.get(row.folder.toLowerCase()) || {
        name: row.folder,
        existingFolderId: library.folders.find((folder) =>
          sameName(folder.name, row.folder))?.id || null,
        rowCount: 0,
      };
      request.rowCount++;
      folders.set(row.folder.toLowerCase(), request);
    }
  }

  return {
    folders: [...folders.values()],
    createCount,
    updateCount,
    blockedCount,
    newProxyCount,
    reusedProxyCount,
  };
}

// Turns the reviewed rows into the exact records to write. Blocked rows are
// skipped here and only here -- nothing downstream has to remember to check.
export function planCsvImport(
    rows: ImportRow[], folderDecision: FolderDecision, library: ImportLibrary): ImportPlan {
  const profiles = [...library.profiles];
  const proxies = [...library.proxies];
  const folders = [...library.folders];
  // What this run actually has to write. Rows the CSV never mentioned are left
  // alone.
  const upsertProxies: ScoutProxy[] = [];
  const newFolders: ScoutFolder[] = [];
  const touchedProfiles: Array<{profile: ScoutProfile; exists: boolean}> = [];

  const result: ImportResult = {
    created: 0,
    updated: 0,
    proxiesCreated: 0,
    proxiesReused: 0,
    proxiesUpdated: 0,
    foldersCreated: 0,
    tagsTrimmed: 0,
    skipped: [],
  };

  const proxyIndexByKey = new Map<string, number>();
  proxies.forEach((proxy, index) => {
    proxyDedupeKeys(proxy).forEach((key) => proxyIndexByKey.set(key, index));
  });

  // One folder for the whole import, when that is what was decided. Created
  // once and reused, so a hundred rows do not make a hundred folders.
  const folderIdByName = new Map<string, string>();
  function folderIdFor(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) {
      return null;
    }
    const cached = folderIdByName.get(trimmed.toLowerCase());
    if (cached) {
      return cached;
    }
    const existing = folders.find((folder) =>
      (folder.kind || 'profile') === 'profile' && sameName(folder.name, trimmed));
    if (existing) {
      folderIdByName.set(trimmed.toLowerCase(), existing.id);
      return existing.id;
    }
    // The name is used exactly as given. The version this replaces wrote
    // `Imported ${value}` and matched it back with /^Imported (.+)$/, so a
    // second round-trip produced "Imported Imported 5 July".
    const folder: ScoutFolder = {
      id: newId(folders.length),
      name: trimmed,
      kind: 'profile',
      created_at: new Date().toISOString(),
    };
    folders.push(folder);
    newFolders.push(folder);
    folderIdByName.set(trimmed.toLowerCase(), folder.id);
    result.foldersCreated++;
    return folder.id;
  }

  for (const row of rows) {
    if (row.blocked) {
      result.skipped.push({
        name: row.name || row.profileId || '(unnamed)',
        reason: `Row ${row.line}: ${row.issues.filter((issue) => issue.blocking)
            .map((issue) => issue.message).join('; ')}`,
      });
      continue;
    }

    let proxyId: string | null = null;
    if (row.proxy) {
      const key = proxyDedupeKey(
          row.proxy.type || 'socks5', row.proxy.host, row.proxy.port, row.proxy.username || '');
      const existingIndex = proxyIndexByKey.get(key);
      if (existingIndex !== undefined) {
        const existing = proxies[existingIndex];
        proxyId = existing.id;
        result.proxiesReused++;
        if (row.updatesProxyPassword) {
          const updated = {...existing, password: row.proxy.password};
          proxies[existingIndex] = updated;
          upsertProxies.push(updated);
          result.proxiesUpdated++;
        }
      } else {
        const proxy: ScoutProxy = {
          id: newId(proxies.length),
          name: defaultProxyName(row.proxy.host, row.proxy.port),
          type: row.proxy.type,
          host: row.proxy.host,
          port: row.proxy.port,
          username: row.proxy.username || undefined,
          password: row.proxy.password || undefined,
        };
        proxies.push(proxy);
        upsertProxies.push(proxy);
        proxyDedupeKeys(proxy).forEach((each) => proxyIndexByKey.set(each, proxies.length - 1));
        proxyId = proxy.id;
        result.proxiesCreated++;
      }
    }

    let folderId: string | null = null;
    if (folderDecision.kind === 'existing') {
      folderId = folderDecision.folderId;
    } else if (folderDecision.kind === 'new') {
      folderId = folderIdFor(folderDecision.name);
    } else if (folderDecision.kind === 'per-row') {
      folderId = folderIdFor(row.folder);
    }

    const importId = row.profileId || newId();
    const existingIndex = profiles.findIndex((item) => item.id === importId);
    const existing = existingIndex >= 0 ? profiles[existingIndex] : null;
    if (row.tagsTrimmed) {
      result.tagsTrimmed++;
    }
    const profile: ScoutProfile = {
      id: importId,
      name: row.name,
      status: row.status,
      // An update keeps whatever colour the row already had; only a genuinely
      // new profile draws one, and it draws its own rather than sharing one
      // with the rest of the file -- importing 200 rows that all launch the
      // same blue tile is exactly the case the per-profile icon is for.
      color: existing?.color ?? randomProfileColor(),
      folder_id: folderId,
      proxy_id: proxyId,
      proxy_mode: row.proxyMode,
      tags: row.tags,
      start_url: row.startUrl,
      cookie_import_path: null,
      cookie_import_url: null,
      cookie_import_name: null,
      cookie_import_count: null,
      command_line_switches: null,
      // An update keeps the fingerprint the profile already has: it is the
      // identity a logged-in session was built on, and the CSV is not a good
      // enough reason to change it out from under one.
      fingerprint: existing?.fingerprint ?? row.fingerprint,
      created_at: existing?.created_at ?? (row.createdAt || new Date().toISOString()),
    };
    if (existing) {
      profiles[existingIndex] = profile;
      result.updated++;
    } else {
      profiles.push(profile);
      result.created++;
    }
    touchedProfiles.push({profile, exists: Boolean(existing)});
  }

  return {profiles, proxies, folders, upsertProxies, newFolders, touchedProfiles, result};
}
