// The cookie-set library: its rows, its Trash, its folder and tag assignments,
// which profiles use each set, and the payload the inspector reads and writes.
//
// Split out of useLibraryActions once the Cookies tab stopped being a list with
// a delete button. That hook's premise -- "each one is a handful of lines" --
// stopped holding here first.
//
// The one thing to keep in mind throughout: cookie_sets.cookies is a read cache
// for the inspector, and source_url is what a launch actually consumes
// (electron/main.cjs fetches it and holds no Supabase credentials). Any write
// that changes the cookies must change both, which is why saveEntries uploads a
// fresh file rather than just updating a column.
import * as db from '../db';
import {
  cookieFileToBase64,
  cookiesFromJsonValue,
  decodeCookieBase64,
  parseCookieContent,
  toCookieJson,
  toNetscapeCookies,
  withRowIds,
} from '../lib/cookieFile';
import type {CookieEntry, CookieRow} from '../lib/cookieFile';
import {cloudCookieFromSelection} from '../lib/cookieUpload';
import {normalizeTags} from '../lib/tags';
import {native} from '../native';
import {newId} from './core';
import type {WorkspaceCore} from './core';
import type {CookieFileSelection} from '../native';
import type {MontiCookie, MontiFolder, MontiProfile} from '../types';

export type CookieActions = ReturnType<typeof useCookieActions>;

// Everything that can put cookies into a launch, cleared at once.
//
// Nulling cookie_id alone is not enough and the shortfall is invisible until a
// browser opens: buildLaunchPayload falls back to the legacy cookie_import_*
// fields when no saved set resolves, and those fields survive every profile
// save (drafts.ts) while being hidden by the editor whenever cookie_mode is
// 'saved'. So a profile that was ever imported into directly and later put on a
// library set keeps a second, live copy of that file. Unassign it the cheap way
// and the app says "N profiles unassigned" while the next launch signs straight
// back in.
//
// Also what stops migrateLegacyCookieImports from re-minting a purged set from
// the same stale URL on the next window focus.
const NO_COOKIES = {
  cookie_id: null,
  cookie_mode: 'paste',
  cookie_import_path: null,
  cookie_import_url: null,
  cookie_import_name: null,
  cookie_import_count: null,
} as const;

// What the inspector and the tab can change about a set without touching its
// payload. Taken as one object for the same reason FolderFields is: a fourth
// field is where positional arguments start being passed in the wrong order.
export type CookieFields = {
  name?: string;
  folder_id?: string | null;
  tags?: string[];
  // The two marks a set carries for the user rather than for a launch: the
  // status chip and the colour of its icon. Both are set from the table only,
  // and both take '' to mean "back to unmarked" -- which for the colour is what
  // returns the icon to its folder's tint.
  status?: string;
  color?: string;
};

export function useCookieActions({data, toast}: WorkspaceCore) {
  const {state, withDb, patch} = data;

  // ---- reads -----------------------------------------------------------

  function folderFor(cookie: MontiCookie): MontiFolder | null {
    return state.cookie_folders.find((folder) => folder.id === cookie.folder_id) || null;
  }

  // Trashed profiles do not count as users of a set -- they cannot launch.
  function profilesUsing(cookieId: string): MontiProfile[] {
    return state.profiles.filter(
        (profile) => profile.cookie_id === cookieId && !profile.deleted_at);
  }

  // One pass for the whole table instead of a filter per row: the Cookies tab
  // renders this column for every visible set.
  function usageCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const profile of state.profiles) {
      if (profile.deleted_at || !profile.cookie_id) {
        continue;
      }
      counts.set(profile.cookie_id, (counts.get(profile.cookie_id) || 0) + 1);
    }
    return counts;
  }

  // ---- library CRUD ----------------------------------------------------

  // Uploads a picked cookie file into the shared library, reusing the same
  // upload path as a per-profile import but keyed by a fresh cookie id.
  //
  // The file is parsed here too, so the payload cache is populated from the
  // start and a set imported from this build on never needs the lazy backfill
  // loadEntries does for older rows.
  async function addCookieSet(
      selection: CookieFileSelection,
      options?: {folderId?: string | null; tags?: string[]},
  ): Promise<MontiCookie | null> {
    const id = newId();
    const uploaded = await cloudCookieFromSelection(id, selection);
    if (!uploaded.cookie_import_url) {
      throw new Error('Cookie upload did not return a usable URL.');
    }
    // selection.base64 is the same bytes that were just uploaded, so parsing it
    // cannot disagree with what a launch will later fetch.
    const parsed = selection.base64 ?
      parseCookieContent(decodeCookieBase64(selection.base64)) :
      [];
    const entry: MontiCookie = {
      id,
      name: uploaded.cookie_import_name || 'cookies.txt',
      url: uploaded.cookie_import_url,
      count: parsed.length || uploaded.cookie_import_count,
      folder_id: options?.folderId ?? null,
      tags: normalizeTags(options?.tags || []),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    if (!await withDb((activeOrgId) => db.cookieSets.create(activeOrgId, entry, parsed))) {
      return null;
    }
    patch.cookies((list) => [...list, entry]);
    return entry;
  }

  async function save(id: string, fields: CookieFields): Promise<boolean> {
    const next: Partial<MontiCookie> = {};
    if ('name' in fields) {
      next.name = fields.name?.trim() || 'cookies.txt';
    }
    if ('folder_id' in fields) {
      next.folder_id = fields.folder_id ?? null;
    }
    if ('tags' in fields) {
      next.tags = normalizeTags(fields.tags || []);
    }
    // Both stored as undefined rather than '' when cleared, so the mapper writes
    // a null and a read of the row comes back to the same fallback a row that
    // was never marked gets.
    if ('status' in fields) {
      next.status = fields.status || undefined;
    }
    if ('color' in fields) {
      next.color = fields.color || undefined;
    }
    if (!await withDb((activeOrgId) => db.cookieSets.update(activeOrgId, id, next))) {
      return false;
    }
    patch.cookies((list) => list.map((cookie) =>
      cookie.id === id ? {...cookie, ...next, updated_at: new Date().toISOString()} : cookie));
    return true;
  }

  async function assignToFolder(ids: string[], folderId: string | null): Promise<boolean> {
    const ok = await withDb(async (activeOrgId) => {
      for (const id of ids) {
        await db.cookieSets.update(activeOrgId, id, {folder_id: folderId});
      }
    });
    if (!ok) {
      return false;
    }
    patch.cookies((list) => list.map((cookie) =>
      ids.includes(cookie.id) ? {...cookie, folder_id: folderId} : cookie));
    return true;
  }

  // A copy shares the original's Storage object rather than re-uploading it:
  // the file is immutable once written (every save uploads a new one keyed by
  // Date.now()), so two rows pointing at it cannot drift. The first edit to
  // either copy gives that copy its own object.
  async function duplicate(cookie: MontiCookie): Promise<MontiCookie | null> {
    // An unreadable payload does not block the copy: it points at the same
    // source_url, so the copy's cache just stays empty and fills on first open.
    const payload = await loadPayloadSafe(cookie);
    const copy: MontiCookie = {
      ...cookie,
      id: newId(),
      name: `${cookie.name} copy`,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    if (!await withDb((activeOrgId) => db.cookieSets.create(activeOrgId, copy, payload))) {
      return null;
    }
    patch.cookies((list) => [...list, copy]);
    return copy;
  }

  // ---- trash -----------------------------------------------------------

  // Trashing also unassigns every profile using the set. The row still exists,
  // so the FK would happily keep resolving it -- and a trashed set that could
  // still seed a browser launch would be a lie. Restore deliberately does not
  // put the assignments back: knowing who to give it back to would need a
  // column recording who held it, and re-attaching cookies to a profile without
  // being asked is the wrong way to be wrong.
  async function softDelete(ids: string[]): Promise<boolean> {
    const referencing = state.profiles.filter(
        (profile) => profile.cookie_id && ids.includes(profile.cookie_id));
    const ok = await withDb(async (activeOrgId) => {
      await db.cookieSets.softDelete(activeOrgId, ids);
      for (const profile of referencing) {
        await db.profiles.update(activeOrgId, profile.id, NO_COOKIES);
      }
    });
    if (!ok) {
      return false;
    }
    const deletedAt = new Date().toISOString();
    patch.cookies((list) => list.map((cookie) =>
      ids.includes(cookie.id) ? {...cookie, deleted_at: deletedAt} : cookie));
    unassignLocally(ids);
    return true;
  }

  async function restore(ids: string[]): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.cookieSets.restore(activeOrgId, ids))) {
      return false;
    }
    patch.cookies((list) => list.map((cookie) =>
      ids.includes(cookie.id) ? {...cookie, deleted_at: null} : cookie));
    return true;
  }

  // The FK's ON DELETE SET NULL covers cookie_set_id, but nothing puts those
  // profiles back into 'paste' mode -- softDelete already did it for anything
  // that went through Trash, and this is the belt-and-braces for a row purged
  // some other way.
  async function purge(ids: string[]): Promise<boolean> {
    const referencing = state.profiles.filter(
        (profile) => profile.cookie_id && ids.includes(profile.cookie_id));
    const ok = await withDb(async (activeOrgId) => {
      await db.cookieSets.purge(activeOrgId, ids);
      for (const profile of referencing) {
        await db.profiles.update(activeOrgId, profile.id, NO_COOKIES);
      }
    });
    if (!ok) {
      return false;
    }
    patch.cookies((list) => list.filter((cookie) => !ids.includes(cookie.id)));
    unassignLocally(ids);
    return true;
  }

  // Empty Trash for cookie-sets.
  //
  // The referencing-profile cleanup is the same one purge() does and for the same
  // reason -- the FK nulls cookie_set_id but nothing puts those profiles back
  // into 'paste' mode. The ids come from the returned rows rather than from local
  // state, so a set trashed on another device is cleaned up too rather than
  // leaving a profile pointing at a cookie mode it no longer has a set for.
  async function purgeAll(): Promise<boolean> {
    let purgedIds: string[] = [];
    const ok = await withDb(async (activeOrgId) => {
      purgedIds = await db.cookieSets.purgeAll(activeOrgId);
      const referencing = state.profiles.filter(
          (profile) => profile.cookie_id && purgedIds.includes(profile.cookie_id));
      for (const profile of referencing) {
        await db.profiles.update(activeOrgId, profile.id, NO_COOKIES);
      }
    });
    if (!ok) {
      return false;
    }
    patch.cookies((list) => list.filter((cookie) => !cookie.deleted_at));
    unassignLocally(purgedIds);
    return true;
  }

  // ---- assignment ------------------------------------------------------

  // The whole assignment for one set, as a set difference: profiles in
  // `profileIds` get it, profiles that had it and are no longer listed lose it.
  // Taking the full list rather than an add/remove pair is what lets the dialog
  // be a checkbox list whose state is the answer.
  async function assignToProfiles(cookieId: string, profileIds: string[]): Promise<boolean> {
    const current = profilesUsing(cookieId).map((profile) => profile.id);
    const added = profileIds.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !profileIds.includes(id));
    if (added.length === 0 && removed.length === 0) {
      return true;
    }
    const ok = await withDb(async (activeOrgId) => {
      for (const id of added) {
        await db.profiles.update(activeOrgId, id, {cookie_id: cookieId, cookie_mode: 'saved'});
      }
      for (const id of removed) {
        await db.profiles.update(activeOrgId, id, NO_COOKIES);
      }
    });
    if (!ok) {
      return false;
    }
    patch.profiles((list) => list.map((profile) => {
      if (added.includes(profile.id)) {
        return {...profile, cookie_id: cookieId, cookie_mode: 'saved' as const};
      }
      if (removed.includes(profile.id)) {
        return {...profile, ...NO_COOKIES};
      }
      return profile;
    }));
    return true;
  }

  // ---- payload ---------------------------------------------------------

  // The cache first, the file second. A set imported before the inspector
  // existed has an empty `cookies` column and a perfectly good source_url, so
  // the first open downloads and parses -- and then writes the result back so
  // the second open is instant.
  //
  // The backfill is fire-and-forget and touches only `cookies` and `count`,
  // never source_url: a member whose RLS forbids the write still gets to read
  // the cookies, and a failure costs one more download rather than a launch.
  async function loadEntries(cookie: MontiCookie): Promise<CookieRow[]> {
    return withRowIds(await loadPayloadFor(cookie));
  }

  async function loadPayloadFor(cookie: MontiCookie): Promise<CookieEntry[]> {
    const orgId = data.orgId;
    if (!orgId) {
      return [];
    }
    const payload = await db.cookieSets.loadPayload(orgId, cookie.id);
    const cached = cookiesFromJsonValue(payload?.cookies);
    if (cached.length > 0) {
      return cached;
    }
    const sourceUrl = payload?.source_url || cookie.url;
    if (!sourceUrl) {
      return [];
    }
    const parsed = parseCookieContent(await db.cookieSets.downloadCookieFile(sourceUrl));
    if (parsed.length > 0) {
      void db.cookieSets.cachePayload(orgId, cookie.id, parsed).catch(() => {});
      patch.cookies((list) => list.map((item) =>
        item.id === cookie.id ? {...item, count: parsed.length} : item));
    }
    return parsed;
  }

  // Writes an edited set back. Uploads a fresh file FIRST and stores its URL
  // alongside the cache, because source_url is what the browser will actually
  // read at launch -- updating only the jsonb would look right in every screen
  // of this app and still seed the pre-edit cookies.
  async function saveEntries(cookie: MontiCookie, entries: CookieEntry[]): Promise<boolean> {
    const fileName = cookie.name.toLowerCase().endsWith('.json') ?
      cookie.name :
      `${cookie.name || 'cookies'}.json`;
    // The inspector hands back CookieRows, which carry the synthetic row id it
    // needed for selection and React keys. Re-normalizing drops it, so the
    // cached column and the uploaded file hold the same shape -- the one
    // normalizeCookie() defines and electron/main.cjs reads.
    const clean = cookiesFromJsonValue(entries);
    let url: string;
    try {
      url = await db.cookieSets.uploadCookieFile(
          cookie.id, fileName, cookieFileToBase64(toCookieJson(clean)), cookie.url);
    } catch (error) {
      toast.fail('Could not save these cookies',
          error instanceof Error ? error.message : String(error));
      return false;
    }
    const ok = await withDb((activeOrgId) =>
      db.cookieSets.savePayload(activeOrgId, cookie.id, clean, url, clean.length));
    if (!ok) {
      return false;
    }
    patch.cookies((list) => list.map((item) => item.id === cookie.id ?
      {...item, url, count: clean.length, updated_at: new Date().toISOString()} :
      item));
    if (url.startsWith('data:')) {
      toast.setMessage('Saved inline: the storage bucket is not writable, so these cookies ' +
        'live in the database row rather than in Storage.');
    }
    return true;
  }

  // ---- export ----------------------------------------------------------

  // Several sets export as one merged file, which is what makes "select three
  // and export" useful: cookies from different sets rarely collide, and the
  // formats are both flat lists anyway.
  async function exportSets(list: MontiCookie[], format: 'json' | 'netscape'): Promise<void> {
    if (!list.length) {
      return;
    }
    const merged: CookieEntry[] = [];
    for (const cookie of list) {
      merged.push(...await loadPayloadSafe(cookie));
    }
    const single = list.length === 1 ? list[0].name : 'monti-cookies';
    await exportEntries(single, merged, format);
  }

  // The same writer, over a list the caller already holds. The inspector uses
  // this rather than exportSets so that exporting after an edit writes what is
  // on screen -- going back to the database for it would quietly hand back the
  // pre-edit file.
  async function exportEntries(
      label: string, entries: CookieEntry[], format: 'json' | 'netscape'): Promise<void> {
    if (!native?.saveTextFile) {
      toast.setMessage('Native file export is not available. Restart EasyDeck and try again.');
      return;
    }
    if (!entries.length) {
      toast.setMessage('Nothing to export: there are no cookies in that selection.');
      return;
    }
    const stem = label.replace(/\.[^.]+$/, '') || 'monti-cookies';
    const fileName = `${stem}-${Date.now()}.${format === 'json' ? 'json' : 'txt'}`;
    // The only step here that can throw: writeTextFile has no guard of its own
    // in the main process, so an unwritable destination rejects the IPC call --
    // and useAsyncAction.run rethrows rather than catching, which at a `void
    // run(...)` call site means the spinner simply stops with nothing said.
    // toNetscapeCookies can throw too, on a stored url that is not parseable.
    try {
      const body = format === 'json' ? toCookieJson(entries) : toNetscapeCookies(entries);
      const savedPath = await native.saveTextFile(fileName, body);
      if (savedPath) {
        toast.setMessage(
            `Exported ${entries.length} cookies to ${savedPath.split(/[\\/]/).pop()}`);
      }
    } catch (error) {
      toast.fail('Could not export those cookies',
          error instanceof Error ? error.message : String(error));
    }
  }

  // ---- helpers ---------------------------------------------------------

  // loadPayloadFor throws so the inspector can show *why* a file would not open.
  // Every other caller only wants the cookies if they are there, and none of
  // them run inside anything that catches -- useAsyncAction.run rethrows.
  async function loadPayloadSafe(cookie: MontiCookie): Promise<CookieEntry[]> {
    try {
      return await loadPayloadFor(cookie);
    } catch (error) {
      toast.fail(`Could not read "${cookie.name}"`,
          error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  function unassignLocally(cookieIds: string[]) {
    patch.profiles((list) => list.map((profile) =>
      profile.cookie_id && cookieIds.includes(profile.cookie_id) ?
        {...profile, ...NO_COOKIES} :
        profile));
  }

  return {
    folderFor,
    profilesUsing,
    usageCounts,
    addCookieSet,
    save,
    assignToFolder,
    duplicate,
    softDelete,
    restore,
    purge,
    purgeAll,
    assignToProfiles,
    loadEntries,
    saveEntries,
    exportSets,
    exportEntries,
  };
}

