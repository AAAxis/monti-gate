import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {arrivalsSince, newestCreatedAt, readWatermark, seenKey, writeWatermark} from './newSince';
import type {Arrival} from './newSince';

const ME = 'user-me';
const THEM = 'user-them';

// Every fixture sits after this, so the watermark itself is never the reason a
// case passes or fails.
const MARK = '2026-08-01T00:00:00.000Z';

function arrival(patch: Partial<Arrival> = {}): Arrival {
  return {id: 'a1', created_at: '2026-08-02T00:00:00.000Z', created_by: THEM, ...patch};
}

function ids(items: Arrival[], watermark = MARK, userId: string | null = ME): string[] {
  return [...arrivalsSince(items, watermark, userId)];
}

describe('arrivalsSince', () => {
  it("counts a teammate's row added after the watermark", () => {
    expect(ids([arrival()])).toEqual(['a1']);
  });

  it('ignores a row I made myself', () => {
    expect(ids([arrival({created_by: ME})])).toEqual([]);
  });

  // The case that made the rule stricter than the code it replaced. A create
  // patches cloudState with the object the editor built, which carries
  // created_at but no created_by -- so a `created_by !== mine` test would glow
  // green at the person who just pressed Save.
  it('ignores a row with no known author', () => {
    expect(ids([arrival({created_by: null})])).toEqual([]);
    expect(ids([arrival({created_by: undefined})])).toEqual([]);
  });

  // An agent over MCP authenticates as me, so the row carries my uuid while
  // being none of my doing. This is the escape hatch automations have used
  // since the card glow existed.
  it('counts a foreign row even when it carries my own uuid', () => {
    expect(ids([arrival({created_by: ME, foreign: true})])).toEqual(['a1']);
  });

  it('ignores anything at or before the watermark', () => {
    expect(ids([arrival({created_at: MARK})])).toEqual([]);
    expect(ids([arrival({created_at: '2026-07-31T23:59:59.999Z'})])).toEqual([]);
  });

  it('counts the millisecond after the watermark', () => {
    expect(ids([arrival({created_at: '2026-08-01T00:00:00.001Z'})])).toEqual(['a1']);
  });

  it('ignores a row with no created_at', () => {
    expect(ids([arrival({created_at: null})])).toEqual([]);
    expect(ids([arrival({created_at: undefined})])).toEqual([]);
  });

  // Trash is a view, not a deletion: softDelete leaves the row in cloudState
  // and the tabs filter it out. Something thrown away is not an arrival even
  // when it arrived five minutes ago.
  it('ignores a soft-deleted row', () => {
    expect(ids([arrival({deleted_at: '2026-08-03T00:00:00.000Z'})])).toEqual([]);
  });

  // An empty watermark is what readWatermark returns on a machine that has
  // never looked. Everything is old there, not everything is new.
  it('finds nothing against an empty watermark', () => {
    expect(ids([arrival()], '')).toEqual([]);
  });

  // Signed out, or an org that has not resolved yet. A teammate's row is still
  // not mine, so it still counts -- there is no uuid it could match.
  it('treats a null user as matching nobody', () => {
    expect(ids([arrival()], MARK, null)).toEqual(['a1']);
  });

  it('keeps only the qualifying rows out of a mixed list', () => {
    expect(ids([
      arrival({id: 'theirs'}),
      arrival({id: 'mine', created_by: ME}),
      arrival({id: 'old', created_at: '2026-07-01T00:00:00.000Z'}),
      arrival({id: 'trashed', deleted_at: '2026-08-03T00:00:00.000Z'}),
      arrival({id: 'agent', created_by: ME, foreign: true}),
    ])).toEqual(['theirs', 'agent']);
  });
});

describe('newestCreatedAt', () => {
  it('returns the latest timestamp regardless of list order', () => {
    expect(newestCreatedAt([
      arrival({id: 'b', created_at: '2026-08-05T00:00:00.000Z'}),
      arrival({id: 'a', created_at: '2026-08-09T00:00:00.000Z'}),
      arrival({id: 'c', created_at: '2026-08-07T00:00:00.000Z'}),
    ])).toBe('2026-08-09T00:00:00.000Z');
  });

  // Mine counts here and not in arrivalsSince: the watermark records when this
  // machine last looked, not whose work it was.
  it('counts my own rows and soft-deleted ones', () => {
    expect(newestCreatedAt([
      arrival({created_at: '2026-08-05T00:00:00.000Z'}),
      arrival({created_by: ME, created_at: '2026-08-09T00:00:00.000Z'}),
    ])).toBe('2026-08-09T00:00:00.000Z');
  });

  it('returns an empty string for an empty or timestampless list', () => {
    expect(newestCreatedAt([])).toBe('');
    expect(newestCreatedAt([arrival({created_at: null})])).toBe('');
  });
});

// A Storage stand-in rather than jsdom. These tests are about what this module
// does with the four Storage methods it calls, not about the DOM, and
// vite.config.ts deliberately runs the suite in plain node -- see the comment on
// its `test` block. The stub also buys the one case a real Storage will not
// give up on demand: the renderer where localStorage throws outright.
function installStorage(broken = false): void {
  const entries = new Map<string, string>();
  const storage = {
    getItem(key: string): string | null {
      if (broken) {
        throw new Error('storage is not available');
      }
      return entries.has(key) ? entries.get(key) as string : null;
    },
    setItem(key: string, value: string): void {
      if (broken) {
        throw new Error('storage is not available');
      }
      entries.set(key, value);
    },
  };
  (globalThis as {window?: unknown}).window = {localStorage: storage};
}

describe('the watermark store', () => {
  beforeEach(() => {
    installStorage();
  });

  afterEach(() => {
    delete (globalThis as {window?: unknown}).window;
  });

  it('scopes the key by kind, workspace and person', () => {
    expect(seenKey('profiles', 'org-1', 'user-1')).toBe('scout:seen:profiles:org-1:user-1');
    expect(seenKey('cookies', null, null)).toBe('scout:seen:cookies:none:anon');
  });

  // A first read seeds now() and hands it straight back, so the first session
  // has a working baseline instead of no baseline at all.
  it('seeds a first read with the moment, and returns it', () => {
    const before = new Date().toISOString();
    const seeded = readWatermark('profiles', 'org-1', 'user-1');
    expect(seeded >= before).toBe(true);
    expect(seeded <= new Date().toISOString()).toBe(true);
    // Stable: the second read is the stored value, not a fresh now().
    expect(readWatermark('profiles', 'org-1', 'user-1')).toBe(seeded);
  });

  // The whole point of seeding to now() rather than to nothing: a fresh install
  // does not open onto a wall of green covering the entire workspace.
  it('leaves everything already in the workspace unmarked on a first run', () => {
    const seeded = readWatermark('profiles', 'org-1', 'user-1');
    const existing = [arrival({created_at: '2020-01-01T00:00:00.000Z'})];
    expect([...arrivalsSince(existing, seeded, ME)]).toEqual([]);
  });

  it('round-trips a written watermark', () => {
    writeWatermark('proxies', 'org-1', 'user-1', MARK);
    expect(readWatermark('proxies', 'org-1', 'user-1')).toBe(MARK);
  });

  // newestCreatedAt returns '' for a table that is empty or has no timestamps.
  // Writing that would erase the watermark and re-offer everything as new.
  it('refuses to write an empty watermark over a real one', () => {
    writeWatermark('proxies', 'org-1', 'user-1', MARK);
    writeWatermark('proxies', 'org-1', 'user-1', '');
    expect(readWatermark('proxies', 'org-1', 'user-1')).toBe(MARK);
  });

  // Two people signing into one install, and one person in two workspaces, both
  // get their own mark: the key carries all three of kind, org and user.
  it('keeps two people on one machine apart', () => {
    writeWatermark('cookies', 'org-1', 'user-1', MARK);
    // Seeded fresh for the second person rather than inheriting the first's
    // mark -- which is the failure this scoping exists to prevent.
    expect(readWatermark('cookies', 'org-1', 'user-2')).not.toBe(MARK);
    expect(readWatermark('cookies', 'org-1', 'user-1')).toBe(MARK);
    expect(readWatermark('profiles', 'org-1', 'user-1')).not.toBe(MARK);
    expect(readWatermark('cookies', 'org-2', 'user-1')).not.toBe(MARK);
  });

  // Degrading to "nothing is new" rather than "everything is": a read that
  // always fails would otherwise light up every row and every tab forever, with
  // no gesture available that could clear them.
  it('reports nothing new, and does not throw, when storage is unavailable', () => {
    installStorage(true);
    expect(readWatermark('profiles', 'org-1', 'user-1')).toBe('');
    expect(() => writeWatermark('profiles', 'org-1', 'user-1', MARK)).not.toThrow();
  });
});
