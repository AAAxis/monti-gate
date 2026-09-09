// What arrived since you last looked.
//
// A workspace is shared, so rows appear on your machine that you did not put
// there -- a teammate on another install, or an agent over MCP. This module is
// the whole rule for noticing that: which rows are new to you, and the
// per-machine watermark that decides "since when".
//
// It began as thirty lines inside AutomationsTab, which glowed a card green for
// one visit. Everything here is that idea, minus the tab: the sidebar counts and
// the row tint on Profiles, Proxies and Cookies all read these two functions.
//
// localStorage rather than a column, for the reason introSeen.ts gives: what
// this machine has shown you is a property of the install, not of the workspace.
// Two people sharing an org each get their own count, and the same person on a
// second machine gets shown the arrivals again there -- which is right, because
// they have not seen them there.

// The four things a person adds to a workspace. Deliberately NOT reusing TableId
// from tables/columns.ts: that union is the three tables the column picker
// knows, and its own comment forbids adding automations to it. This one is
// about arrivals, and automations have those too.
export type NewKind = 'profiles' | 'proxies' | 'cookies' | 'automations';

export const NEW_KINDS: readonly NewKind[] = ['profiles', 'proxies', 'cookies', 'automations'];

// The shape the rule needs, whatever the row actually is. Callers narrow their
// own types down to this at the boundary, which is what keeps per-table
// knowledge -- `created_via === 'mcp'`, soft-delete columns that only two of the
// four tables have -- out of here.
export type Arrival = {
  id: string;
  created_at?: string | null;
  created_by?: string | null;
  // Soft-deleted rows live in Trash. Something thrown away is not an arrival,
  // even when it arrived five minutes ago.
  deleted_at?: string | null;
  // "Somebody else's doing, whatever created_by says." Set by the automations
  // mapping for created_via === 'mcp': an agent writing over MCP authenticates
  // as you, so the row carries your uuid while being none of your work.
  foreign?: boolean;
};

export function seenKey(kind: NewKind, orgId: string | null, userId: string | null): string {
  return `scout:seen:${kind}:${orgId || 'none'}:${userId || 'anon'}`;
}

// The watermark for one kind, seeding it to now() when absent.
//
// The seed is the important half, and it is why a fresh install -- or the first
// launch after this shipped, since the old scout:automations-seen key is not
// read -- does not open onto a wall of green covering everything the workspace
// has ever contained. Everything already there predates now(), so nothing
// qualifies.
//
// The seed is RETURNED rather than swallowed, which is the one place this
// departs from the thirty lines it replaces. Those returned '' on a first read,
// so the whole first session had no baseline at all and a teammate's row
// arriving while you sat there went unmarked until the next launch. Handing
// back the seed makes the first session behave like every later one and costs
// nothing: the comparison it enables is against a timestamp everything existing
// is already older than.
//
// So '' now means one thing only -- storage is unreadable.
export function readWatermark(
    kind: NewKind, orgId: string | null, userId: string | null): string {
  const key = seenKey(kind, orgId, userId);
  try {
    const stored = window.localStorage.getItem(key);
    if (stored) {
      return stored;
    }
    const seed = new Date().toISOString();
    window.localStorage.setItem(key, seed);
    return seed;
  } catch {
    // Storage can throw outright when the renderer has no access to it. '' is
    // the safe direction: no counts and no green, rather than a permanent wall
    // of both that no amount of looking could ever clear.
    return '';
  }
}

export function writeWatermark(
    kind: NewKind, orgId: string | null, userId: string | null, value: string): void {
  if (!value) {
    return;
  }
  try {
    window.localStorage.setItem(seenKey(kind, orgId, userId), value);
  } catch {
    // Nothing to do. Worst case the same rows are offered as new once more.
  }
}

// Which of these arrived after the watermark and were somebody else's doing.
//
// The authorship test is `created_by is a uuid AND it is not mine`, and the
// "is a uuid" half is load-bearing in three places at once:
//
//  1. Rows written before their table had the column. profiles.created_by is
//     null for everything predating 2026-08-05-teams.sql, and proxies and cookie
//     sets for everything predating 20260815. Those are old, not new.
//  2. Someone who has left the workspace -- the FK is ON DELETE SET NULL, so
//     their rows go null rather than disappearing.
//  3. The optimistic local row, which is the one that would actually have bitten
//     a user. Every create patches cloudState with the object the editor built,
//     and that object has created_at but no created_by: the column's DEFAULT
//     auth.uid() fills it server-side, which is why profileToRow omits it. Under
//     a `created_by !== mine` test, a profile you had just made would glow green
//     at you until the next window-focus refresh.
//
// Timestamps compare as strings. Both sides are ISO-8601 UTC from Postgres
// timestamptz or from toISOString(), which are fixed-width and lexicographically
// ordered -- Date parsing per row per render would buy nothing.
export function arrivalsSince(
    items: readonly Arrival[], watermark: string, userId: string | null): Set<string> {
  const found = new Set<string>();
  if (!watermark) {
    return found;
  }
  for (const item of items) {
    if (!item.created_at || item.created_at <= watermark || item.deleted_at) {
      continue;
    }
    if (item.foreign || (item.created_by && item.created_by !== userId)) {
      found.add(item.id);
    }
  }
  return found;
}

// The value to advance a watermark to: the newest arrival, mine included.
//
// Mine included on purpose. The watermark answers "when did this machine last
// look", not "what have I been shown" -- excluding my own rows would leave the
// mark behind them, so every later comparison would still be walking over
// timestamps already settled. Whose row it was is arrivalsSince's question.
export function newestCreatedAt(items: readonly Arrival[]): string {
  let newest = '';
  for (const item of items) {
    if (item.created_at && item.created_at > newest) {
      newest = item.created_at;
    }
  }
  return newest;
}
