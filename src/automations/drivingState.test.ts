// The orange border's state file, tested against the real module main.cjs drives
// (electron/automation/driving-state.cjs, typed by its hand-written .d.cts).
//
// Every assertion here is about a window that lies. A border stuck on says
// "something is driving this" at a person who is driving it themselves, and
// teaches them to ignore the only warning the product has; a border that never
// comes on is the feature not existing. Both are silent -- nothing throws, no
// test elsewhere in this repo would notice, and the only way to find out is to
// sit and watch a browser window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AI_IDLE_MS, FILE_NAME, HEARTBEAT_MS, MAX_LABEL, TTL_MS, createDrivingState,
} from '../../electron/automation/driving-state.cjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scout-driving-'));

// One directory per profile id, as the real resolver does (ScoutProfiles/<id>).
function harness() {
  const root = tempDir();
  let clock = 1_700_000_000_000;
  const state = createDrivingState({
    resolveUserDataDir: (profileId) => {
      if (!profileId) return '';
      const dir = path.join(root, profileId);
      fs.mkdirSync(dir, {recursive: true});
      return dir;
    },
    now: () => clock,
  });
  return {
    state,
    at: () => clock,
    advance: (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
    read: (profileId: string) => {
      const file = path.join(root, profileId, FILE_NAME);
      return fs.existsSync(file) ?
        JSON.parse(fs.readFileSync(file, 'utf8')) :
        null;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('an automation run', () => {
  it('writes an active state naming the automation', () => {
    const h = harness();
    h.state.runActive('p1', 'Daily login');
    expect(h.read('p1')).toEqual({
      active: true,
      kind: 'automation',
      label: 'Daily login',
      expiresAt: h.at() + TTL_MS,
    });
  });

  // Idle is the file's absence, not `active: false`. A window that has never run
  // anything has no file at all, so if inactive had a second spelling the browser
  // would need two code paths to mean one thing.
  it('removes the file when the run ends rather than writing active:false', () => {
    const h = harness();
    h.state.runActive('p1', 'Daily login');
    h.state.idle('p1');
    expect(h.read('p1')).toBeNull();
  });

  // The whole answer to "the launcher was killed mid-run": nothing is left to
  // clear the file, so the file has to expire on its own.
  it('pushes the expiry forward on every step, so a long run stays believable', () => {
    const h = harness();
    h.state.runActive('p1', 'Daily login');
    const first = h.read('p1').expiresAt;
    h.advance(30_000);
    h.state.runActive('p1', 'Daily login');
    expect(h.read('p1').expiresAt).toBe(first + 30_000);
    // And it is always ahead of the clock the browser will compare it against.
    expect(h.read('p1').expiresAt).toBeGreaterThan(h.at());
  });

  // A name comes off a user-typed automation. A 400-character one would render
  // as a pill wider than the window it is warning about.
  it('caps the label rather than trusting its length', () => {
    const h = harness();
    h.state.runActive('p1', 'x'.repeat(500));
    expect(h.read('p1').label).toHaveLength(MAX_LABEL);
  });

  it('writes an empty label rather than "undefined" for a nameless run', () => {
    const h = harness();
    h.state.runActive('p1', undefined);
    expect(h.read('p1').label).toBe('');
  });

  it('keeps profiles apart', () => {
    const h = harness();
    h.state.runActive('p1', 'One');
    h.state.runActive('p2', 'Two');
    h.state.idle('p1');
    expect(h.read('p1')).toBeNull();
    expect(h.read('p2').label).toBe('Two');
  });
});

// The bug the heartbeat exists for: the runner logs AFTER a step returns, so
// nothing refreshed the expiry WHILE a step ran. step-schema.json allows a
// `wait` of up to 300s and a per-step timeoutMs has no ceiling, so a long step
// took the border down mid-run and brought it back on the next log line. A
// window that stops glowing in the middle of being driven is worse than one
// that never glowed: it teaches the user the border means nothing.
describe('a run with a step longer than the TTL', () => {
  it('keeps the border up through a 300s step with no log in between', () => {
    const h = harness();
    h.state.runActive('p1', 'Slow scrape');
    // One runActive, then nothing but wall-clock -- exactly what a `wait: 300`
    // step looks like from here.
    for (let elapsed = 0; elapsed < 300_000; elapsed += HEARTBEAT_MS) {
      h.advance(HEARTBEAT_MS);
      const state = h.read('p1');
      expect(state).not.toBeNull();
      expect(state.expiresAt).toBeGreaterThan(h.at());
    }
    expect(h.read('p1')).toMatchObject({kind: 'automation', label: 'Slow scrape'});
  });

  it('beats often enough that one missed beat still leaves the file believable', () => {
    expect(HEARTBEAT_MS * 2).toBeLessThan(TTL_MS);
  });

  it('keeps the run\'s own label while it beats', () => {
    const h = harness();
    h.state.runActive('p1', 'Daily login');
    h.advance(HEARTBEAT_MS * 3);
    expect(h.read('p1').label).toBe('Daily login');
  });
});

// The other half of the same contract, and the reason the fix is a heartbeat
// rather than a bigger TTL: a launcher that dies mid-run stops beating, and the
// file it left behind expires on schedule.
describe('when the run ends or the launcher stops', () => {
  it('stops beating once the run is idle, so the file stays gone', () => {
    const h = harness();
    h.state.runActive('p1', 'Daily login');
    h.state.idle('p1');
    h.advance(HEARTBEAT_MS * 4);
    expect(h.read('p1')).toBeNull();
  });

  it('stops beating on idleAll, so quit does not resurrect a border', () => {
    const h = harness();
    h.state.runActive('p1', 'One');
    h.state.runActive('p2', 'Two');
    h.state.idleAll();
    h.advance(HEARTBEAT_MS * 4);
    expect(h.read('p1')).toBeNull();
    expect(h.read('p2')).toBeNull();
  });

  // The written expiry is always at most TTL_MS out, whatever the heartbeat
  // does. That is what the browser compares against when nothing is left to
  // clear the file.
  it('never writes an expiry further out than the TTL', () => {
    const h = harness();
    h.state.runActive('p1', 'Daily login');
    h.advance(HEARTBEAT_MS * 5);
    expect(h.read('p1').expiresAt).toBeLessThanOrEqual(h.at() + TTL_MS);
  });
});

describe('an AI or MCP tool', () => {
  it('writes an active state with no name to show', () => {
    const h = harness();
    h.state.aiActive('p1');
    expect(h.read('p1')).toMatchObject({active: true, kind: 'ai', label: ''});
  });

  // The MCP tools are one-shot: each opens a CDP socket, does one thing and
  // closes it. An agent working a page does that every few seconds, so a border
  // that tracked the socket would blink rather than warn.
  it('holds the border up through the idle window after the last call', () => {
    const h = harness();
    h.state.aiActive('p1');
    h.advance(AI_IDLE_MS - 1000);
    expect(h.read('p1')).not.toBeNull();
    h.advance(2000);
    expect(h.read('p1')).toBeNull();
  });

  it('restarts the idle window on each call, so a working agent never blinks', () => {
    const h = harness();
    h.state.aiActive('p1');
    for (let i = 0; i < 5; i++) {
      h.advance(AI_IDLE_MS - 1000);
      h.state.aiActive('p1');
      expect(h.read('p1')).not.toBeNull();
    }
    h.advance(AI_IDLE_MS + 1000);
    expect(h.read('p1')).toBeNull();
  });

  // The written expiry has to outlast the idle window, or the border would blink
  // off at the TTL boundary while calls were still arriving.
  it('writes an expiry no earlier than its own idle window', () => {
    const h = harness();
    h.state.aiActive('p1');
    expect(h.read('p1').expiresAt).toBeGreaterThanOrEqual(h.at() + AI_IDLE_MS);
  });
});

// A run and an AI marker can overlap: an MCP call starts a run, and the run then
// drives the same window. The run is the more specific truth about the same fact
// and it is the one with a name worth reading.
describe('when a run and an AI tool overlap', () => {
  it('lets a run replace an AI marker', () => {
    const h = harness();
    h.state.aiActive('p1');
    h.state.runActive('p1', 'Daily login');
    expect(h.read('p1')).toMatchObject({kind: 'automation', label: 'Daily login'});
  });

  it('does not let an AI call downgrade a running automation', () => {
    const h = harness();
    h.state.runActive('p1', 'Daily login');
    h.state.aiActive('p1');
    expect(h.read('p1')).toMatchObject({kind: 'automation', label: 'Daily login'});
  });

  // The bug this is here to prevent: the AI marker's pending clear fires eight
  // seconds later and takes the run's border down with it, mid-run.
  it('does not let a pending AI clear take a run\'s border down', () => {
    const h = harness();
    h.state.aiActive('p1');
    h.state.runActive('p1', 'Daily login');
    h.advance(AI_IDLE_MS * 2);
    expect(h.read('p1')).toMatchObject({kind: 'automation'});
  });
});

describe('cleanup', () => {
  // These files outlive this process -- a browser window can too. Nothing would
  // clear them once the launcher is gone, and the TTL is the backstop for a
  // crash, not for an ordinary quit.
  it('clears every profile it marked, for quit', () => {
    const h = harness();
    h.state.runActive('p1', 'One');
    h.state.aiActive('p2');
    h.state.idleAll();
    expect(h.read('p1')).toBeNull();
    expect(h.read('p2')).toBeNull();
  });

  it('survives being told to clear a profile it never marked', () => {
    const h = harness();
    expect(() => h.state.idle('never-seen')).not.toThrow();
    expect(() => h.state.idleAll()).not.toThrow();
  });

  // A launch is a window nothing is driving yet, and idle() is called on the way
  // in. It must not resurrect the AI timer's clear for a profile relaunched
  // within the idle window.
  it('does not reactivate after idle when a stale AI timer fires', () => {
    const h = harness();
    h.state.aiActive('p1');
    h.state.idle('p1');
    h.advance(AI_IDLE_MS * 2);
    expect(h.read('p1')).toBeNull();
  });
});

// A profile whose directory cannot be resolved (deleted mid-run) or written to
// must cost a border, never a run. Nothing here is worth throwing out of
// sendRunEvent, which is on the path of every run in the app.
describe('when the profile directory is not there', () => {
  it('writes nothing and throws nothing for an unresolvable profile', () => {
    const state = createDrivingState({resolveUserDataDir: () => ''});
    expect(() => state.runActive('p1', 'Daily login')).not.toThrow();
    expect(() => state.aiActive('p1')).not.toThrow();
    expect(() => state.idle('p1')).not.toThrow();
  });

  it('throws nothing for a missing profile id', () => {
    const h = harness();
    expect(() => h.state.runActive('', 'Daily login')).not.toThrow();
    expect(() => h.state.aiActive('')).not.toThrow();
  });

  it('throws nothing when the directory cannot be written', () => {
    const state = createDrivingState({
      resolveUserDataDir: () => path.join(os.tmpdir(), 'scout-does-not-exist', 'nope'),
    });
    expect(() => state.runActive('p1', 'Daily login')).not.toThrow();
    expect(() => state.idle('p1')).not.toThrow();
  });
});
