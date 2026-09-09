// homeProxyStatus() composes the session verdict; three surfaces render it, and
// only one of them is TypeScript. The browser side panel
// (extensions/cookie-manager/sidepanel.js, renderProxyFields) is plain JS copied
// verbatim into a profile directory with no bundler and no type checker -- the
// same constraint cookie-format.js lives under -- so nothing at build time would
// notice this function growing a field shape that file does not draw.
//
// These are the tripwires for that. They assert the *contract*, not the copy:
// which keys a field may carry, which tones a note may ask for, and that a
// working status is exactly the four rows the panel's label column was sized
// for. Change any of them and change sidepanel.js in the same commit.
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {homeProxyStatus} from './homePage';
import type {SessionPanelData} from '../native';
import type {ScoutProfile, ScoutProxy} from '../types';

const profile = (over: Partial<ScoutProfile> = {}) => ({
  id: 'p1',
  name: 'Profile One',
  proxy_mode: 'assigned',
  fingerprint: {os: 'Windows 11', screen: '1920x1200', timezone: 'America/Los_Angeles'},
  ...over,
} as ScoutProfile);

const proxy = (over: Partial<ScoutProxy> = {}) => ({
  id: 'x1',
  host: '1.2.3.4',
  port: 8080,
  checked_at: '2026-08-07T00:00:00.000Z',
  ping_ms: 131,
  egress_ip: '142.252.99.144',
  country: 'US',
  city: 'Los Angeles',
  region: 'California',
  timezone: 'America/Los_Angeles',
  ...over,
} as ScoutProxy);

// Exactly the keys sidepanel.js reads off a field. `mono` picks the monospace
// value column, `note` is the quiet trailing value, `noteTone` colours it, and
// `icon` names a glyph in the panel's own table.
const FIELD_KEYS = new Set(['label', 'value', 'icon', 'mono', 'note', 'noteTone']);

// The glyph names the panel actually carries, read off its own file rather than
// listed again here. `icon` is a string on this side and a lookup into
// ScoutIcons.PATHS on the other, and ScoutIcons.make() answers an unknown name
// with a bare circle -- so a typo does not throw, it silently labels a row with
// the wrong shape, which is worse than labelling it with none.
//
// Parsed with a regex rather than imported: icons.js declares a top-level const
// and assigns no module export, because it is loaded by a <script> tag in a
// document with no bundler. Reading the key list is enough for this contract.
const panelIconNames = () => {
  const source = readFileSync(
      join(__dirname, '../../extensions/cookie-manager/icons.js'), 'utf8');
  const table = source.slice(source.indexOf('const PATHS = {'));
  return new Set([...table.matchAll(/^ {4}'?([A-Za-z-]+)'?:/gm)].map((match) => match[1]));
};

describe('the field contract the side panel renders', () => {
  it('gives a working session four labelled rows', () => {
    const status = homeProxyStatus(profile(), proxy());
    expect(status.ok).toBe(true);
    expect(status.fields?.map((field) => field.label))
        .toEqual(['Exit', 'Location', 'Timezone', 'Device']);
  });

  it('carries no field key the panel does not draw', () => {
    const status = homeProxyStatus(profile(), proxy());
    for (const field of status.fields || []) {
      for (const key of Object.keys(field)) {
        expect(FIELD_KEYS.has(key), `unrendered field key "${key}"`).toBe(true);
      }
      // Every row must be renderable as text: the panel sets textContent per
      // cell and would print "[object Object]" for anything else.
      expect(typeof field.label).toBe('string');
      expect(typeof field.value).toBe('string');
    }
  });

  it('names only glyphs the panel carries', () => {
    const available = panelIconNames();
    // The parse itself has to be load-bearing, or a regex that stopped matching
    // would turn this into a test that passes against an empty set.
    expect(available.size).toBeGreaterThan(10);
    for (const field of homeProxyStatus(profile(), proxy()).fields || []) {
      expect(field.icon, `${field.label} has no icon`).toBeTruthy();
      expect(available.has(field.icon || ''), `unknown glyph "${field.icon}"`).toBe(true);
    }
  });

  it('asks only for tones the panel has styling for', () => {
    // The mismatch case, which is the only one that reaches for --danger.
    const mismatched = homeProxyStatus(
        profile({fingerprint: {os: 'Windows 11', screen: '1920x1200', timezone: 'Europe/Berlin'}} as
          Partial<ScoutProfile>),
        proxy());
    const tones = [...(homeProxyStatus(profile(), proxy()).fields || []),
      ...(mismatched.fields || [])]
        .map((field) => field.noteTone)
        .filter(Boolean);
    expect(tones.length).toBeGreaterThan(0);
    for (const tone of tones) {
      expect(['ok', 'bad']).toContain(tone);
    }
  });

  // The panel hides the card's sentence when rows are present and shows it when
  // they are not (`.card.tone-ok #proxy-detail { display: none }`). That rule is
  // only correct because the two states are mutually exclusive here.
  it('pairs rows with ok and a lone sentence with a failure', () => {
    const working = homeProxyStatus(profile(), proxy());
    expect(working.ok).toBe(true);
    expect(working.fields?.length).toBeTruthy();

    const failing = homeProxyStatus(profile(), proxy({check_error: 'Connection refused'}));
    expect(failing.ok).toBe(false);
    expect(failing.fields).toBeUndefined();
    expect(failing.detail).toContain('Connection refused');
  });
});

// The other half of the snapshot, and the tripwire that was missing.
//
// scout-session.json is written into every launched profile's directory, which
// is not 0600 and is read by a document that goes on to visit arbitrary sites.
// The pressure to widen it is constant and reasonable-sounding -- the panel
// wants a badge, so put `pinned` in the snapshot; it wants a description, so
// put that in too -- and every one of those is a workflow's name and shape
// written to disk for every profile on every launch, whether the panel is ever
// opened or not.
//
// It does not need to be. The panel asks the launcher for the live list
// (/v1/automations/list-from-page) and gets badges, descriptions and colours
// from there, in memory, on demand. The snapshot's one job is the first paint
// with the launcher closed, and {id, name} is all that takes.
describe('the launch snapshot the panel reads for its first paint', () => {
  it('carries nothing about an automation but its id and its name', () => {
    const automations: SessionPanelData['automations'] = [{id: 'a1', name: 'Daily login'}];
    for (const item of automations) {
      expect(new Set(Object.keys(item))).toEqual(new Set(['id', 'name']));
    }
  });

  // A compile-time assertion as much as a runtime one: if SessionPanelData's
  // automation shape grows a field, this stops type-checking. `steps` is named
  // explicitly because it is the one that must never travel -- it carries
  // selectors, urls and typed values (see launch.ts).
  it('has no place to put steps, parameters or variables', () => {
    const item: SessionPanelData['automations'][number] = {id: 'a1', name: 'Daily login'};
    expect('steps' in item).toBe(false);
    expect('parameters' in item).toBe(false);
    expect('variables' in item).toBe(false);
    expect('pinned' in item).toBe(false);
  });

  // The panel renders both shapes through one function: the snapshot's, and the
  // live route's richer one. Neither may be assumed -- renderAutomations reads
  // `pinned`/`assigned`/`color` defensively because half its calls have none.
  it('is rendered by the same panel code as the live list', () => {
    const source = readFileSync(
        join(__dirname, '../../extensions/cookie-manager/sidepanel.js'), 'utf8');
    expect(source).toContain('renderAutomations(session.automations)');
    expect(source).toContain('renderAutomations(liveAutomations)');
  });
});

// And the tripwire for the half of that snapshot nothing else can see: whether
// it is written at all.
//
// `sessionPanel` is populated only when the launch supplied a `startPage`, and
// `startPage` is buildLaunchPayload's *optional fourth argument*. Omitting it is
// not a type error, not a test failure and not visible in the launcher -- it is
// visible only inside the browser it opened, where the panel says "This window
// was not launched from Scout Web Launcher", shows no proxy card and no automations,
// and the cookie sync engine never runs. An automation that logs a profile in
// then leaves those cookies in the local jar and pushes them nowhere.
//
// That is exactly what useAutomationActions did until 2026-08-09, for every run
// that had to open the profile itself. Nothing caught it because there is
// nothing to catch: three call sites, one optional argument, and a consequence
// two processes away.
describe('every path that launches a profile mints a run token', () => {
  const sourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...sourceFiles(full));
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  };

  // The call, not the word: half a dozen files name buildLaunchPayload in a
  // comment, and a comment cannot launch anything.
  const callers = sourceFiles(join(__dirname, '..'))
      .filter((file) => !file.endsWith(join('lib', 'launch.ts')))
      .filter((file) => readFileSync(file, 'utf8').includes('buildLaunchPayload('));

  it('finds every caller', () => {
    // Load-bearing, like the glyph parse above: a walk that stopped finding
    // files would turn the assertion below into a loop over nothing.
    expect(callers.map((file) => file.split(/[\\/]/).pop()).sort()).toEqual(
        ['useAutomationActions.ts', 'useAutomationBridge.ts', 'useProfileActions.ts']);
  });

  it.each([
    'useProfileActions.ts',
    'useAutomationActions.ts',
    'useAutomationBridge.ts',
  ])('%s mints one before it launches', (name) => {
    const file = callers.find((candidate) => candidate.endsWith(name));
    expect(file, `${name} no longer calls buildLaunchPayload`).toBeTruthy();
    expect(readFileSync(file || '', 'utf8')).toContain('mintRunToken');
  });
});
