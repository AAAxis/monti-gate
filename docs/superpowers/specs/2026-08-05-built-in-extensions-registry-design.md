# Built-in extensions: one registry, and CaptchaPlugin

**Date:** 2026-08-05
**Status:** approved, ready for implementation planning

## Why

Adding a fourth built-in extension exposed how the first three are wired. Each
has its own hand-rolled path through `electron/main.cjs`, all three doing
roughly the same job with different destination directories and different extra
files. A fourth would have been a fourth special case.

The fourth extension also does not fit the existing shape at all. CaptchaPlugin
is a Web Store extension, 56 MB as a CRX and 80 MB unpacked, where the existing
three are first-party folders of a few tens of kilobytes. It cannot be vendored
into `extensions/` and it cannot be copied per profile.

So this change does three things at once: deletes dead files that ship to every
user, replaces the three bespoke paths with one declarative registry, and adds
CaptchaPlugin as the first entry sourced from the Web Store rather than from the
repo.

## What exists today

| Extension | Toggle key | Wired by | Destination |
|---|---|---|---|
| Monti Cookie Manager | `cookie_manager` | `writeProfileCookieManagerExtension()` | `<udd>/MontiCookieManager`, recopied every launch |
| SMS Activate (OnlineSim) | `sms_activate` | `bundledExtensionPaths()` → `materializeBundledExtension()` | `<udd>/MontiBundled/SMSActivate` |
| FoxyWall Proxy | `foxywall_free_proxy` | `writeProfileFreeProxyExtension()` | `<udd>/MontiFreeProxy-<timestamp>`, unique per launch |

All three are real, first-party, MV3, and all three work. Findings from the
audit that this spec acts on:

- `extensions/foxywall/backend/` is a Flask + Firebase/Firestore server, and
  `extensions/foxywall/test-api.js` targets `api.theholylabs.com`. Neither is
  referenced by the manifest; the extension authenticates against Supabase.
  Both are leftovers from FoxyWall's earlier life, and `copyDirectoryContents()`
  copies them into every profile's user-data-dir on every launch, plus the DMG.
- The card for SMS Activate promises "Buy a phone number for a verification
  code" but the extension ships with no API key and opens on a setup wall until
  the user brings their own onlinesim.io account.

Two findings are deliberately **out of scope**, recorded here so they are not
lost:

- The extension is named "SMS Activate" throughout (manifest, toggle key, card,
  icon filename) but integrates onlinesim.io. SMS-Activate is a different
  company. Keeping the name is an explicit product decision.
- FoxyWall authenticates against its own Supabase project
  (`uhpuqiptxcjluwsetoev`), separate from Scout's (`jpsmdjtxuxlkyuotwxfg`),
  with its own anonymous `VPN-XXXX-XXXX-XXXX` accounts, entitlements and
  upgrade flow, unconnected to the signed-in Scout account. That backend is
  live and functional. Unifying the two account systems is a much larger
  question than this change.

## Design

### The registry

A new `electron/built-in-extensions.cjs` holds one row per extension. Four axes
cover everything the three current paths do:

| key | source | placement | per-profile files |
|---|---|---|---|
| `cookie_manager` | folder `cookie-manager` | `MontiCookieManager` (stable name, recopied) | `profile-meta.json`, `seed-cookies.json` |
| `sms_activate` | folder `onlinesim-sms` | `MontiBundled/SMSActivate` | — |
| `foxywall_free_proxy` | folder `foxywall` | `MontiFreeProxy-<ts>` (fresh per launch, stale pruned) | `monti-config.json` |
| `captcha_plugin` | webstore `iomcoelgdkghlligeempdbfcaobodacg` | shared machine cache, **not** copied per profile | — |

The first three default to enabled, `captcha_plugin` defaults to disabled.

Shape of a row:

- `key` — matches a field of `BuiltInExtensionToggles` in `src/types.ts`
- `defaultEnabled` — the polarity of a missing value. The existing three read
  "undefined means enabled", so state saved before a toggle existed keeps
  working; `captcha_plugin` must read the other way, or every org that has never
  heard of it would count as having opted into a 56 MB download. This is why
  the default is a field on the row rather than the `!== false` idiom repeated
  at each call site.
- `source` — `{kind: 'folder', dir}` or `{kind: 'webstore', id}`
- `placement` — `'stable'` (fixed directory name) or `'per-launch'` (unique
  suffix, prune stale siblings). Ignored for `webstore`, which resolves to the
  shared cache.
- `configure(payload, extensionDir)` — optional, may be async, writes the extra
  per-profile files

One `materializeBuiltIn(payload, entry)` replaces `bundledExtensionPaths()`,
`writeProfileCookieManagerExtension()` and `writeProfileFreeProxyExtension()`.
`pruneStaleFreeProxyExtensions()` generalizes to prune by the entry's own
directory prefix rather than a hardcoded `MontiFreeProxy-`.

**Behaviour is preserved exactly**, in particular FoxyWall's per-launch unique
directory. The comment at `main.cjs:1060` documents a live CDP investigation
showing Chrome reuses a stale cached service worker when an unpacked extension
reloads from the same path. That behaviour is load-bearing and is expressed as
`placement: 'per-launch'`, not dropped.

### Crossing the process boundary

`main.cjs` is CommonJS and cannot import the TypeScript catalog, so the runtime
registry (`electron/built-in-extensions.cjs`) and the UI metadata
(`BUILT_IN_EXTENSIONS` in `src/data/extensionCatalog.ts`) remain two halves.
Their contract is the toggle key.

A vitest asserts the two key sets are identical. Without it, a fifth extension
added to one half and forgotten in the other yields a card that never loads, or
an extension with no way to turn it off — both silent.

The four `enableCookieManager` / `enableSmsActivate` / `enableFoxywallFreeProxy`
booleans on the launch payload collapse into one `builtInExtensions` map keyed
the same way. This is what makes a fifth extension a table row rather than an
edit across `src/native.ts`, `src/lib/launch.ts` and `main.cjs`.

### CaptchaPlugin

Web Store id `iomcoelgdkghlligeempdbfcaobodacg`. Manifest name "Free AI
ReCaptcha Solver by Raptor (Captcha Plugin)", v0.2.3000, MV3. Permissions are
narrow: `alarms`, `declarativeNetRequest`, `idle`, `storage`, with host access
only to `*://*.google.com/recaptcha/*`. Solves reCAPTCHA v2 / invisible /
enterprise locally on CPU. No account, no API key, free.

Files come from Google's CDN into `SharedExtensions/<id>` — the per-machine
cache `materializeSharedExtension()` already manages for team-shared
extensions: download CRX, strip the header, unzip, handle the nested-folder
case, clean up on failure, return `''` rather than throw. Reused as-is with a
synthetic entry, so there is no second download path to keep correct.

One copy per machine, shared by every profile. Vendoring into `extensions/`
would instead mean 56 MB in git and the DMG and 80 MB copied per profile per
launch.

It is deliberately **not** added to `EXTENSION_CATALOG`. A Discover card would
let someone also "Add" it as a shared extension, and the profile would then
launch with two copies of the same extension under different paths.

Its icon (`src/assets/extensions/captchaplugin.png`) is extracted from the CRX
by hand, since `scripts/fetch-catalog-icons.cjs` only covers catalog entries.

### Download on enable

The toggle ships **off**, labelled with its cost. Clicking it:

1. Renderer calls a new IPC into main.
2. Main downloads into `SharedExtensions/<id>`, streaming progress back over a
   new IPC event so the card shows a bar rather than freezing.
3. The org's cloud toggle is written **only after the download succeeds**.

Writing the toggle first would mean a failed or offline attempt leaves every
profile claiming an extension it then silently launches without. On failure the
switch stays off and shows why.

`downloadBuffer()` currently accumulates chunks with no progress reporting; it
gains an optional `onProgress` driven off `content-length`. Existing callers
pass nothing and are unaffected.

### Background catch-up

The toggle is org-wide; the 56 MB is per machine. When one member enables it,
every colleague's launcher sees `captcha_plugin: true` against an empty cache,
and their machine never clicks anything.

So at app start, if a `webstore`-sourced built-in is toggled on and its cache is
missing, main fetches it unattended — the same call as the enable path. It is
deduped by a module-level in-flight promise so repeated calls and concurrent
windows collapse into one download.

Launches never wait on it. Launch checks `isLoadableExtensionDir()` and includes
the path only if the copy is already there; a missing copy means that launch
simply has no solver.

## Error handling

Every failure degrades to "launches without it". There is no path where a
captcha solver blocks or breaks a profile launch.

- Download fails or machine is offline → enable path surfaces the error and
  leaves the toggle off; catch-up path logs and retries at next app start.
- Cache missing at launch → path omitted, launch proceeds.
- A folder-sourced extension with a missing or unreadable manifest → already
  warns and skips today; preserved by the shared materializer.

## Known limitation

`materializeSharedExtension()` returns the cache directory as soon as it is
loadable and never re-downloads. For 2Captcha that is harmless. CaptchaPlugin's
entire value is its bundled model, so a copy fetched today stays frozen while
the upstream solver improves, and no UI would say so. A version check is out of
scope for this change; this is a recorded, accepted trade.

## Testing

- `npm run typecheck` — the payload shape change touches `native.ts`,
  `launch.ts` and every toggle consumer.
- `npm test` — including the new registry/catalog key-parity test.
- By hand: a real profile still launches with Cookie Manager attached and
  seeded, SMS Activate present, and FoxyWall present and auto-connecting only
  in Free Proxy mode. The registry refactor touches live launch code and a
  passing typecheck would not catch a wrong destination directory.
- By hand: enabling CaptchaPlugin downloads with visible progress, and the next
  profile launch has the solver attached.

## Files

| File | Change |
|---|---|
| `extensions/foxywall/backend/`, `extensions/foxywall/test-api.js` | deleted |
| `electron/built-in-extensions.cjs` | new — the registry and shared materializer |
| `electron/main.cjs` | three paths removed; registry wired into launch; `downloadBuffer` progress; catch-up fetch; enable IPC |
| `electron/preload.cjs` | enable/progress bridge |
| `src/types.ts` | `BuiltInExtensionToggles` gains `captcha_plugin` |
| `src/native.ts`, `src/lib/launch.ts` | four booleans → one `builtInExtensions` map |
| `src/data/extensionCatalog.ts` | fourth `BUILT_IN_EXTENSIONS` entry; SMS Activate note gains the API-key requirement |
| `src/components/tabs/ExtensionsTab.tsx` | download-on-enable affordance and progress |
| `src/assets/extensions/captchaplugin.png` | new icon |
| `LAUNCHER.md` | `extensions/` description updated |
