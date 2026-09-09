// What colour a cookie-set's icon is drawn in.
//
// The set's own colour when it has one; its folder's otherwise, which is what
// every set's icon took before a set could carry one of its own -- so a
// workspace that never marks a single set looks exactly as it did.
//
// One function because four places ask: the Cookies table's Name cell, the
// Profiles table's Cookie set cell, that cell's picker and the profile dialog.
// A set that is green in its own library and grey in a profile's dialog is not
// a mark, and four copies of `cookie.color || folder?.color` is how that
// happens.
import type {ScoutCookie, ScoutFolder} from '../types';

export function cookieSetColor(
    cookie: Pick<ScoutCookie, 'color' | 'folder_id'>,
    folders: ScoutFolder[]): string | undefined {
  if (cookie.color) {
    return cookie.color;
  }
  return folders.find((folder) => folder.id === cookie.folder_id)?.color || undefined;
}
