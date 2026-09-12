// The built-in ("stock") extensions every profile can launch with, as one
// table instead of one bespoke function each.
//
// Before this file there were three near-identical paths in main.cjs --
// bundledExtensionPaths, writeProfileCookieManagerExtension and
// writeProfileFreeProxyExtension -- that all copied a folder into the
// profile's user-data-dir and differed only in where they put it and which
// extra files they wrote next to it. A fourth extension would have been a
// fourth copy of that code. Those two differences are now `placement` and
// `configure`, so a fifth extension is a row.
//
// Deliberately free of any `electron` require: the only Electron-owned value
// this needs is the shared-extension cache root, which arrives through `deps`.
// That keeps the table importable from vitest (see built-in-extensions.test.js,
// which asserts these keys match the UI's BUILT_IN_EXTENSIONS) without pulling
// an Electron app into the test process.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXTENSIONS_ROOT = path.join(__dirname, '../extensions');

// Web Store id of the CaptchaPlugin solver. Unlike the other three this one is
// not vendored into extensions/: it is ~80 MB unpacked, so it is downloaded
// once per machine into the shared cache and every profile loads that one copy
// rather than getting its own.
const CAPTCHA_PLUGIN_ID = 'iomcoelgdkghlligeempdbfcaobodacg';

// `key` matches a field of BuiltInExtensionToggles in src/types.ts, and the
// `key` of an entry in src/data/extensionCatalog.ts's BUILT_IN_EXTENSIONS --
// that string is the whole contract between this table and the card/toggle the
// user actually sees, since main.cjs is CommonJS and cannot import the
// TypeScript one.
//
// `defaultEnabled` is the polarity of a missing value, not decoration. The
// first three shipped before their toggle existed, so absent has to mean on or
// old cloud state would silently lose them. captcha_plugin is the opposite: it
// costs a ~56 MB download, so an org that has never heard of it must not read
// as having opted in.
const BUILT_IN_EXTENSIONS = [
  {
    key: 'cookie_manager',
    defaultEnabled: true,
    source: {kind: 'folder', dir: 'cookie-manager'},
    // The directory carries a digest of the extension's own source, so its name
    // moves when and only when the code does. That name is the extension's
    // identity -- Chromium derives an unpacked id from the path -- and a new
    // identity is the only thing that reliably gives the panel a fresh service
    // worker.
    //
    // The two cheaper levers were both tried and both failed, in this order:
    //
    //   - Copying a new background.js over the old one at a stable path. Chrome
    //     caches an unpacked worker's script body against its path, so the new
    //     bytes were never read. This is the "Unknown message" / "running an
    //     older version of the Scout Helper background script" failure.
    //   - Renaming the SCRIPT inside a stable directory (background.<hash>.js),
    //     to move the cache key without moving the id. That is worse, and it is
    //     what shipped for one launch on 2026-08-09: an MV3 service worker
    //     registration is keyed to its script URL and lives in the profile, not
    //     in the extension directory. Renaming the file left every existing
    //     profile with a registration pointing at a background.js that no longer
    //     existed, the worker never booted, and every sendMessage from the panel
    //     answered "Could not establish connection. Receiving end does not
    //     exist." -- cookies, automations and workspace alike.
    //
    // A new directory has none of that: no prior registration to strand,
    // because it is a different extension as far as the profile is concerned.
    // The price is that chrome.storage.local resets once per helper release --
    // the seed-import watermark and the sync watermark. Both are self-healing
    // (re-importing the same seed sets the same values; a reset sync watermark
    // costs one extra push), and it is the same price the MontiCookieManager ->
    // MontiPanel rename already paid once, deliberately.
    placement: {kind: 'hashed', prefix: 'ScoutPanel-'},
    // Directories that must not sit in every profile forever. Nothing loads
    // them: they are not in --load-extension. 'MontiPanel' is here for the same
    // reason 'MontiCookieManager' is -- it is now a previous name.
    retired: ['MontiCookieManager', 'MontiPanel'],
    // NOT pinned, and this is the one entry for which that is a decision rather
    // than a default.
    //
    // It used to be pinned, because the panel had no other way in. The shipped
    // browser now carries a native, labelled "Scout Helper" toolbar button
    // (chrome/browser/ui/views/toolbar/monti_toolbar_button.*, driven by
    // --monti-panel-extension-id and auto-pinned once per profile by
    // PinnedToolbarActionsModel), and that button owns the panel. Pinning the
    // extension's own action as well put TWO buttons in the toolbar for one
    // surface: the labelled native one and an icon-only duplicate.
    //
    // Flipping this to false only helps profiles that have never launched --
    // seedPinnedExtensions seeds once and then leaves the list alone. Profiles
    // that ran the old build carry the pin in their Preferences forever, which
    // is what unpinRetiredExtensions below exists to undo.
    pinned: false,
    // The other half of that flip: strip a pin this table put there before the
    // native button existed. Only ever removes THIS entry's own id, so a button
    // the user pinned by hand is left alone -- see unpinRetiredExtensions.
    unpin: true,
    // The Scout Panel: the browser's side-panel dashboard. Cookie export/import
    // and sync, the session's proxy readout, and this launch's automations,
    // plus (when this profile has a cookie file assigned) the seed the
    // extension's own background.js imports once on first run.
    //
    // The key stays `cookie_manager` though the extension is no longer only
    // about cookies. It is the contract between this table, the card in
    // src/data/extensionCatalog.ts and the org's saved built_in_extensions
    // state -- renaming it would read as a missing key, fall back to
    // defaultEnabled, and silently discard every org's saved preference.
    configure: async (payload, extensionDir, deps) => {
      // Lets the panel show which profile it is attached to (Monti Browser
      // windows are otherwise unlabeled from the extension's point of view).
      fs.writeFileSync(path.join(extensionDir, 'profile-meta.json'), JSON.stringify({
        id: payload.id || '',
        name: payload.name || '',
      }, null, 2));
      // Everything the panel paints before it has talked to anyone: the proxy
      // verdict as homeProxyStatus composed it in the renderer, the theme to
      // paint it in, and the automations this launch may run. Written only when
      // the renderer supplied one, so the panel reads the file's absence as
      // "this window was not launched from Scout Web" -- the same contract
      // scout-launch.json already has for sync.
      //
      // No 0600 here, unlike scout-launch.json below: this file carries no
      // credential. The run token stays in that one.
      if (payload.sessionPanel) {
        fs.writeFileSync(path.join(extensionDir, 'scout-session.json'),
            JSON.stringify(payload.sessionPanel, null, 2));
      }
      // The per-launch credential the sync engine spends against the loopback
      // API (see /v1/cookies/push-from-profile in main.cjs). Written only when
      // the launch minted a token, so background.js reads the file's absence
      // as "sync unavailable" (e.g. the extension loaded outside a profile
      // launch). 0600 like the other file that carries this token.
      if (payload.startPage && payload.startPage.token) {
        fs.writeFileSync(path.join(extensionDir, 'scout-launch.json'), JSON.stringify({
          token: payload.startPage.token,
          apiPort: payload.startPage.port,
        }, null, 2), {mode: 0o600});
      }
      const seedPath = path.join(extensionDir, 'seed-cookies.json');
      const writeSeedCookies = (cookies) => {
        if (cookies.length) {
          fs.writeFileSync(seedPath, JSON.stringify({cookies}, null, 2));
        }
      };
      if (payload.cookieImportUrl) {
        try {
          writeSeedCookies(await deps.parseCookieUrl(payload.cookieImportUrl));
        } catch {
          // Fall back to a local path below if one is still available.
        }
      }
      if (!fs.existsSync(seedPath) && payload.cookieImportPath) {
        try {
          writeSeedCookies(deps.parseCookieFile(payload.cookieImportPath));
        } catch {
          // No seed file written: the extension's own fetch() of
          // seed-cookies.json simply finds nothing and skips seeding, so this
          // fails soft.
        }
      }
    },
  },
  {
    key: 'sms_activate',
    defaultEnabled: true,
    source: {kind: 'folder', dir: 'onlinesim-sms'},
    placement: {kind: 'stable', name: path.join('ScoutBundled', 'SMSActivate')},
  },
  {
    key: 'foxywall_free_proxy',
    defaultEnabled: true,
    source: {kind: 'folder', dir: 'foxywall'},
    // Chrome caches an unpacked (--load-extension) service worker's script body
    // independently of its manifest version or file content -- reloading the
    // browser against the same stable path on an already-used profile can keep
    // running a stale background.js from hours earlier no matter how many times
    // the source file changes or its manifest version is bumped (confirmed via
    // live CDP inspection: chrome.runtime.getManifest().version reflected a
    // fresh bump, but functions/consts only present in newer source were still
    // undefined). A fresh, uniquely-named directory per launch gives Chrome a
    // genuinely new extension identity every time, so it can never reuse a
    // stale cached service worker. Stale siblings are pruned before each write,
    // or they would accumulate one directory per launch forever.
    placement: {kind: 'per-launch', prefix: 'ScoutFreeProxy-'},
    // FoxyWall is bundled for every profile (so its toolbar icon/manual toggle
    // is always available), but must only auto-connect on launch when the user
    // actually picked Free Proxy mode -- never for 'direct' (no proxy at all)
    // or 'assigned' (a real proxy already owns the connection; this would be a
    // second, competing proxy source). This config file is the signal
    // background.js reads before deciding whether to auto-connect.
    configure: (payload, extensionDir) => {
      fs.writeFileSync(path.join(extensionDir, 'scout-config.json'), JSON.stringify({
        autoConnect: Boolean(payload.useFreeProxy),
      }));
    },
  },
  {
    key: 'captcha_plugin',
    defaultEnabled: false,
    source: {kind: 'webstore', id: CAPTCHA_PLUGIN_ID},
  },
];

const BUILT_IN_EXTENSION_KEYS = BUILT_IN_EXTENSIONS.map((entry) => entry.key);

function builtInExtension(key) {
  return BUILT_IN_EXTENSIONS.find((entry) => entry.key === key) || null;
}

// Undefined/missing falls back to the entry's own default rather than a blanket
// `!== false`, which is what lets captcha_plugin ship off while the other three
// ship on. `toggles` is BuiltInExtensionToggles as saved in cloud state.
function builtInEnabled(toggles, entry) {
  const value = toggles ? toggles[entry.key] : undefined;
  return value === undefined || value === null ? entry.defaultEnabled : Boolean(value);
}

// A digest of an extension's source directory: top-level file names and bodies.
//
// Top-level only, for the same reason the old script-stamping was: the one
// subdirectory here is icons/, which the worker does not load and whose contents
// cannot change its behaviour. Memoized because every launch asks for it four
// times (the copy, the pin pass, the unpin pass and the panel id) and the answer
// cannot change while the app is running.
const sourceDigests = new Map();
function sourceDigest(sourceDir) {
  const cached = sourceDigests.get(sourceDir);
  if (cached) {
    return cached;
  }
  const digest = crypto.createHash('sha256');
  for (const name of fs.readdirSync(sourceDir).sort()) {
    const full = path.join(sourceDir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    digest.update(name);
    digest.update(fs.readFileSync(full));
  }
  const hex = digest.digest('hex').slice(0, 12);
  sourceDigests.set(sourceDir, hex);
  return hex;
}

// The directory name an entry lands under, relative to the user-data-dir.
// Constant for 'stable', content-derived for 'hashed'. Not defined for
// 'per-launch', whose name is a timestamp and therefore cannot be recomputed by
// anyone who did not create it -- which is why those are never pinnable.
function placementName(entry) {
  if (entry.placement.kind === 'hashed') {
    return `${entry.placement.prefix}${sourceDigest(path.join(EXTENSIONS_ROOT, entry.source.dir))}`;
  }
  return entry.placement.name;
}

// Whether an entry's directory is the same on the next launch as on this one --
// the precondition for deriving an id that outlives a single launch. 'hashed'
// qualifies: it moves when the extension is updated, not when the profile is
// relaunched.
function hasStableIdentity(entry) {
  return entry.placement?.kind === 'stable' || entry.placement?.kind === 'hashed';
}

function destinationFor(userDataDir, entry) {
  return entry.placement.kind === 'per-launch' ?
    path.join(userDataDir, `${entry.placement.prefix}${Date.now()}`) :
    path.join(userDataDir, placementName(entry));
}

function pruneStaleCopies(userDataDir, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(userDataDir, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(prefix)) {
      fs.rmSync(path.join(userDataDir, entry.name), {recursive: true, force: true});
    }
  }
}

// Returns a ready-to-load directory for one enabled entry, or '' -- never
// throws and never blocks. A profile launching without an extension is always
// preferable to a profile that will not launch.

async function materializeBuiltIn(payload, entry, deps) {
  // Web Store entries are never copied per profile and are never downloaded
  // here: launch uses whatever is already in the shared machine cache and
  // silently goes without if it is missing. Fetching is the enable click's job
  // (and the catch-up pass at app start), so no launch can ever wait on a
  // 56 MB download.
  if (entry.source.kind === 'webstore') {
    const cached = deps.webstoreCachePath(entry.source.id);
    return deps.isLoadableExtensionDir(cached) ? cached : '';
  }
  if (!payload || !payload.userDataDir) {
    return '';
  }
  const sourceDir = path.join(EXTENSIONS_ROOT, entry.source.dir);
  if (!deps.isLoadableExtensionDir(sourceDir)) {
    console.warn(
        `Skipping built-in extension "${entry.key}": source folder is missing or has no ` +
        `valid manifest.json (${sourceDir}). Profile launch will continue without it.`);
    return '';
  }
  // Both prefixed placements need this, for different reasons. 'per-launch'
  // makes a new directory every launch and would otherwise leave one behind
  // every time. 'hashed' makes a new one per helper release, which is rarer but
  // never cleans up after itself either -- and its leftovers are whole copies of
  // the extension, not empty shells. Removing the current name too is harmless:
  // it is deleted and recopied immediately below regardless.
  if (entry.placement.kind === 'per-launch' || entry.placement.kind === 'hashed') {
    pruneStaleCopies(payload.userDataDir, entry.placement.prefix);
  }
  for (const name of entry.retired || []) {
    fs.rmSync(path.join(payload.userDataDir, name), {recursive: true, force: true});
  }
  const extensionDir = destinationFor(payload.userDataDir, entry);
  fs.rmSync(extensionDir, {recursive: true, force: true});
  deps.copyDirectoryContents(sourceDir, extensionDir);
  if (!deps.isLoadableExtensionDir(extensionDir)) {
    console.warn(
        `Skipping built-in extension "${entry.key}": copy to ${extensionDir} did not ` +
        `produce a readable manifest.json. Profile launch will continue without it.`);
    fs.rmSync(extensionDir, {recursive: true, force: true});
    return '';
  }
  if (entry.configure) {
    try {
      await entry.configure(payload, extensionDir, deps);
    } catch (error) {
      // The extension itself is already copied and loadable; losing its
      // per-profile config file degrades that one feature rather than the
      // launch, so keep the directory.
      console.error(`Configuring built-in extension "${entry.key}" failed:`, error);
    }
  }
  return extensionDir;
}

// ---- toolbar pinning ---------------------------------------------------------
// An unpacked extension has no key in its manifest, so Chromium derives its id
// from where it sits on disk: SHA-256 of the absolute, symlink-resolved
// directory path, first 16 bytes, hex, with 0-9a-f mapped onto a-p (a numeric
// id would read as an IP address to some software). See
// crx_file::id_util::GenerateIdForPath and UnpackedInstaller::Load in the
// browser tree -- the path is passed through MakeAbsoluteFilePath first, which
// is realpath(), hence realpathSync here.
//
// Reproduced rather than asked for because the browser cannot be asked: the id
// has to be known *before* launch, to name the extension in a preference the
// browser reads on startup.
function unpackedExtensionId(extensionDir) {
  const resolved = fs.realpathSync(extensionDir);
  const digest = crypto.createHash('sha256').update(resolved, 'utf8').digest('hex');
  return digest.slice(0, 32).replace(/[0-9a-f]/g,
      (character) => String.fromCharCode(97 + parseInt(character, 16)));
}

// Pins every enabled built-in that asked for a toolbar button, by seeding
// Chromium's own `extensions.pinned_extensions` list in the profile's
// Preferences file before the browser opens it.
//
// That pref is a plain syncable list (ExtensionPrefs::RegisterProfilePrefs in
// the browser tree) and is *not* one of the MAC-signed tracked preferences, so
// writing it from out here is not something Chromium will detect and reset --
// unlike extensions.settings next to it. The enterprise ExtensionSettings
// policy has a `toolbar_pin: force_pinned` for the same job, but on macOS that
// needs a managed-preferences plist and therefore an MDM or an admin, which is
// not something an app can arrange for itself.
//
// Seeded once, not enforced: if the key already exists this leaves it alone, so
// a user who unpins the button keeps it unpinned. force_pinned would take that
// choice away, and this is a convenience, not a policy.
//
// Only stable placements are eligible. A per-launch directory gets a new path,
// and therefore a new id, every single launch -- pinning those would append a
// dead id to this list forever and never pin anything the user could see.
// The profile's Preferences file as a plain object, plus where to put it back.
// Two passes below read-modify-write it, and this is the only place that knows
// how it is spelled: Chromium's JsonPrefStore treats the dots in a registered
// pref name as nested object paths, so the on-disk shape is {"extensions":
// {"pinned_extensions": [...]}} rather than a flat dotted key. Same rule
// writeProfileProxyAssignment documents for monti.profile_data.
//
// A missing or unreadable file reads as {}: on a profile's very first launch
// there is nothing to merge with and nothing to preserve.
function readProfilePrefs(userDataDir) {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  try {
    return {prefsPath, prefs: JSON.parse(fs.readFileSync(prefsPath, 'utf8'))};
  } catch {
    return {prefsPath, prefs: {}};
  }
}

function writeProfilePrefs(prefsPath, prefs) {
  fs.mkdirSync(path.dirname(prefsPath), {recursive: true});
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

// The id an enabled, stable-placement entry will load under in this profile, or
// '' when it is switched off, is not stable, or its directory is not there to be
// realpath()ed. Both pinning passes need exactly this, and neither may throw.
function pinnableExtensionId(payload, entry, deps) {
  if (!builtInEnabled(payload.builtInExtensions, entry)) return '';
  if (!hasStableIdentity(entry)) return '';
  const dir = path.join(payload.userDataDir, placementName(entry));
  if (!deps.isLoadableExtensionDir(dir)) return '';
  try {
    return unpackedExtensionId(dir);
  } catch (error) {
    // A button that is one click further away is not worth failing a launch
    // over, or even worth a warning louder than this.
    console.warn(`Could not compute an extension id for "${entry.key}":`, error);
    return '';
  }
}

function seedPinnedExtensions(payload, deps) {
  const {prefsPath, prefs} = readProfilePrefs(payload.userDataDir);
  const extensions = prefs.extensions || {};
  if (Array.isArray(extensions.pinned_extensions)) {
    return [];
  }
  const ids = [];
  for (const entry of BUILT_IN_EXTENSIONS) {
    if (!entry.pinned) continue;
    const id = pinnableExtensionId(payload, entry, deps);
    if (id) ids.push(id);
  }
  if (!ids.length) {
    return [];
  }
  extensions.pinned_extensions = ids;
  prefs.extensions = extensions;
  writeProfilePrefs(prefsPath, prefs);
  return ids;
}

// Undoes a pin this table used to seed, for profiles that already have the list
// and so are out of seedPinnedExtensions' reach forever.
//
// Runs on every launch rather than once behind a watermark, and that is
// deliberate: there is no watermark to keep, and re-checking a list that is
// almost always already correct costs one read of a file this launch reads
// anyway. It writes only when it actually removed something.
//
// Narrow on purpose. It removes ONLY the id of an entry that carries `unpin`,
// which means "this table pinned it, and no longer should". A button the user
// pinned themselves has a different id and is untouched, and an entry the user
// unpinned by hand is already absent -- so this can never fight a choice
// someone made, in either direction. That is also why it cannot be expressed as
// "reset the list": the list is shared with every extension the user pins.
function unpinRetiredExtensions(payload, deps) {
  const {prefsPath, prefs} = readProfilePrefs(payload.userDataDir);
  const pinned = prefs.extensions?.pinned_extensions;
  if (!Array.isArray(pinned) || !pinned.length) {
    return [];
  }
  const retire = new Set();
  for (const entry of BUILT_IN_EXTENSIONS) {
    if (!entry.unpin) continue;
    // Note this asks for the id whether or not the extension is enabled: a
    // profile that carries the stale pin AND has since had the panel switched
    // off still wants the dead button gone. pinnableExtensionId answers ''
    // for a disabled entry, so ask it directly instead.
    if (!hasStableIdentity(entry)) continue;
    const dir = path.join(payload.userDataDir, placementName(entry));
    if (!deps.isLoadableExtensionDir(dir)) continue;
    try {
      retire.add(unpackedExtensionId(dir));
    } catch {
      // Nothing to remove that we can name. Leaving the pin is the safe half.
    }
  }
  const kept = pinned.filter((id) => !retire.has(id));
  if (kept.length === pinned.length) {
    return [];
  }
  prefs.extensions.pinned_extensions = kept;
  writeProfilePrefs(prefsPath, prefs);
  return pinned.filter((id) => retire.has(id));
}

// The id the Scout Panel extension will load under in this profile, or '' if
// the extension is disabled or its directory does not exist yet. Passed to the
// browser as --monti-panel-extension-id so its native "Scout Helper" toolbar
// button can drive this extension's side panel. Only meaningful after
// materializeBuiltIns has copied the folder: the id is derived from a
// realpath()ed directory that has to exist.
function scoutPanelExtensionId(payload) {
  const entry = BUILT_IN_EXTENSIONS.find((candidate) => candidate.key === 'cookie_manager');
  if (!entry || !builtInEnabled(payload.builtInExtensions, entry)) {
    return '';
  }
  try {
    return unpackedExtensionId(path.join(payload.userDataDir, placementName(entry)));
  } catch {
    return '';
  }
}

// Every enabled built-in's directory, in table order.
async function materializeBuiltIns(payload, deps) {
  const enabled = BUILT_IN_EXTENSIONS.filter(
      (entry) => builtInEnabled(payload.builtInExtensions, entry));
  const paths = await Promise.all(
      enabled.map((entry) => materializeBuiltIn(payload, entry, deps)));
  // After the copies land, never before: the id is derived from a directory
  // that has to exist to be realpath()ed. Seed first, then retire -- on a fresh
  // profile the seed writes the list and the retire pass reads it back, so an
  // entry that is both `pinned` and `unpin` (nothing is, today) would resolve
  // the same way it does on an existing profile rather than depending on order.
  try {
    seedPinnedExtensions(payload, deps);
  } catch (error) {
    console.error('Could not seed pinned extensions:', error);
  }
  try {
    unpinRetiredExtensions(payload, deps);
  } catch (error) {
    console.error('Could not unpin retired extensions:', error);
  }
  return paths.filter(Boolean);
}

module.exports = {
  BUILT_IN_EXTENSIONS,
  BUILT_IN_EXTENSION_KEYS,
  CAPTCHA_PLUGIN_ID,
  scoutPanelExtensionId,
  builtInEnabled,
  builtInExtension,
  materializeBuiltIns,
  seedPinnedExtensions,
  unpackedExtensionId,
  unpinRetiredExtensions,
  placementName,
  sourceDigest,
};
