import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
// CJS interop: the same table main.cjs materializes extensions from.
// @ts-expect-error CJS module without types
import {scoutPanelExtensionId, builtInExtension, seedPinnedExtensions, unpackedExtensionId, unpinRetiredExtensions, placementName, sourceDigest} from '../../electron/built-in-extensions.cjs';

const deps = {parseCookieUrl: async () => [], parseCookieFile: () => []};
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scout-ext-'));

// A new build of the helper has to reach the browser, and for an unpacked MV3
// extension the only lever that reliably does it is a new DIRECTORY.
//
// Two cheaper ones were shipped and both failed, which is why these assertions
// are about the directory and not about anything inside it:
//
//   - Copying new bytes over the old ones at a stable path. Chromium caches an
//     unpacked worker's script body against its path, so the browser kept
//     running code from hours earlier while the file on disk implemented every
//     feature the panel said was missing.
//   - Renaming the SCRIPT under a stable directory. Worse: a service worker
//     REGISTRATION is keyed to its script URL and lives in the profile, so every
//     profile that had already run the extension was left pointing at a
//     background.js that no longer existed. The worker never booted and the
//     panel answered every message with "Receiving end does not exist".
//
// So: the name follows the source, and it follows ALL of the source.
describe('extension identity follows its source', () => {
  const panel = builtInExtension('cookie_manager')!;

  it('lands the panel under a content-hashed directory', () => {
    expect(panel.placement).toEqual({kind: 'hashed', prefix: 'ScoutPanel-'});
    expect(placementName(panel)).toMatch(/^ScoutPanel-[0-9a-f]{12}$/);
  });

  it('retires both previous directory names', () => {
    // Whatever a profile last launched has to be removed, or it sits in every
    // user-data-dir forever. 'MontiPanel' is the one this change retires.
    expect(panel.retired).toContain('MontiPanel');
    expect(panel.retired).toContain('MontiCookieManager');
  });

  it('gives the same source the same name', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'background.js'), 'self.x = 1;');
    const other = tempDir();
    fs.writeFileSync(path.join(other, 'background.js'), 'self.x = 1;');
    expect(sourceDigest(dir)).toBe(sourceDigest(other));
  });

  it('gives changed source a different name, which is the whole point', () => {
    const a = tempDir();
    fs.writeFileSync(path.join(a, 'background.js'), 'self.x = 1;');
    const b = tempDir();
    fs.writeFileSync(path.join(b, 'background.js'), 'self.x = 2;');
    expect(sourceDigest(a)).not.toBe(sourceDigest(b));
  });

  // The worker importScripts() its siblings and the side panel is a whole
  // document of them, so a change to any top-level file has to move the name.
  it('follows every top-level file, not just the worker', () => {
    const a = tempDir();
    fs.writeFileSync(path.join(a, 'background.js'), 'self.x = 1;');
    fs.writeFileSync(path.join(a, 'sidepanel.js'), 'A');
    const b = tempDir();
    fs.writeFileSync(path.join(b, 'background.js'), 'self.x = 1;');
    fs.writeFileSync(path.join(b, 'sidepanel.js'), 'B');
    expect(sourceDigest(a)).not.toBe(sourceDigest(b));
  });

  // A rename alone would move the digest even with identical bodies, or two
  // builds that differ only in which file holds the code would collide.
  it('follows file names, not only their contents', () => {
    const a = tempDir();
    fs.writeFileSync(path.join(a, 'one.js'), 'same');
    const b = tempDir();
    fs.writeFileSync(path.join(b, 'two.js'), 'same');
    expect(sourceDigest(a)).not.toBe(sourceDigest(b));
  });

  // The directory IS the id, so a moving name is a moving id -- that is the
  // mechanism, not a side effect, and the panel switch the browser is handed
  // (--monti-panel-extension-id) is derived from the same path.
  it('changes the extension id when the source changes', () => {
    const a = tempDir();
    fs.writeFileSync(path.join(a, 'background.js'), 'self.x = 1;');
    const b = tempDir();
    fs.writeFileSync(path.join(b, 'background.js'), 'self.x = 2;');
    expect(unpackedExtensionId(a)).not.toBe(unpackedExtensionId(b));
  });
});

describe('cookie_manager configure', () => {
  it('writes scout-launch.json when the launch carries a run token', async () => {
    const dir = tempDir();
    await builtInExtension('cookie_manager')!.configure!(
        {id: 'p1', name: 'Profile One', startPage: {port: 39219, token: 'tok-abc'}}, dir, deps);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'scout-launch.json'), 'utf8'));
    expect(written).toEqual({token: 'tok-abc', apiPort: 39219});
  });

  it('writes no scout-launch.json when the launch has no token', async () => {
    const dir = tempDir();
    await builtInExtension('cookie_manager')!.configure!(
        {id: 'p1', name: 'Profile One', startPage: null}, dir, deps);
    expect(fs.existsSync(path.join(dir, 'scout-launch.json'))).toBe(false);
  });

  it('still writes profile-meta.json either way', async () => {
    const dir = tempDir();
    await builtInExtension('cookie_manager')!.configure!(
        {id: 'p1', name: 'Profile One'}, dir, deps);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'profile-meta.json'), 'utf8'));
    expect(meta).toEqual({id: 'p1', name: 'Profile One'});
  });

  // The side panel's first paint. Written verbatim, not reshaped: the panel
  // renders homeProxyStatus() output as the renderer composed it, so anything
  // this hop rewrote would be a second opinion about the same session.
  it('writes scout-session.json verbatim when the launch carries panel data', async () => {
    const dir = tempDir();
    const sessionPanel = {
      profile: {id: 'p1', name: 'Profile One'},
      theme: 'dark',
      proxy: {
        ok: true,
        title: 'Anti-detect proxy active',
        detail: '1.2.3.4:8080 · Los Angeles, California, US · 131 ms',
        fields: [
          {label: 'Exit', value: '142.252.99.144', mono: true, note: '131 ms'},
          {label: 'Timezone', value: 'America/Los_Angeles', mono: true,
            note: 'matches exit', noteTone: 'ok'},
        ],
      },
      recheckable: true,
      automations: [{id: 'a1', name: 'Warm up feed'}],
    };
    await builtInExtension('cookie_manager')!.configure!(
        {id: 'p1', name: 'Profile One', sessionPanel}, dir, deps);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'scout-session.json'), 'utf8'));
    expect(written).toEqual(sessionPanel);
  });

  // Its absence is the panel's only signal that this window was not launched
  // from the launcher -- the same contract scout-launch.json has for sync. A
  // stub file with empty fields would make the panel paint a session that does
  // not exist.
  it('writes no scout-session.json when the launch carries none', async () => {
    const dir = tempDir();
    await builtInExtension('cookie_manager')!.configure!(
        {id: 'p1', name: 'Profile One', sessionPanel: null}, dir, deps);
    expect(fs.existsSync(path.join(dir, 'scout-session.json'))).toBe(false);
  });
});

// The toolbar button. Every assertion here is about a contract Chromium owns
// and this repo reimplements, which is exactly the code that fails silently:
// a wrong id or a wrong pref shape does not throw, it just means no button.
describe('pinning the panel to the toolbar', () => {
  // Where the panel actually lands, asked of the table rather than spelled out:
  // the directory is content-hashed now, so a literal here would silently stop
  // matching the id these tests are about the moment the helper changes.
  const panelDir = (userDataDir: string) =>
    path.join(userDataDir, placementName(builtInExtension('cookie_manager')!));

  const materialize = (userDataDir: string) => {
    const dir = panelDir(userDataDir);
    fs.mkdirSync(dir, {recursive: true});
    fs.copyFileSync(
        path.join(__dirname, '../../extensions/cookie-manager/manifest.json'),
        path.join(dir, 'manifest.json'));
    return dir;
  };
  const deps = {isLoadableExtensionDir: (dir: string) => fs.existsSync(path.join(dir, 'manifest.json'))};
  const readPinned = (userDataDir: string) => {
    const file = path.join(userDataDir, 'Default', 'Preferences');
    return fs.existsSync(file) ?
      JSON.parse(fs.readFileSync(file, 'utf8')).extensions?.pinned_extensions :
      undefined;
  };

  // crx_file::id_util::GenerateIdForPath: SHA-256 of the realpath'd directory,
  // first 16 bytes as hex, 0-9a-f mapped onto a-p.
  it('derives a 32-character a-p id from the directory path', () => {
    const dir = tempDir();
    const id = unpackedExtensionId(dir);
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(unpackedExtensionId(dir)).toBe(id);
    expect(unpackedExtensionId(tempDir())).not.toBe(id);
  });

  // No entry in the table asks to be pinned any more -- the panel's button is
  // the browser's own native one now. The mechanism stays, because it is the
  // only way a future built-in could get a button, so it is exercised against a
  // table entry temporarily flipped back rather than deleted along with the
  // last caller. Restored in a finally: the table is a module singleton and a
  // leaked flag would pin the panel again in every test after this one.
  const asPinned = (run: () => void) => {
    const entry = builtInExtension('cookie_manager')!;
    entry.pinned = true;
    try {
      run();
    } finally {
      entry.pinned = false;
    }
  };

  it('pins nothing, because nothing in the table asks to be pinned', () => {
    const userDataDir = tempDir();
    materialize(userDataDir);
    expect(seedPinnedExtensions({userDataDir}, deps)).toEqual([]);
    expect(readPinned(userDataDir)).toBeUndefined();
  });

  it('writes an asking entry id into extensions.pinned_extensions', () => {
    const userDataDir = tempDir();
    const dir = materialize(userDataDir);
    asPinned(() => {
      expect(seedPinnedExtensions({userDataDir}, deps)).toEqual([unpackedExtensionId(dir)]);
    });
    expect(readPinned(userDataDir)).toEqual([unpackedExtensionId(dir)]);
  });

  // Chromium's JsonPrefStore reads dotted pref names as nested objects, so a
  // flat "extensions.pinned_extensions" key would be silently ignored.
  it('nests the key rather than writing a flat dotted one', () => {
    const userDataDir = tempDir();
    materialize(userDataDir);
    asPinned(() => seedPinnedExtensions({userDataDir}, deps));
    const prefs = JSON.parse(
        fs.readFileSync(path.join(userDataDir, 'Default', 'Preferences'), 'utf8'));
    expect(Array.isArray(prefs.extensions.pinned_extensions)).toBe(true);
    expect(prefs['extensions.pinned_extensions']).toBeUndefined();
  });

  // Seeded once, not enforced: unpinning is a choice the user is allowed to
  // keep, and an empty list is what unpinning the only pinned extension leaves.
  it('leaves an existing list alone, including an empty one', () => {
    const userDataDir = tempDir();
    materialize(userDataDir);
    fs.mkdirSync(path.join(userDataDir, 'Default'), {recursive: true});
    fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'),
        JSON.stringify({extensions: {pinned_extensions: []}}));
    asPinned(() => {
      expect(seedPinnedExtensions({userDataDir}, deps)).toEqual([]);
    });
    expect(readPinned(userDataDir)).toEqual([]);
  });

  it('keeps the rest of an existing Preferences file', () => {
    const userDataDir = tempDir();
    materialize(userDataDir);
    fs.mkdirSync(path.join(userDataDir, 'Default'), {recursive: true});
    fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'),
        JSON.stringify({homepage: 'file:///home.html', extensions: {settings: {a: 1}}}));
    asPinned(() => seedPinnedExtensions({userDataDir}, deps));
    const prefs = JSON.parse(
        fs.readFileSync(path.join(userDataDir, 'Default', 'Preferences'), 'utf8'));
    expect(prefs.homepage).toBe('file:///home.html');
    expect(prefs.extensions.settings).toEqual({a: 1});
    expect(prefs.extensions.pinned_extensions).toHaveLength(1);
  });

  it('pins nothing when the panel is switched off', () => {
    const userDataDir = tempDir();
    materialize(userDataDir);
    asPinned(() => {
      expect(seedPinnedExtensions(
          {userDataDir, builtInExtensions: {cookie_manager: false}}, deps)).toEqual([]);
    });
    expect(readPinned(userDataDir)).toBeUndefined();
  });

  // The id the native "Scout Web Helper" toolbar button drives the panel by --
  // passed to the browser as --monti-panel-extension-id.
  it('derives the panel extension id once its directory exists', () => {
    const userDataDir = tempDir();
    const dir = materialize(userDataDir);
    expect(scoutPanelExtensionId({userDataDir})).toBe(unpackedExtensionId(dir));
  });

  it('derives no panel extension id when the panel is switched off', () => {
    const userDataDir = tempDir();
    materialize(userDataDir);
    expect(scoutPanelExtensionId(
        {userDataDir, builtInExtensions: {cookie_manager: false}})).toBe('');
  });
});

// The other half of dropping `pinned`. Flipping the flag only helps profiles
// that have never launched -- seedPinnedExtensions bails on an existing list --
// so every profile that ran the old build carries the stale pin, and therefore a
// second, icon-only Scout Web Helper button beside the native labelled one.
//
// This is a pass over a list the user also owns, which is why every test here is
// about what it must NOT touch.
describe('unpinning a retired built-in', () => {
  // Where the panel actually lands, asked of the table rather than spelled out:
  // the directory is content-hashed now, so a literal here would silently stop
  // matching the id these tests are about the moment the helper changes.
  const panelDir = (userDataDir: string) =>
    path.join(userDataDir, placementName(builtInExtension('cookie_manager')!));

  const materialize = (userDataDir: string) => {
    const dir = panelDir(userDataDir);
    fs.mkdirSync(dir, {recursive: true});
    fs.copyFileSync(
        path.join(__dirname, '../../extensions/cookie-manager/manifest.json'),
        path.join(dir, 'manifest.json'));
    return dir;
  };
  const deps = {isLoadableExtensionDir: (dir: string) => fs.existsSync(path.join(dir, 'manifest.json'))};
  const writePrefs = (userDataDir: string, prefs: unknown) => {
    fs.mkdirSync(path.join(userDataDir, 'Default'), {recursive: true});
    fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), JSON.stringify(prefs));
  };
  const readPrefs = (userDataDir: string) => JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'Default', 'Preferences'), 'utf8'));

  it('removes the panel id a previous build pinned', () => {
    const userDataDir = tempDir();
    const id = unpackedExtensionId(materialize(userDataDir));
    writePrefs(userDataDir, {extensions: {pinned_extensions: [id]}});
    expect(unpinRetiredExtensions({userDataDir}, deps)).toEqual([id]);
    expect(readPrefs(userDataDir).extensions.pinned_extensions).toEqual([]);
  });

  // The whole reason this cannot be "reset the list": it is shared with every
  // extension the user pinned themselves, and those ids must survive.
  it('leaves every other pinned extension in place, in order', () => {
    const userDataDir = tempDir();
    const id = unpackedExtensionId(materialize(userDataDir));
    writePrefs(userDataDir, {extensions: {pinned_extensions: ['aaaa', id, 'bbbb']}});
    unpinRetiredExtensions({userDataDir}, deps);
    expect(readPrefs(userDataDir).extensions.pinned_extensions).toEqual(['aaaa', 'bbbb']);
  });

  it('keeps the rest of the Preferences file', () => {
    const userDataDir = tempDir();
    const id = unpackedExtensionId(materialize(userDataDir));
    writePrefs(userDataDir,
        {homepage: 'file:///home.html', extensions: {settings: {a: 1}, pinned_extensions: [id]}});
    unpinRetiredExtensions({userDataDir}, deps);
    const prefs = readPrefs(userDataDir);
    expect(prefs.homepage).toBe('file:///home.html');
    expect(prefs.extensions.settings).toEqual({a: 1});
  });

  // Runs on every launch, so the overwhelmingly common case is "already
  // correct". It must not rewrite the file then: Chromium is holding it open,
  // and a pointless write is a pointless chance to corrupt it.
  it('writes nothing when there is nothing of ours to remove', () => {
    const userDataDir = tempDir();
    materialize(userDataDir);
    writePrefs(userDataDir, {extensions: {pinned_extensions: ['aaaa']}});
    const before = fs.statSync(path.join(userDataDir, 'Default', 'Preferences')).mtimeMs;
    expect(unpinRetiredExtensions({userDataDir}, deps)).toEqual([]);
    expect(fs.statSync(path.join(userDataDir, 'Default', 'Preferences')).mtimeMs).toBe(before);
  });

  it('does nothing on a profile that has never launched', () => {
    const userDataDir = tempDir();
    materialize(userDataDir);
    expect(unpinRetiredExtensions({userDataDir}, deps)).toEqual([]);
    expect(fs.existsSync(path.join(userDataDir, 'Default', 'Preferences'))).toBe(false);
  });

  // A profile carrying the stale pin AND the panel since switched off still
  // wants the dead button gone -- the extension is not loaded, so the button
  // does nothing at all.
  it('removes the pin even when the panel is switched off', () => {
    const userDataDir = tempDir();
    const id = unpackedExtensionId(materialize(userDataDir));
    writePrefs(userDataDir, {extensions: {pinned_extensions: [id]}});
    expect(unpinRetiredExtensions(
        {userDataDir, builtInExtensions: {cookie_manager: false}}, deps)).toEqual([id]);
    expect(readPrefs(userDataDir).extensions.pinned_extensions).toEqual([]);
  });
});

// The panel is loaded from the manifest, not from anything the launcher calls,
// so nothing else in this repo would notice these going wrong. Dropping
// default_popup without declaring the panel leaves the toolbar button doing
// nothing at all, which is silent in every other test.
describe('Scout Web Panel manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../extensions/cookie-manager/manifest.json'), 'utf8'));

  it('declares the side panel and drops the popup', () => {
    expect(manifest.side_panel?.default_path).toBe('sidepanel.html');
    expect(manifest.permissions).toContain('sidePanel');
    expect(manifest.action.default_popup).toBeUndefined();
  });

  it('ships every file the panel loads', () => {
    const dir = path.join(__dirname, '../../extensions/cookie-manager');
    for (const file of ['sidepanel.html', 'sidepanel.css', 'sidepanel.js', 'icons.js']) {
      expect(fs.existsSync(path.join(dir, file)), `${file} is missing`).toBe(true);
    }
  });

  // Every <script src> in the markup, not a list kept here: the panel gained
  // sync-status.js and the two places that enumerate its scripts (this and
  // scripts/preview-panel.mjs) both had to learn about it. One of them didn't,
  // and the preview rendered a blank panel. Read the document instead.
  it('ships every script sidepanel.html loads, in a file that exists', () => {
    const dir = path.join(__dirname, '../../extensions/cookie-manager');
    const html = fs.readFileSync(path.join(dir, 'sidepanel.html'), 'utf8');
    const sources = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(fs.existsSync(path.join(dir, source)), `${source} is missing`).toBe(true);
    }
  });

  // A toolbar button whose icon file does not exist renders as a blank square
  // -- present, clickable, and invisible. Nothing else here would catch a
  // renamed icon directory, and the icons moved into per-theme subdirectories
  // exactly once, which is the change that would have shipped that.
  it('points at icon files that exist, in both themes', () => {
    const dir = path.join(__dirname, '../../extensions/cookie-manager');
    const declared = [
      ...Object.values(manifest.icons as Record<string, string>),
      ...Object.values(manifest.action.default_icon as Record<string, string>),
    ];
    expect(declared.length).toBe(8);
    for (const rel of declared) {
      expect(fs.existsSync(path.join(dir, rel)), `${rel} is missing`).toBe(true);
    }
    // background.js swaps to the other ink at runtime by substituting the
    // directory, so that set has to be complete too even though the manifest
    // never names it.
    for (const rel of declared) {
      const other = rel.replace('/on-light/', '/on-dark/');
      expect(fs.existsSync(path.join(dir, other)), `${other} is missing`).toBe(true);
    }
  });
});
