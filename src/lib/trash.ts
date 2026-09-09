// Sentinel folder_id used to view Trash in the profiles folder bar; never
// written to a profile's actual folder_id.
export const TRASH_FOLDER_ID = '__trash__';
export const TRASH_RETENTION_DAYS = 30;

export function daysUntilPurge(deletedAt: string): number {
  const purgeAt = Date.parse(deletedAt) + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

// Anything soft-deleted before this instant has served its time in Trash. Sent
// straight to the delete statement so the purge is one round trip rather than a
// filter-and-rewrite of the whole profiles array.
export function trashCutoffIso(): string {
  return new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// Mirrors the profiles_id_fs_safe CHECK in supabase/migrations/0005. Ids are
// also directory names under E:\ScoutProfiles, and the database is what
// enforces that -- this is only here so the CSV importer, which takes
// profile_id straight from a user-supplied file, can name the offending row in
// its skipped list instead of surfacing a raw constraint violation.
export function isFsSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value.length <= 128;
}
