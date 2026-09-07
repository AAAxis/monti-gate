// The Scout Web Panel's sync card, tested at the level the bugs actually lived at:
// which branch wins.
//
// Two user-visible failures came out of this ordering, and both looked like
// launcher faults rather than panel faults:
//
//   - a profile paused after any failure reported "Launcher rejected the
//     request" forever, because `refused` was tested before `paused` and a
//     paused engine never makes another attempt that could clear the kind;
//   - a healthy relaunch opened on the previous launch's refusal, because the
//     run-token watermark reset in background.js cleared inSync/signature but
//     left lastErrorKind behind.
//
// Both are ordering/lifetime properties, not rendering, so they are testable
// without a DOM -- which is why classifySync now lives in its own file.
//
// The `tone` these cases assert reaches further than it used to: since the panel
// went to tabs, it also drives the Cookies tab's status dot, which is the only
// warning a reader gets while looking at another tab. A tone wrong here is now
// wrong in two places.
import {describe, expect, it} from 'vitest';
// @ts-expect-error plain-JS extension module without types
import {classifySync, relativeTime} from '../../extensions/cookie-manager/sync-status.js';

type Sync = Record<string, unknown>;

// A launched, reachable, otherwise unremarkable session. Every case below is
// this plus the one or two fields under test, so nothing passes by accident on
// a default that happens to short-circuit an earlier branch.
const live = (over: Sync = {}): Sync => ({
  available: true, reachable: true, paused: false, inSync: false,
  pushedAt: 0, pushedCount: 0, lastError: '', lastErrorKind: '', lastErrorSource: '',
  pushPending: false, lastSet: '', ...over,
});

const ERROR_KINDS = [
  'refused', 'other-workspace', 'rate-limited', 'internal', 'saved-none',
  'import-failed', 'server-error',
];

describe('classifySync branch order', () => {
  it('reports a window that was never launched from the launcher', () => {
    expect(classifySync(live({available: false})).title).toBe('Sync unavailable');
  });

  it('puts reachability above everything except availability', () => {
    // Both flags set: unreachable must win over paused, because reachability is
    // re-measured on every attempt while a pause is a user preference.
    expect(classifySync(live({reachable: false, paused: true})).title)
        .toBe('Launcher not reachable');
    // 'network' is the one kind that pairs with reachable:true only
    // transiently; it maps to the same card.
    expect(classifySync(live({lastErrorKind: 'network'})).title)
        .toBe('Launcher not reachable');
  });

  // The first of the two bugs, stated as a rule rather than a single case: no
  // error kind may outrank `paused`. Written as a loop so a kind added later
  // cannot quietly reintroduce the bug for its own branch.
  it.each(ERROR_KINDS)('reports "paused", not %s, when sync is paused', (kind) => {
    expect(classifySync(live({paused: true, lastErrorKind: kind})).title).toBe('Sync paused');
  });

  // The suppressed state: this window loaded a cookie set the profile is not
  // assigned to, so pushing would write the loaded set's cookies into the
  // assigned one. Same lifetime argument as `paused` -- there will be no next
  // attempt to disprove an old error kind -- so it outranks every kind for the
  // same reason, and outranks `paused` itself because it is the surprising one.
  it.each(ERROR_KINDS)('reports the suppressed state, not %s, while suppressed', (kind) => {
    const state = classifySync(live({pushSuppressed: true, lastErrorKind: kind}));
    expect(state.title).toBe('Sync paused');
    expect(String(state.detail)).toMatch(/isn’t assigned|aren’t being saved/);
  });

  it('names the loaded set, so the card says which one took the window', () => {
    const state = classifySync(live({pushSuppressed: true, loadedSetName: 'Client B'}));
    expect(String(state.detail)).toContain('Client B');
    // Amber, not red: nothing is broken. The engine is declining to guess where
    // these cookies should go, and a red card would send someone looking for a
    // fault that does not exist.
    expect(state.tone).toBe('warn');
  });

  it('says something usable even with no set name to show', () => {
    const state = classifySync(live({pushSuppressed: true}));
    expect(String(state.detail)).toMatch(/aren’t being saved/);
    expect(String(state.detail)).not.toContain('undefined');
  });

  // Reachability still wins: an unreachable launcher is a live measurement, and
  // "changes aren't being saved" would be true but beside the point.
  it('still puts an unreachable launcher above a suppressed push', () => {
    expect(classifySync(live({pushSuppressed: true, reachable: false})).title)
        .toBe('Launcher not reachable');
  });

  it('still reports each error kind when sync is not paused', () => {
    const titles = ERROR_KINDS.map((kind) => classifySync(live({lastErrorKind: kind})).title);
    expect(titles).toEqual([
      'Launcher rejected the request', 'Paused — another workspace', 'Rate limited',
      'Sync error', 'Nothing was saved', 'Pull failed', 'Launcher error',
    ]);
  });

  // These two arrive as different HTTP statuses for a reason and must not
  // collapse into one card: a dead token is fixed by relaunching, and a
  // workspace switch is fixed by switching back. Telling someone to relaunch
  // when their session is fine is the failure this separation prevents.
  it('does not tell a different-workspace session to relaunch', () => {
    const state = classifySync(live({lastErrorKind: 'other-workspace'}));
    expect(state.tone).toBe('warn');
    expect(String(state.detail)).not.toMatch(/[Rr]elaunch/);
  });

  it('keeps an unresolved error above pending and in-sync', () => {
    // The pre-existing rule this file must not regress: a stale green state
    // must never hide a real failure.
    expect(classifySync(live({lastErrorKind: 'internal', inSync: true, pushPending: true})).title)
        .toBe('Sync error');
  });

  it('falls through to pending, in sync, then never-synced', () => {
    expect(classifySync(live({pushPending: true})).title).toBe('Push pending');
    expect(classifySync(live({inSync: true, pushedCount: 3})).title).toBe('In sync with Launcher');
    expect(classifySync(live()).title).toBe('Not yet synced');
  });

  it('names both ordinary causes in the refusal copy', () => {
    // The old wording ("stale or invalid") described the symptom and sent
    // people looking for a corrupted profile. Neither real cause is a fault.
    const detail = String(classifySync(live({lastErrorKind: 'refused'})).detail);
    expect(detail).toMatch(/restarted/);
    expect(detail).toMatch(/12 hours/);
  });

  it('summarises a successful push with count, set and age', () => {
    const now = 1_700_000_000_000;
    const state = classifySync(
        live({inSync: true, pushedCount: 1, lastSet: 'Sophia', pushedAt: now - 5 * 60_000}), now);
    expect(state.tone).toBe('ok');
    // Singular, and the set name quoted -- "1 cookies" was a real complaint.
    expect(state.detail).toBe('1 cookie · saved to “Sophia” · 5 min ago');
  });
});

describe('relativeTime', () => {
  const now = 1_700_000_000_000;

  it('describes recent instants in the units a person would use', () => {
    expect(relativeTime(0, now)).toBe('');
    expect(relativeTime(now - 20_000, now)).toBe('just now');
    expect(relativeTime(now - 7 * 60_000, now)).toBe('7 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
  });

  it('falls back to a date past a day', () => {
    // Not asserting the formatted string: toLocaleDateString is locale- and
    // ICU-dependent, and pinning it here would make this test fail on a machine
    // rather than on a bug.
    expect(relativeTime(now - 50 * 3_600_000, now)).not.toMatch(/ago|just now/);
  });
});
