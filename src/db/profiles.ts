import type {ScoutProfile} from '../types';
import {AVATAR_MAX_BYTES, imageExtensionFor} from './account';
import {optionalClient, raise, requireClient, STORAGE_BUCKET} from './client';
import {profilePatchToRow, profileToRow, rowToProfile} from './mappers';
import type {ProfileRow} from './rows';

// No `notes`. That column was dead from the baseline -- never mapped, never
// written, rejected by the API's update whitelist -- and 20260807000000 drops it
// in favour of profile_notes, the attributed thread. See src/db/profileNotes.ts.
const COLUMNS =
  'id,org_id,name,folder_id,proxy_id,cookie_set_id,fingerprint,status,tags,start_urls,' +
  'command_line_switches,created_by,deleted_at,updated_at,created_at,color,proxy_mode,' +
  'cookie_mode,cookie_import_path,cookie_import_url,cookie_import_name,cookie_import_count,' +
  'email,password,login_url,automation_id,automation_vars,avatar,assigned_to';

// Trashed profiles come back too -- the Trash view reads the same list and
// filters on deleted_at, exactly as it did against the blob.
export async function list(orgId: string): Promise<ScoutProfile[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('browser_profiles')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('created_at', {ascending: true});
  raise(error, 'profiles.list');
  return ((data || []) as unknown as ProfileRow[]).map(rowToProfile);
}

// Deliberately NOT an upsert.
//
// trg_profile_limit is BEFORE INSERT, and Postgres fires BEFORE INSERT triggers
// for `insert ... on conflict do update` even when the conflict path is taken --
// verified against this database. So an upsert used to edit an existing profile
// raises profile_limit_reached whenever the org is at its cap, which would mean
// a free-tier org with 5 profiles could not edit any of them. Callers know
// whether the profile is new; they pick.
//
// The id is never regenerated in either path: it is also the on-disk directory
// name under E:\ScoutProfiles\<id>, so changing it orphans that profile's
// browser data.
export async function create(orgId: string, profile: ScoutProfile): Promise<void> {
  const client = requireClient();
  const {error} = await client.from('browser_profiles').insert(profileToRow(orgId, profile));
  raise(error, 'profiles.create');
}

// Writes every editable column of an existing row. `id` and `org_id` are
// stripped from the payload: they are the lookup keys, not fields to rewrite.
export async function replace(orgId: string, profile: ScoutProfile): Promise<void> {
  const client = requireClient();
  const {id: _id, org_id: _orgId, ...row} = profileToRow(orgId, profile);
  const {error} = await client
      .from('browser_profiles')
      .update(row)
      .eq('org_id', orgId)
      .eq('id', profile.id);
  raise(error, 'profiles.replace');
}

// Create-or-replace, decided by the caller rather than by the database, for the
// reason in the comment above.
export async function save(
    orgId: string, profile: ScoutProfile, exists: boolean): Promise<void> {
  return exists ? replace(orgId, profile) : create(orgId, profile);
}

// Only the keys present in `patch` are written, so a worker changing a status
// cannot clobber another worker's proxy assignment on the same row.
export async function update(
    orgId: string, id: string, patch: Partial<ScoutProfile>): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('browser_profiles')
      .update(profilePatchToRow(patch))
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'profiles.update');
}

export async function softDelete(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const now = new Date().toISOString();
  const {error} = await client
      .from('browser_profiles')
      .update({deleted_at: now, updated_at: now})
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'profiles.softDelete');
}

// Restoring crosses the profile limit too -- trg_profile_limit_restore fires on
// exactly this update, so it can raise profile_limit_reached.
export async function restore(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const {error} = await client
      .from('browser_profiles')
      .update({deleted_at: null, updated_at: new Date().toISOString()})
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'profiles.restore');
}

export async function purge(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const {error} = await client
      .from('browser_profiles')
      .delete()
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'profiles.purge');
}

// Uploads a picture for a profile's avatar and returns its public URL. The
// caller stores that URL in ScoutProfile.avatar; nothing here writes the row,
// because the editor holds an unsaved draft and a picture that landed in
// Storage before Cancel was pressed should not have changed the profile.
//
// Scoped by org and profile so the object is findable from its path alone, and
// timestamped rather than fixed for the reason account.uploadAvatar documents:
// a stable path is served from cache by URL alone, so a replacement picture
// would keep showing as the old one on every surface until the cache expired.
// Superseded objects are left in place -- a few KB each, and deleting the old
// one on upload would race a second worker still rendering it.
export async function uploadAvatar(
    orgId: string, profileId: string, file: File): Promise<string> {
  const client = requireClient();
  if (file.size > AVATAR_MAX_BYTES) {
    throw new Error('That image is larger than 5 MB. Pick a smaller one.');
  }
  const objectPath =
    `profile-avatars/${orgId}/${profileId}/${Date.now()}.${imageExtensionFor(file)}`;
  const {error} = await client.storage
      .from(STORAGE_BUCKET)
      .upload(objectPath, file, {contentType: file.type || 'image/png', upsert: true});
  if (error) {
    throw new Error(`Could not upload the image: ${error.message}`);
  }
  return client.storage.from(STORAGE_BUCKET).getPublicUrl(objectPath).data.publicUrl;
}

// Empty Trash: everything with a deleted_at, whatever its age.
//
// Scoped by deleted_at rather than by an id list, which is what makes it safe to
// offer without selecting anything first -- there is no way for the statement to
// reach a profile that is not in Trash. It also picks up anything trashed on
// another device while the dialog was open, where an id list gathered up front
// would quietly miss it. Returns the ids removed so the caller can patch local
// state and report a count.
export async function purgeAll(orgId: string): Promise<string[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('browser_profiles')
      .delete()
      .eq('org_id', orgId)
      .not('deleted_at', 'is', null)
      .select('id');
  raise(error, 'profiles.purgeAll');
  return ((data || []) as Array<{id: string}>).map((row) => row.id);
}

// The 30-day Trash expiry, as one statement instead of a filter-and-rewrite of
// the whole array. Returns the ids it removed so the caller can report a count.
export async function purgeExpired(orgId: string, cutoffIso: string): Promise<string[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('browser_profiles')
      .delete()
      .eq('org_id', orgId)
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoffIso)
      .select('id');
  raise(error, 'profiles.purgeExpired');
  return ((data || []) as Array<{id: string}>).map((row) => row.id);
}
