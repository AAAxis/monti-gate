import {cookieRawFromDataUrl} from '../lib/cookieFile';
import type {CookieEntry} from '../lib/cookieFile';
import type {ScoutCookie} from '../types';
import {optionalClient, raise, requireClient, STORAGE_BUCKET} from './client';
import {cookiePatchToRow, cookieToRow, rowToCookie} from './mappers';
import type {CookieSetRow} from './rows';

// Explicit, like every other table's select -- and deliberately WITHOUT
// `cookies`. That column now holds real payloads rather than '[]', and a
// workspace with a couple of hundred sets would otherwise pull every one of
// them on every load, which useCloudData repeats on each window focus. This
// list is metadata; loadPayload fetches a body, one set at a time.
const COLUMNS =
  'id,org_id,name,updated_at,created_at,source_url,count,folder_id,tags,deleted_at,' +
  'assigned_to,status,color,created_by';

// Trashed sets come back too, exactly as profiles.list returns soft-deleted
// profiles: Trash is a view the tab filters into, not a second read.
export async function list(orgId: string): Promise<ScoutCookie[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('cookie_sets')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('created_at', {ascending: true});
  raise(error, 'cookieSets.list');
  return ((data || []) as unknown as CookieSetRow[]).map(rowToCookie);
}

// The only read of the `cookies` column. Returns source_url alongside it so a
// caller that finds the cache empty can fall back to the file without a second
// round trip.
export async function loadPayload(
    orgId: string, id: string): Promise<{cookies: unknown[]; source_url: string | null} | null> {
  const client = optionalClient();
  if (!client) {
    return null;
  }
  const {data, error} = await client
      .from('cookie_sets')
      .select('id,cookies,source_url')
      .eq('org_id', orgId)
      .eq('id', id)
      .maybeSingle();
  raise(error, 'cookieSets.loadPayload');
  if (!data) {
    return null;
  }
  const row = data as unknown as {cookies: unknown[] | null; source_url: string | null};
  return {cookies: row.cookies || [], source_url: row.source_url};
}

// `cookies` is passed separately rather than living on ScoutCookie, because the
// app type deliberately does not carry payloads -- see the comment there.
export async function create(
    orgId: string, cookie: ScoutCookie, cookies?: CookieEntry[]): Promise<void> {
  const client = requireClient();
  const {error} = await client.from('cookie_sets').insert({
    ...cookieToRow(orgId, cookie),
    ...(cookies ? {cookies} : {}),
  });
  raise(error, 'cookieSets.create');
}

// Metadata only: name, folder, tags, status, colour. The payload goes through
// savePayload, which has to write three columns at once.
export async function update(
    orgId: string, id: string, patch: Partial<ScoutCookie>): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('cookie_sets')
      .update(cookiePatchToRow(patch))
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'cookieSets.update');
}

// The three columns that describe the payload, written together because they
// must never disagree. source_url is what electron/main.cjs actually fetches at
// launch (it holds no Supabase credentials), so an edit that updated only the
// `cookies` cache would display correctly everywhere in the app and still seed
// the browser with the pre-edit cookies.
export async function savePayload(
    orgId: string,
    id: string,
    cookies: CookieEntry[],
    sourceUrl: string | null,
    count: number): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('cookie_sets')
      .update({
        cookies,
        source_url: sourceUrl,
        count,
        updated_at: new Date().toISOString(),
      })
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'cookieSets.savePayload');
}

// Backfills the `cookies` cache for a set imported before the inspector
// existed, WITHOUT touching source_url. Split out from savePayload precisely so
// it cannot break a launch: the worst a failed backfill costs is one more
// download next time.
export async function cachePayload(
    orgId: string, id: string, cookies: CookieEntry[]): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('cookie_sets')
      .update({cookies, count: cookies.length})
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'cookieSets.cachePayload');
}

export async function softDelete(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const now = new Date().toISOString();
  const {error} = await client
      .from('cookie_sets')
      .update({deleted_at: now, updated_at: now})
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'cookieSets.softDelete');
}

// Unlike profiles.restore there is no limit trigger to trip here -- cookie-sets
// are not what a plan caps.
export async function restore(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const {error} = await client
      .from('cookie_sets')
      .update({deleted_at: null, updated_at: new Date().toISOString()})
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'cookieSets.restore');
}

// Profiles pointing at a purged set are reset to cookie_set_id = null by the
// FK's ON DELETE SET NULL; the caller still flips their cookie_mode back to
// 'paste'. In practice softDelete already unassigned them.
export async function purge(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const {error} = await client
      .from('cookie_sets')
      .delete()
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'cookieSets.purge');
  void removeCookieFilesFor(ids);
}

// Empty Trash. Mirrors profiles.purgeAll exactly, including why it is scoped by
// deleted_at rather than by an id list: that is what makes it safe to offer with
// nothing selected, and it also catches anything trashed elsewhere while the
// dialog was open.
export async function purgeAll(orgId: string): Promise<string[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('cookie_sets')
      .delete()
      .eq('org_id', orgId)
      .not('deleted_at', 'is', null)
      .select('id');
  raise(error, 'cookieSets.purgeAll');
  const ids = ((data || []) as Array<{id: string}>).map((row) => row.id);
  void removeCookieFilesFor(ids);
  return ids;
}

// The 30-day Trash expiry, as one statement. Returns the ids it removed so the
// caller can report a count. Mirrors profiles.purgeExpired exactly.
export async function purgeExpired(orgId: string, cutoffIso: string): Promise<string[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('cookie_sets')
      .delete()
      .eq('org_id', orgId)
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoffIso)
      .select('id');
  raise(error, 'cookieSets.purgeExpired');
  const ids = ((data || []) as Array<{id: string}>).map((row) => row.id);
  void removeCookieFilesFor(ids);
  return ids;
}

// ---- storage ------------------------------------------------------------

// Uploads a cookie file to the public `global` bucket and returns its URL, or
// an inline data: URL when the bucket is unreachable. Object paths are
// unchanged from the blob era so electron/main.cjs consumes them identically.
//
// `previousUrl` is the source_url this upload is about to replace, and passing
// it is what keeps the bucket from growing without bound. The key carries
// Date.now() on purpose -- the public URL has to change or the CDN serves the
// pre-edit jar to electron/main.cjs, which fetches source_url over plain HTTP
// with no credentials -- so every save mints a new object and strands the last
// one. Nothing can reach a stranded object: cookie_sets.source_url points at
// exactly one file and there is no snapshot history anywhere in the app. Left
// alone, the live sync in the cookie-manager extension pushes on a six-second
// floor, which is roughly ten dead 30 KB objects a minute per running profile.
export async function uploadCookieFile(
    keyId: string, fileName: string, base64: string,
    previousUrl?: string | null): Promise<string> {
  const client = optionalClient();
  if (!client) {
    return `data:text/plain;base64,${base64}`;
  }
  const safeName = fileName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') ||
    'cookies.txt';
  const objectPath = `profile-cookies/${keyId}/${Date.now()}-${safeName}`;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const {error: uploadError} = await client.storage
      .from(STORAGE_BUCKET)
      .upload(objectPath, bytes, {contentType: 'text/plain', upsert: true});
  if (uploadError && isStorageNotWritable(uploadError)) {
    return `data:text/plain;base64,${base64}`;
  }
  if (uploadError) {
    throw new Error(`Cookie upload failed: ${uploadError.message}`);
  }
  const {data} = client.storage.from(STORAGE_BUCKET).getPublicUrl(objectPath);
  // Only after the replacement is safely up. Fire-and-forget from there: a
  // leftover object costs 30 KB, and failing a cookie save over one would trade
  // a storage problem for a login problem.
  void removeSupersededCookieFile(previousUrl, objectPath);
  return data.publicUrl;
}

// Deletes the object a fresh upload just superseded.
//
// Deliberately narrow. It refuses anything outside profile-cookies/ so a legacy
// data: URL, a foreign source_url, or an avatar path can never be routed here
// by a caller passing the wrong field, and it no-ops when the two paths match,
// which is what an upsert onto the same key would look like.
//
// The bucket's delete policy is `owner = auth.uid()` for this prefix
// (supabase/migrations/20260805000001_storage.sql), so this reclaims your own
// supersedes and silently declines a teammate's. That is the common case --
// the repeated pusher is one signed-in session -- and the rest is what
// scripts/sweep-storage.mjs is for.
async function removeSupersededCookieFile(
    previousUrl: string | null | undefined, currentPath: string): Promise<void> {
  const client = optionalClient();
  if (!client || !previousUrl) {
    return;
  }
  const stale = storageObjectPath(previousUrl);
  if (!stale || stale === currentPath || !stale.startsWith('profile-cookies/')) {
    return;
  }
  const {error} = await client.storage.from(STORAGE_BUCKET).remove([stale]);
  if (error) {
    console.warn('cookieSets: could not remove the superseded cookie file', stale, error);
  }
}

// Empties `profile-cookies/<id>/` for sets that have just been hard-deleted.
//
// The three purge paths call this because "Delete forever" says, in
// ConfirmModals, that it removes the cookie files behind the sets -- and until
// this existed nothing in the app had ever called storage.remove(), so the
// files outlived the rows that named them. These are session cookies in a
// public bucket; leaving them behind is the version of this bug that matters.
//
// Fire-and-forget, after the rows are already gone. The delete is the thing the
// user asked for and it has succeeded by this point; a Storage hiccup must not
// turn into a failed purge, and scripts/sweep-storage.mjs collects whatever
// this could not (a teammate's uploads, which the bucket's `owner = auth.uid()`
// delete policy puts out of reach).
async function removeCookieFilesFor(ids: string[]): Promise<void> {
  const client = optionalClient();
  if (!client || ids.length === 0) {
    return;
  }
  for (const id of ids) {
    const folder = `profile-cookies/${id}`;
    const {data, error: listError} = await client.storage
        .from(STORAGE_BUCKET)
        .list(folder, {limit: 1000});
    if (listError || !data || data.length === 0) {
      continue;
    }
    const {error} = await client.storage
        .from(STORAGE_BUCKET)
        .remove(data.map((entry) => `${folder}/${entry.name}`));
    if (error) {
      console.warn('cookieSets: could not remove the cookie files for', id, error);
    }
  }
}

// Reads a cookie file back out, for the inspector.
//
// Not a plain fetch(url). The packaged renderer is served from file:// (vite's
// `base: './'`), so its requests carry `Origin: null` and depend on the
// bucket's CORS config in a way nothing else in the app does. The Storage
// client uses the same transport that already demonstrably reaches this bucket
// -- it is how uploadCookieFile got the file there in the first place. fetch()
// stays as the fallback for a source_url that is not a Storage object at all,
// which legacy rows can be.
export async function downloadCookieFile(url: string): Promise<string> {
  const inline = cookieRawFromDataUrl(url);
  if (inline !== null) {
    return inline;
  }
  const objectPath = storageObjectPath(url);
  const client = optionalClient();
  if (objectPath && client) {
    const {data, error} = await client.storage.from(STORAGE_BUCKET).download(objectPath);
    if (!error && data) {
      return data.text();
    }
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the cookie file (${response.status}).`);
  }
  return response.text();
}

// The tail of a Supabase public-object URL:
//   https://<ref>.supabase.co/storage/v1/object/public/global/profile-cookies/…
// Returns null for anything else, which is the signal to fall back to fetch.
function storageObjectPath(url: string): string | null {
  const marker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
  const at = url.indexOf(marker);
  if (at === -1) {
    return null;
  }
  return decodeURIComponent(url.slice(at + marker.length).split('?')[0]) || null;
}

// A bucket that is missing or write-protected is a deployment problem, not a
// user error: fall back to an inline data: URL so the cookie still reaches the
// browser on this machine instead of failing the whole operation.
export function isStorageNotWritable(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const candidate = error as {message?: string; statusCode?: string | number};
  const message = (candidate.message || '').toLowerCase();
  return message.includes('bucket not found') ||
    message.includes('row-level security') ||
    message.includes('permission') ||
    message.includes('unauthorized') ||
    String(candidate.statusCode || '') === '404';
}
