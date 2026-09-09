// Where a live-cookie push from a running profile lands: the one decision that
// must agree between the bridge (which writes) and anyone reading the Cookies
// tab. Kept as a pure function so the six ways it can go are unit-tested
// without a workspace.
import type {ScoutCookie, ScoutProfile} from '../types';

export function liveSetName(profileName: string): string {
  return `${profileName} (live)`;
}

// What a launch actually consumes, resolved the one way that agrees with
// buildLaunchPayload (src/lib/launch.ts) and with the cookie-sync pull route:
// 'saved' mode with a cookie_id that still resolves to a non-trashed row.
// 'paste' mode ignores cookie_id entirely -- a profile can carry a stale one
// from before it was switched back, and mode is what decides whether that id
// means anything, not whether it happens to be set.
//
// Kept here (not duplicated per caller) because it is the load-bearing half
// of resolveLiveSetAction below: matching by id first is what stops a push
// from one profile ever landing on a different profile's or the library's
// same-named set.
export function assignedSet(profile: ScoutProfile, sets: ScoutCookie[]): ScoutCookie | null {
  if (profile.cookie_mode !== 'saved' || !profile.cookie_id) {
    return null;
  }
  return sets.find((item) => item.id === profile.cookie_id && !item.deleted_at) || null;
}

// The assigned set is only "ours to overwrite" when this flow created it --
// recognized by the naming convention, in both spellings (addCookieSet derives
// the set name from the uploaded file name, which carries .json). Anything
// else -- an ordinary library set, a trashed set, a set named for a profile
// that has since been renamed -- gets a fresh set rather than a surprise
// overwrite of something the user curated by hand.
//
// Matching starts from assignedSet (by id), not by scanning `sets` for a
// name match: two profiles can perfectly legally share a name (and so the
// same "«name» (live)" convention), and a name-only match would let profile
// A's push overwrite profile B's live set, or a stray same-named library set
// that neither profile owns.
export function resolveLiveSetAction(
    profile: ScoutProfile,
    sets: ScoutCookie[],
): {kind: 'update'; set: ScoutCookie} | {kind: 'create'; name: string} {
  const name = liveSetName(profile.name);
  const assigned = assignedSet(profile, sets);
  if (assigned && (assigned.name === name || assigned.name === `${name}.json`)) {
    return {kind: 'update', set: assigned};
  }
  return {kind: 'create', name};
}

// The library-save half of a cookie push (`saveAs` on
// /v1/cookies/push-from-profile): a user-chosen name for a NEW set, not the
// auto-managed live set above. `saveAs` arrives as request DATA over the
// run-token route, not as an authorization input -- run-token.cjs only
// type-gates it (string or absent) before handing it to
// useAutomationBridge.ts, which calls this to decide whether it is usable
// before ever calling addCookieSet. Kept pure and here (not inline in the
// bridge) for the same reason resolveLiveSetAction is: it is the one place
// this decision is made, so the extension's own trim/cap (defense in depth,
// not the source of truth) and the launcher's can never quietly disagree.
const SET_NAME_MAX_LENGTH = 80;

// True for the C0 controls, DEL, and the C1 controls -- everything a cookie
// set's name (a Postgres column and, via addCookieSet, part of a Storage file
// name) has no business carrying. Written as a code-point filter rather than
// a regex /[\x00-\x1f\x7f]/ so the source file never has to hold literal
// control bytes for a linter or an editor to mangle.
function isControlCodePoint(codePoint: number): boolean {
  return (codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);
}

export function sanitizeSetName(
    raw: string): {ok: true; name: string} | {ok: false; error: string} {
  // Stripped before trimming, not just at the ends -- a name is about to
  // become a cookie_sets.name and a Storage file name, neither of which
  // should carry control characters anywhere inside it.
  const stripped = Array.from(raw)
      .filter((character) => !isControlCodePoint(character.codePointAt(0) || 0))
      .join('');
  const trimmed = stripped.trim();
  if (!trimmed) {
    return {ok: false, error: 'Enter a name for this cookie set.'};
  }
  // Trimmed again after the cap: slicing mid-string can leave trailing
  // whitespace at the new boundary, and a name of 81 spaces would otherwise
  // cap down to a non-empty run of spaces instead of being refused.
  const capped = trimmed.length > SET_NAME_MAX_LENGTH ?
    trimmed.slice(0, SET_NAME_MAX_LENGTH).trim() :
    trimmed;
  if (!capped) {
    return {ok: false, error: 'Enter a name for this cookie set.'};
  }
  return {ok: true, name: capped};
}
