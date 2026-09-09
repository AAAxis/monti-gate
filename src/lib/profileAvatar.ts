// What `ScoutProfile.avatar` means, in the one place that decides.
//
// The column is a single text field carrying a tagged union -- `brand:<slug>`,
// an https URL, or nothing -- for the same reason folders.icon carries
// `flag:US` beside its FOLDER_ICONS keys: two columns can disagree with each
// other, and there is no state here where a pair says more than the prefix
// does. Everything that draws an avatar (the profiles table, the proxies
// table's Assigned to cell, the editor's preview) goes through parseAvatar, so
// the shape can only be misread in one place.
//
// Nothing here validates a brand slug against the catalog *by hand*: it looks
// it up through tagPresetFor(), which is the same alias-and-punctuation match
// the Tags column uses. So `brand:twitter` finds the X mark, and a slug the
// catalog has since dropped returns null -- which the caller draws as the
// initials plate. Downgrade, never break.
import {tagPresetFor} from './tags';
import type {TagPresetWithLogo} from '../data/tagPresets';

export const BRAND_PREFIX = 'brand:';

export type ParsedAvatar =
  | {kind: 'brand'; preset: TagPresetWithLogo}
  | {kind: 'image'; url: string};

export function parseAvatar(value: string | undefined | null): ParsedAvatar | null {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith(BRAND_PREFIX)) {
    const preset = tagPresetFor(raw.slice(BRAND_PREFIX.length));
    return preset ? {kind: 'brand', preset} : null;
  }
  // http:// as well as https:// because a self-hosted Storage or a pasted
  // intranet URL is the user's call, not ours. Anything else -- a data: URI, a
  // javascript: URL, a bare filename, a leftover value from a future format --
  // is not a picture this app is willing to put in an <img src>.
  if (/^https?:\/\//i.test(raw)) {
    return {kind: 'image', url: raw};
  }
  return null;
}

// The value to store for a brand pick. Kept here rather than spelled out at the
// two call sites so the prefix has exactly one definition.
export function brandAvatar(slug: string): string {
  return `${BRAND_PREFIX}${slug}`;
}
