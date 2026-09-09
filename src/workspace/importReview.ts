// The review layer between the CSV engine and the import dialog.
//
// csvImport.ts owns parsing, validation and planning, and this module does not
// duplicate any of it: every correction here is expressed as a reviseRow()
// patch, so the engine stays the single place that decides what a row means.
// What lives here is what the *review screen* needs and a pure parse of a file
// cannot know on its own:
//
//   - a credential-less proxy line should reuse the credentials already saved
//     for that host and port, rather than importing a copy that cannot connect;
//   - a row whose name already exists is probably the same profile coming back,
//     which is a choice to offer rather than a duplicate to create silently;
//   - an empty proxy can be filled from proxies the library is not using;
//   - a folder value is a suggestion until someone says what to do with it.
//
// All of it is pure and synchronous, so the dialog can call it on every
// keystroke and so it can be tested without a workspace or a browser.
import {reviseRow} from './csvImport';
import {formatProxyLink, isProxyAssigned, parseProxyLink} from '../lib/proxies';
import type {ImportLibrary, ImportRow, ImportRowInput} from './csvImport';
import type {ScoutProxy} from '../types';

// What to do about a row whose name matches a profile that already exists.
// 'update' is the default because the common case is an export coming back --
// re-importing a file this app wrote should reclaim its profiles, not clone
// them.
export type DuplicateAction = 'update' | 'new' | 'skip';

export type ReviewRow = {
  row: ImportRow;
  // The existing profile this row's *name* collides with. Only ever set when
  // the file gave no profile_id: an explicit id is a stronger statement than a
  // matching name, and the engine already acts on it.
  nameMatch: {id: string; name: string} | null;
  duplicateAction: DuplicateAction;
  // The proxy this row was attached to because the file named its host and
  // port but no credentials. Kept as an id rather than a flag so that picking a
  // proxy by hand, which writes the same field, is still told apart from this.
  borrowedProxyId: string | null;
};

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function nameMatchFor(row: ImportRow, library: ImportLibrary) {
  if (row.input.profileId || !row.name.trim()) {
    return null;
  }
  const found = library.profiles.find((profile) =>
    !profile.deleted_at && sameName(profile.name, row.name));
  return found ? {id: found.id, name: found.name} : null;
}

// The proxy a credential-less line is really asking for.
//
// proxyDedupeKey() includes the username, so "socks5://204.252.87.159:47403"
// -- exactly what this app's own export used to write -- never matches the
// stored proxy for that host that does have one, and imports a second,
// unusable copy of it instead. A line carrying no credentials is not making a
// claim about the username, so host and port are the whole of what it said and
// the whole of what should have to match.
//
// Deliberately not applied when the file did supply credentials: those are a
// statement, and a different username on the same host is a different account.
export function savedCredentialsFor(
    row: ImportRow, library: ImportLibrary): ScoutProxy | null {
  const parsed = row.proxy;
  if (!parsed || row.matchedProxyId || row.input.proxyId) {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  return library.proxies.find((proxy) =>
    proxy.host === parsed.host &&
    proxy.port === parsed.port &&
    Boolean(proxy.username || proxy.password)) || null;
}

// True when the row will end up on a proxy that has no credentials -- whether
// that proxy is about to be created from the file or already exists.
//
// Not an ImportIssue: the engine is right that this is not something wrong with
// the *file*, and it is not a reason to refuse the row. It is a warning the
// review screen owns, because the review screen is where there is something to
// do about it.
//
// The matched-proxy half matters more than it looks. proxyDedupeKey excludes the
// password, so a credential-less line matches a credential-less stored row --
// which is exactly what a second import of the same file does. Without this
// check that row came back badged "Reused", reading like the credentials had
// been found when nothing had changed and the launch was still going to fail.
//
// But plenty of proxies genuinely need no login, so a saved one is only flagged
// while there is no evidence it works: a proxy that has passed a check has
// proved it does not need credentials, and warning about it would be noise. An
// unsaved line has no check to appeal to, so the absence of a login is all there
// is to go on.
export function missingCredentials(row: ImportRow, library: ImportLibrary) {
  if (row.proxyMode !== 'assigned' || !row.proxy) {
    return false;
  }
  if (row.matchedProxyId) {
    const matched = library.proxies.find((proxy) => proxy.id === row.matchedProxyId);
    // An id we cannot resolve is not evidence of a missing login.
    if (!matched || matched.username || matched.password) {
      return false;
    }
    return Boolean(matched.check_error) || !matched.checked_at;
  }
  return !row.proxy.username && !row.proxy.password;
}

// Attaching the saved proxy by id rather than rewriting the connection string
// means the engine treats it as a proxy the user picked, which is what makes it
// reuse the stored record -- credentials included -- rather than create one
// from the credential-less text.
function adoptSavedCredentials(row: ImportRow, library: ImportLibrary) {
  const saved = savedCredentialsFor(row, library);
  return saved ?
    {row: reviseRow(row, {proxyId: saved.id}, library), borrowedProxyId: saved.id} :
    {row, borrowedProxyId: null};
}

// Everything that should already be true the first time the user sees a row.
export function reviewRow(row: ImportRow, library: ImportLibrary): ReviewRow {
  const adopted = adoptSavedCredentials(row, library);
  const nameMatch = nameMatchFor(adopted.row, library);
  const review: ReviewRow = {
    row: adopted.row,
    nameMatch,
    duplicateAction: nameMatch ? 'update' : 'new',
    borrowedProxyId: adopted.borrowedProxyId,
  };
  // Applied rather than just recorded, so the default is the one that actually
  // runs if the user changes nothing.
  return nameMatch ? setDuplicateAction(review, 'update', library) : review;
}

export function reviewRows(rows: ImportRow[], library: ImportLibrary): ReviewRow[] {
  return rows.map((row) => reviewRow(row, library));
}

// Updating in place is expressed as "this row *is* that profile" -- the engine
// already reclaims a profile whose id it is given, along with the browser
// directory, cookies and logged-in session behind it. Anything else clears the
// id back out, so the row mints a new one.
export function setDuplicateAction(
    review: ReviewRow, action: DuplicateAction, library: ImportLibrary): ReviewRow {
  if (!review.nameMatch) {
    return review;
  }
  return {
    ...review,
    duplicateAction: action,
    row: reviseRow(review.row, {profileId: action === 'update' ? review.nameMatch.id : ''}, library),
  };
}

// Re-validates after an edit in the table.
//
// Retyping the proxy re-runs the credential lookup, so correcting a host still
// picks up the saved credentials for it; picking a proxy by hand does not,
// because that is the user overriding the file rather than the file being
// completed. Renaming re-checks the name collision, since renaming is one of
// the ways to resolve one -- unless the row is already set to update, where the
// name is now a rename of the profile it matched.
export function reviseReviewRow(
    review: ReviewRow, patch: Partial<ImportRowInput>, library: ImportLibrary): ReviewRow {
  let row = reviseRow(review.row, patch, library);
  let borrowedProxyId = review.borrowedProxyId;

  if (patch.proxyId !== undefined) {
    borrowedProxyId = null;
  } else if (patch.proxyText !== undefined || patch.proxyMode !== undefined) {
    // Drop a previously borrowed attachment first, or the explicit id would
    // keep winning over the text the user just changed.
    if (borrowedProxyId) {
      row = reviseRow(row, {proxyId: ''}, library);
    }
    const adopted = adoptSavedCredentials(row, library);
    row = adopted.row;
    borrowedProxyId = adopted.borrowedProxyId;
  }

  if (review.duplicateAction === 'update') {
    return {...review, row, borrowedProxyId};
  }
  const nameMatch = nameMatchFor(row, library);
  return {
    ...review,
    row,
    nameMatch,
    duplicateAction: nameMatch ? review.duplicateAction : 'new',
    borrowedProxyId,
  };
}

// Rows that still want a proxy and have none.
export function needsProxy(review: ReviewRow) {
  return review.row.proxyMode === 'assigned' && !review.row.proxy;
}

// The row's connection string with a login attached.
//
// The composing itself is formatProxyLink's, so this and the per-row proxy
// popover cannot disagree about how a credential is encoded into a line.
export function proxyTextWithCredentials(
    row: ImportRow, username: string, password: string): string | null {
  const proxy = row.proxy;
  return proxy ? formatProxyLink({...proxy, username, password}) : null;
}

// The one connection string the per-row proxy popover's four fields describe.
//
// Here rather than in the dialog because it is the whole of what that popover
// decides, and a rule this fiddly is worth being able to test without a browser:
//
//   - an address that will not parse is passed through untouched, so resolveRow
//     raises its own "Could not read a proxy from ..." and the row keeps its
//     Unreadable badge. Returning null or a repaired guess would lose the only
//     report the user gets;
//   - a scheme typed into the address outranks the type selector, because it is
//     the more specific statement of the two. With no scheme the selector wins,
//     since a bare host:port parses as socks5 by default and that default would
//     otherwise silently retype an HTTP proxy;
//   - the credential fields win over anything the address carried, but an
//     address that still holds a login is a fallback rather than something to
//     drop. Enter commits without blurring, so someone who typed a whole vendor
//     line into Address and hit it never gave the field a chance to split out.
export function proxyTextFromFields(
    address: string, type: 'http' | 'socks5', username: string, password: string): string {
  const raw = address.trim();
  const endpoint = parseProxyLink(raw);
  if (!endpoint) {
    return raw;
  }
  return formatProxyLink({
    ...endpoint,
    type: /^(https?|socks5?):(\/\/)?/i.test(raw) ? endpoint.type : type,
    username: username.trim() || endpoint.username || '',
    password: password || endpoint.password || '',
  });
}

// What applying one username and password to the whole import should do.
//
// Two different actions, because the rows are in two different states and only
// one of them can be fixed by editing the file's text:
//
//   - a row whose proxy is not saved yet just needs its connection string
//     rewritten, which the normal reviseReviewRow path already handles;
//   - a row that matched a *saved* proxy with no login has to update that proxy.
//     Rewriting the text there would mint a second proxy for the same host:port
//     (the username is part of the dedupe key), leaving the original behind as a
//     dead duplicate that profiles from an earlier import still point at.
//
// Pure: it decides, the dialog executes. `storedProxyIds` is deduplicated
// because several rows commonly share one proxy.
//
// `proxyCount` is what the banner counts, and it is deliberately not
// lines.length: two profiles pointing at one proxy are two rows and one proxy,
// and "2 proxies have no username or password" would be a lie about a library
// that is about to hold one. Counted by endpoint for the unsaved rows -- the
// import dedupes them into a single proxy -- and by id for the saved ones.
export type CredentialFix = {lines: number[]; storedProxyIds: string[]; proxyCount: number};

export function planCredentialFix(
    reviews: ReviewRow[], library: ImportLibrary): CredentialFix {
  const lines: number[] = [];
  const storedProxyIds = new Set<string>();
  const endpoints = new Set<string>();
  for (const review of reviews) {
    if (!missingCredentials(review.row, library)) {
      continue;
    }
    const {matchedProxyId, proxy} = review.row;
    if (matchedProxyId) {
      storedProxyIds.add(matchedProxyId);
    } else {
      lines.push(review.row.line);
      if (proxy) {
        endpoints.add(`${proxy.type || 'socks5'}://${proxy.host}:${proxy.port}`);
      }
    }
  }
  return {
    lines,
    storedProxyIds: [...storedProxyIds],
    proxyCount: endpoints.size + storedProxyIds.size,
  };
}

// Hands out one library proxy per row that needs one.
//
// Proxies no existing profile is using come first, then the rest, and none is
// handed out twice in a pass -- two profiles quietly sharing an egress IP is
// the kind of thing an anti-detect tool exists to prevent. Returns line ->
// proxy id for the dialog to apply through reviseReviewRow rather than mutating
// anything, so not applying it is the whole of the undo.
//
// No guessing from tags or country: the files this reads carry city names in a
// tag column, and a proxy picked from a fuzzy match on that would be wrong
// often enough to be worse than leaving the cell empty.
export function distributeProxies(
    reviews: ReviewRow[], library: ImportLibrary): Map<number, string> {
  const taken = new Set<string>();
  for (const review of reviews) {
    if (review.row.matchedProxyId) {
      taken.add(review.row.matchedProxyId);
    }
  }
  const available = [...library.proxies]
      .filter((proxy) => !taken.has(proxy.id))
      .sort((a, b) => Number(isProxyAssigned(a, library.profiles)) -
        Number(isProxyAssigned(b, library.profiles)));

  const assignments = new Map<number, string>();
  for (const review of reviews) {
    if (!needsProxy(review)) {
      continue;
    }
    const next = available.shift();
    if (!next) {
      break;
    }
    assignments.set(review.row.line, next.id);
  }
  return assignments;
}

// How a row's proxy should be labelled in the table.
export type ProxyBadge =
  | 'direct' | 'free' | 'missing' | 'unreadable'
  | 'new' | 'reused' | 'saved-credentials' | 'no-credentials';

export function proxyBadge(review: ReviewRow, library: ImportLibrary): ProxyBadge {
  const {row} = review;
  if (row.proxyMode === 'direct') {
    return 'direct';
  }
  if (row.proxyMode === 'free_proxy') {
    return 'free';
  }
  if (!row.proxy) {
    return row.input.proxyText ? 'unreadable' : 'missing';
  }
  if (review.borrowedProxyId && review.borrowedProxyId === row.input.proxyId) {
    return 'saved-credentials';
  }
  // Deliberately ahead of 'reused': a matched proxy with no login is still going
  // to fail, and saying "Reused" there hides the one thing worth acting on.
  if (missingCredentials(row, library)) {
    return 'no-credentials';
  }
  return row.matchedProxyId ? 'reused' : 'new';
}

// Short because these sit beside a host:port in a narrow column. "Saved
// credentials" wrapped the badge onto a second line and took the row with it, so
// the badge is abbreviated and proxyBadgeTitle carries the full phrase on hover.
export const proxyBadgeLabel: Record<ProxyBadge, string> = {
  'direct': 'Direct',
  'free': 'Free proxy',
  'missing': 'No proxy',
  'unreadable': 'Unreadable',
  'new': 'New',
  'reused': 'Reused',
  'saved-credentials': 'Saved creds',
  'no-credentials': 'No creds',
};

export const proxyBadgeTitle: Record<ProxyBadge, string> = {
  'direct': 'This profile deliberately uses no proxy',
  'free': 'Uses the bundled free proxy',
  'missing': 'No proxy in this row',
  'unreadable': 'The proxy column could not be read',
  'new': 'Will be saved as a new proxy',
  'reused': 'Already in your proxy library',
  'saved-credentials': 'Using the credentials already saved for this host and port',
  'no-credentials': 'No username or password — this proxy will fail if it needs one',
};

// The connection details to check, for a row whose proxy may not be saved yet.
// A matched proxy is checked as it is stored, credentials and all -- checking
// the credential-less text the file supplied would report a failure the import
// is not going to cause.
export function proxyCheckTarget(review: ReviewRow, library: ImportLibrary) {
  const {row} = review;
  if (row.proxyMode !== 'assigned' || !row.proxy) {
    return null;
  }
  const stored = row.matchedProxyId ?
    library.proxies.find((proxy) => proxy.id === row.matchedProxyId) :
    undefined;
  const source = stored || row.proxy;
  return {
    id: stored?.id,
    type: source.type,
    host: source.host,
    port: source.port,
    username: source.username,
    password: source.password,
  };
}

// Which rows the commit is given. Blocked rows are left in so the engine
// reports them as skipped in one place; rows the user chose to skip are not,
// because nothing about them is wrong and they should not be listed as
// something that went partly right.
export function rowsToImport(reviews: ReviewRow[]) {
  return reviews.filter((review) => review.duplicateAction !== 'skip').map((review) => review.row);
}

// The rows that will actually produce a profile, for the counts in the footer.
export function importableCount(reviews: ReviewRow[]) {
  return reviews.filter((review) =>
    review.duplicateAction !== 'skip' && !review.row.blocked).length;
}

// Applies the folder chosen for each distinct CSV folder value.
//
// Rewriting each row's folder column and committing with {kind:'per-row'} keeps
// the remapping out of the engine: 'per-row' already means "the folder this row
// names", and its folderIdFor() already reuses an existing folder of that name
// rather than creating a second one. An empty name is how a value is dropped.
export function applyFolderMapping(
    reviews: ReviewRow[],
    folderNameByValue: Map<string, string>,
    library: ImportLibrary): ReviewRow[] {
  return reviews.map((review) => {
    const value = review.row.folder;
    if (!value) {
      return review;
    }
    const mapped = folderNameByValue.get(value.toLowerCase());
    if (mapped === undefined || mapped === value) {
      return review;
    }
    return reviseReviewRow(review, {folder: mapped}, library);
  });
}
