# Scout Web Agent Notes

Handoff memory for agent sessions working on the launcher.

Start with `../SCOUT.md` (the tree map) and `LAUNCHER.md` (this folder in detail).
`../CLAUDE.md` holds the invariants. This file is the accumulated behavioral gotchas.

## Project Split

Two separate apps/processes:

- **Scout Web** — Electron launcher/manager, this folder (`E:\scout\launcher`).
- **Monti Browser** — Chromium-based anonymous browser (`E:\monti\browser\src`), built
  and installed separately.

Do not run the launcher dashboard inside Monti Browser. Scout Web owns Supabase login,
profiles, proxies, folders, statuses, bookmarks, shared extensions, API docs/tokens,
billing, and launch payloads. Monti Browser must stay anonymous and should only receive a
profile runtime payload from the launcher.

## Run And Build

From `E:\scout\launcher` (PowerShell):

```powershell
npm run typecheck
npm run build
```

`npm run dev` and `npm start` **do not work on Windows** — they use the Unix `env -u`
and then call `scripts/start-macos-app.cjs`. Run the two halves directly instead:

```powershell
npx vite --host 127.0.0.1
# second shell:
$env:SCOUT_LAUNCHER_DEV = "1"; npx electron .
```

Node is at `C:\Program Files\nodejs` (v24.18.0, npm 11.16.0). Git is at
`C:\Program Files\Git\cmd` and may not be on PATH in a fresh shell.

To restart the app cleanly:

```powershell
Get-Process | Where-Object { $_.Name -match 'electron|Scout' } | Stop-Process -Force
```

To close currently launched browser profile windows:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'monti-profile-id=' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Current Important Behavior

- A profile has three proxy modes (`ProxyMode` in `src/types.ts`): `assigned`, `direct`
  and `free_proxy`. **Only `assigned` requires a proxy.** `ProfileModal`'s validation
  refuses a save without one in that mode alone ("Proxy is required, or pick Direct /
  Free Proxy instead"), and `resolveLaunchProxy` returns `null` — launch, no proxy, no
  block — for the other two. An undefined `proxy_mode` means `assigned`, for profiles
  saved before the field existed. (This entry used to claim direct was disabled
  entirely. It has not been for some time.)
- **Switching a profile to Direct must clear Chromium's own `proxy` pref, not just the
  `monti.profile_data` block.** They are separate keys in the same Preferences file, and
  the second is the one that routes traffic: a proxied launch leaves
  `socks5://127.0.0.1:<bridge port>` in it, pointing at a SOCKS bridge that dies with the
  session. Nothing on the browser side clears it on a direct launch — the startup
  fail-safe is skipped for `--monti-profile-launch`, and `InitializeAsync` returns early
  on the empty `assigned_proxy_id`, so `RevertToDirect` never runs. So
  `writeProfileProxyAssignment` writes `prefs.proxy = {mode: 'direct'}` itself. Drop that
  line and the *second* launch of any profile that once had a proxy fails every
  navigation, loopback included (the applicator sets no bypass rules), while the first
  launch and the whole UI look correct.
- A profile carries at most **5 tags** (`MAX_PROFILE_TAGS`). `normalizeTags()` in
  `src/lib/tags.ts` is the only enforcement point and all three write paths call it —
  `profileFromDraft`, the CSV importer and the automation bridge's profile patch. Do not
  add a fourth that skips it. `profiles.tags` stays a plain `text[]` of whatever the user
  typed; the catalog in `src/data/tagPresets.ts` is matched through `tagKey()` (case and
  punctuation stripped) plus aliases, so nothing ever rewrites a stored tag.
- Tag brand marks live in `src/assets/brands/<slug>.svg` and are picked up by
  `import.meta.glob` — never imported by name. A missing file falls back to the preset's
  lucide glyph, so the folder may be empty and the build still passes. They are the
  full-colour cuts rendered through `<img>` (`.tag-logo`), height-fixed with the width
  left to the artwork because several are wordmarks or non-square. Five need a theme fix,
  declared per-preset as `adapt` — see `src/assets/brands/README.md` before swapping a
  file for a different cut.
- Fingerprint controls belong in the profile edit dialog under `Edit fingerprint`, not in
  the main profiles table/view. `<PlatformPicker>` renders exactly once, at the top of the
  `Identity` group inside `Edit fingerprint` — it is the only control writing
  `fingerprint_os`, and picking a platform re-rolls the GPU, CPU, screen and media-device
  set via `fingerprintPatchForOs`. Because that used to leave every profile silently
  shipping as Windows 11, the `Fingerprint` card on the main form sits directly under
  Proxy — not at the bottom of the form — and its summary line names the current platform,
  browser version, timezone and WebRTC mode. Keep it there.
  **The Profiles table has three narrow exceptions, and the test they pass is the rule,
  not a compromise: a fingerprint field may be set from the table only if setting it
  leaves the identity coherent by itself.** `platform`, `fpTimezone` and `fpLanguage`
  pass; `fpBrowser` and `fpScreen` do not.
  - Timezone and Language are standalone fields with fixed preset lists
    (`timezoneGroups`, `languagePresets`) — setting one changes that one and nothing else.
  - Platform passes because it *carries* the consistency rather than breaking it:
    `ProfileCellActions.setPlatform` applies `platformFingerprintPatch`, which runs the
    same `fingerprintPatchForOs` the editor's `<PlatformPicker>` does and re-rolls the GPU,
    CPU, screen, memory and media devices along with `os`. That patch names its fields
    explicitly (`PLATFORM_FIELDS` / `PLATFORM_NUMBERS` in `profileCellActions.tsx`) rather
    than running the preset through `fingerprintFromDraftPatch`, which fills the *whole*
    fingerprint shape — spread over an existing one that would blank every field the preset
    is silent about and reset `do_not_track` and `rotate_on_launch` to false on the way.
  - Screen and Browser fail it: screen is re-rolled *by* the platform, so a resolution
    chosen on its own is a claim the rest of the identity contradicts, and browser version
    sits with it because the pair is what a checker cross-references. Those two cells are
    `CellLink`s that open this dialog at its fingerprint section
    (`editors.editProfile(profile, 'fingerprint')` → `ProfileModal`'s `openFingerprint`).

  Do not widen this to a fourth field without the same argument. Every table-side
  fingerprint write goes through `setFingerprint` or `setPlatform`
  (`src/tables/profileCellActions.tsx`) — the only two places the existing fingerprint is
  spread before the patch. `profilePatchToRow` replaces the whole object, so a cell that
  built its own patch would blank the other twenty fields.
- Only `windows`, `macos` and `linux` are fully implemented browser-side
  (`monti_ua.cc` `LookupPreset`). `Android` and `iOS` get a user-agent string but no
  UA-Client-Hints override, so they still report a desktop platform and `Sec-CH-UA-Mobile:
  ?0`; the picker says so under those two cards. `Windows 11` and `Windows 10` are the same
  `windows` preset and the same `Windows NT 10.0` UA — the distinction is presentational.
- Monti Browser launch must open a launcher-provided local home file or a real profile
  start URL. It must not open Supabase login, `localhost`, `127.0.0.1`,
  `scout web`, or `about:blank`.
- Proxy checks are automatic background checks **in the launcher**. Do not add a manual
  check *button* back to the Proxies tab — the chip is the manual check now. The surfaces
  the background sweep cannot serve, plus the chip itself:
  - In the Profiles **and** Proxies tables the **Proxy check chip is itself the re-check**
    (`ProxyCheckCell`'s `onRecheck`, passed from `profileColumns.tsx` and
    `proxyColumns.tsx`). This is not a new affordance: both tabs had a manual check as a
    `ShieldCheck` button among the row actions. Moving it onto the chip put it on the
    thing it acts on and removed the row button (Profiles five → four controls, Proxies
    four → three). A healthy or unchecked chip swaps its label to `Re-check` **while the
    chip itself is hovered** — not while its row is, which is what it used to do and is
    wrong: pointing at a profile's name is not a question about its proxy, and a column
    three across changing its words because the pointer entered the row makes the table
    twitch wherever you put the cursor. A failed one keeps saying `Failed` and offers the
    re-check inside the panel that already carried the error text and its Copy button,
    because the message is what anyone opens that chip for. Both labels are laid out at
    once and only their `visibility` changes — the table is `table-layout: auto`, so a
    chip that changed width on hover would re-lay-out every column in the table.
    Narrowing the trigger does not relax that.
  - The generated browser start page has a Re-check button on its proxy panel: that page
    shows a country and a latency measured once at launch, a session outlives that by
    hours, and you cannot reach the launcher from inside an anonymous window — so it is
    the only surface with no other way to ask. It goes through
    `POST /v1/proxies/recheck-from-page` (see the Automations section below), which
    answers in the renderer so the result is recorded against the proxy row exactly as
    the background sweep would have recorded it.
  - The profile import review step has a **Check proxies** button
    (`components/modals/ImportProfilesModal.tsx`). The sweep only ever sees saved rows,
    and the whole point of that screen is to decide *before* saving — a file of proxies
    that cannot connect should be found there, not discovered profile by profile at
    launch. It is explicit and never blocks the import, checks at most
    `CHECK_CONCURRENCY` (5) at a time through `lib/concurrency.ts` rather than one curl
    per row, and routes a row already matched to a stored proxy through
    `testConnectionAndRecord` so that result lands exactly as the sweep would write it.
    A row whose proxy is not saved yet is only tested.
- A proxy cell edit is a **narrow write, never `proxies.update`/`save`** — their
  whole-row upsert races the background sweep (a check landing mid-edit is clobbered, or
  clobbers). Renames go through `proxies.rename`; type, host:port and credential edits go
  through `proxies.setConnection`, which clears the six `last_*` check columns **in the
  same statement** — a stored country with no timestamp reads as a check that passed —
  and the sweep re-checks the row because they are null. The Proxies table's
  `username`/`password` columns are **visible by default on purpose** (they exist to be
  edited in place; the ship-hidden convention for post-launch columns is deliberately
  waived), and the password cell shows a fixed six-dot mask whatever the length — the
  real value lives in the cell's editor and its Copy button.
- **A cell that can be edited is built from `components/ui/CellControls.tsx`, and nothing
  in a table row may reserve width for something that is invisible.** `CellPicker`,
  `CellCopy`, `CellLink` and `CellTextEdit` are the four shapes; all four sit on `Popover`,
  the app's one floating layer, and all four render their rows through the shared
  `FilterOption` (lifted out of `TableFilters.tsx` so the cell pickers and the toolbar
  filters cannot become two widgets). The constraint they all exist to satisfy is that
  every table here is `table-layout: auto`: a column's width is computed from its content,
  so an affordance that appears or grows on hover makes the browser redistribute width
  across the whole table and the jitter lands on all fifty rows at once. There are exactly
  two legal ways to reveal something on hover — draw it always and change only its opacity
  or visibility (the proxy-check label), or take it out of flow entirely
  with `position: absolute` and reserve its gutter with constant padding on the `<td>`
  (`.cell-copy-button` / `td.cell-copy-cell`). `opacity: 0` on an in-flow control is the
  bug, not the pattern: that is what `.status-picker-edit` did, and it cost every status
  chip in the table ~30px of permanent blank to its right. The pencil it hid is gone from
  the table — the chip is the trigger now — and `StatusPicker` survives only for the
  profile dialog, where the field is one row in a form rather than one cell in fifty.
  **An editable cell shows no marker at rest — no caret, no border, no icon.** It is the
  value, and it becomes a button under the pointer: `.cell-trigger` takes a `--hover` fill
  at `--radius-xs` and a pointer cursor, bled 6px/8px past the text so the fill reaches
  into the cell's own gutter. The fill is an absolutely positioned `::before`, **not**
  `.th-sort`'s padding-plus-cancelling-negative-margin: a `<th>` is sized by every cell in
  its column and can shed 12px, where a `width: 1%` data cell is sized by that element
  alone, so padding out and margin back in left every value ellipsizing a few characters
  early. Same look, different mechanism, and the reason is in the comment above
  `.cell-trigger` in `styles.css`. A caret per cell was tried and reverted: eighteen of
  them down a row is the same noise the pencils were.
  The toolbar's filter pills (`.filter-trigger`) take the same treatment — flat at rest,
  the same `--hover` plate under the pointer and while open, no chevron. They are in a
  flex toolbar rather than a table cell, so they can use `.th-sort`'s literal padding and
  margin. They were drawn as bordered `<select>`-alikes until three boxed controls sitting
  above a table whose own headers carry no box read as heavier than the thing they filter.
  `FolderSelect` is the exception and stays a `.ghost` button: it lives in the selection
  toolbar among five other bordered buttons and is an action, not a filter.
  Short columns get `cell-fit` (`width: 1%` + nowrap) on their `cellClassName`; `name` is
  deliberately left unpinned so there is always something to absorb the table's slack.
  Width is a class, never a field on `TableColumn` — the registry is serialised by
  `describeColumns` into what agents read through `monti_table_columns`, and a width there
  is the front edge of resizable columns rather than a spacing fix.
- **A titled block of a form is `components/ui/FormGroup.tsx`, and there is only one card
  style for it.** `.form-section` — the same card one level louder, with a 15px `h3` — is
  gone; two card styles in one dialog read as two kinds of thing rather than as sections
  of one form. `FormGroup` takes a `title`, a required one-line `hint`, an optional `icon`
  (a 14px lucide glyph on the heading's line), an optional `info` for an `InfoHint` beside
  the title, and an optional `id` for a caller that needs to scroll the reader back to it.
  The hint is required on purpose: a section whose purpose cannot be said in a line has
  been drawn around the wrong fields.
  A group is drawn as **a frame holding an inset card** — the heading rides `--frame`, the
  fields sit in a `--frame-card` body — which is the automations grid's card
  (`.automation-card-framed` / `-body`) at form scale. Use that token pair and not
  `--paper`/`--raised`: the two swap places between light and dark, and a frame draws no
  border. Its only other consumer is `FingerprintFields`, so a change here shows up in
  both dialogs.
  `ProfileModal` is seven of them — **Account, Credentials, Proxy, Fingerprint, Cookies,
  Launch, Notes** — and the order is the order the questions get asked. Credentials was
  split out of Account so the block that Scout itself never acts on could carry a heading
  and a hint saying so. Fingerprint stays directly after Proxy for the reason above: those
  two cells are the only way into the fingerprint editor, so the platform it names has to
  be visible near the top. Notes renders only when `draft.saved`; a note is a row keyed on
  a profile id and a profile being created has none yet.
- **The two full-size editors share one header, `components/ui/EditorHead.tsx`, and
  neither has a footer.** A clickable mark, the name as a click-to-rename heading
  (`ui/TitleField.tsx`), a line of context, and every action the dialog has — in one
  sticky bar. The host passes `editor-modal` in its Modal `className`; that class carries
  the sticky rule and lifts Modal's close X out of the flex flow
  (`styles/features/editor-head.css`, which must stay **last** in the `styles.css` barrel
  because its rules only beat `features/profile-editor.css` on source order).
  `ProfileModal`'s name, avatar and colour live there, not in the Account card. Anything
  else that sticks inside the same scroll box must clear the bar: `EditorHead` publishes
  its measured height as `--editor-head-h`, and the summary column's `top` reads it.
- **A form field that picks a thing with a mark uses `components/ui/FieldPicker.tsx`, not
  a `<select>`.** Assigned-to, Folder and Run-on-launch each draw the teammate's avatar,
  the folder's glyph or the automation's brand mark, in the trigger *and* in the option
  rows — a native select can hold nothing but text, so the assignee read as a name in the
  editor and as an avatar in the table. It is `CellPickerList` (exported from
  `ui/CellControls.tsx`) behind a select-shaped trigger; the list owns the search
  threshold, the pinned unfilterable "none" row and the empty states, so do not
  reimplement them. Every caller needs `group` on its `<Field>` — the trigger is a
  `<button>`, and a `<label>` around one fires its implicit activation on the wrong
  control. `AssigneeSelect` survives as a plain select for `ImportProfilesModal` only.
- **`profiles.email` / `password` / `login_url` are a memo, and the UI has to keep saying
  so.** Scout fills nothing in: no launch payload carries them (`LaunchProfilePayload` in
  `src/native.ts`), and the browser never sees them. The only consumer is the automation
  runner, which puts all three in the template context (`electron/automation/runner.cjs`)
  so a Type step can write `{{profile.password}}` and a Go-to step `{{profile.login_url}}`.
  They are stored in **plaintext** and `scout_get_profile` hands the password to an agent,
  so the Credentials card's `InfoHint` is the only place a user can learn any of this — do
  not trim it. `loginUrl` is writable over MCP and the other two deliberately are not: it
  records *where* a credential is used, not what it is. `login_url` arrived in
  `20260818000000`; if the drift check in `src/db/rows.schema-check.ts` fails, regenerate
  `database.types.ts`.
- **A profile's notes are a thread, not a field.** `profiles.notes` was a scalar column
  that nothing ever read or wrote, and both `tools.cjs` and `routes.json` carried comments
  about an agent reporting success on a write that never happened; `20260807000000` drops
  it. The real thing is `profile_notes`: one row per entry, with `author_kind`,
  `created_by` and `author_label`. Only the summaries view rides in `CloudState` — threads
  are unbounded and read on demand, the `runs.ts` split.
  **The API and MCP can read and append, and cannot edit or delete — including their own.**
  This is a boundary, not a scope decision. Every write on that bridge runs through the
  signed-in user's Supabase session, so RLS sees `created_by = auth.uid()` on that
  person's notes and would let an agent rewrite them; the database can refuse an agent
  editing an *agent* note (`author_kind = 'user'` is in the update policy) but cannot tell
  that a write claiming to be the user is not. Do not add the missing routes. The one
  thing that does cross the IPC boundary for attribution is the calling key's
  `{id, name}`, forwarded by the table-driven dispatch in `main.cjs`, and it is the only
  reason an agent note is distinguishable from a person's.
- **`assigned_to` is a label, not a permission, and it is never written by an ordinary
  save.** Every member of an org already sees, launches and edits every profile, proxy,
  cookie set and automation — `org_id` is the only scope on any of them, and the RLS
  policies are `is_org_member` for select *and* update. Assigning changes who a row
  *names*; it grants and revokes nothing. So do not add an access check keyed off it, and
  do not describe it to a user as private.
  The column is deliberately omitted from `profileToRow`/`profilePatchToRow`
  (`src/db/mappers.ts`) and is owned by the `set_assignee` / `set_assignees` /
  `accept_handoff` RPCs alone — otherwise an edit from a session that had not seen a
  reassignment would carry its stale value back and silently unassign the row. That is
  why `ProfileModal` keeps the picker in the draft and applies it in a *second* call
  after `profiles.save()` succeeds, never as a field on the save. The control it does
  that through is a `FieldPicker` showing the Assigned column's own avatar chip.
  Note `docs/schema-changes/2026-08-06-handoffs.sql` describes a model that no longer
  holds: it made assigning to anybody but yourself impossible, requiring an offer the
  recipient accepted. **`2026-08-07-assign-directly.sql` replaced that** — assignment to
  any teammate is now direct, and `ShareModal`'s offer flow is the deliberate alternative
  for when you want them to agree first. Read the newer file before reasoning about it.
  New profiles claim their creator through the column's `default auth.uid()`, which is
  why the insert path sets nothing and the CSV importer only writes assignments when the
  import dialog's picker names somebody other than the importer — and then only for rows
  it *created*, never rows it updated.
- Profile, proxy, cookie-set and automation folders share one `public.folders` table,
  told apart by `folders.kind`. `useCloudData` splits the single read into
  `state.folders`, `state.proxy_folders`, `state.cookie_folders` and
  `state.automation_folders` — that split is the only thing keeping one library's folder
  out of another's folder row, assign dropdown, move dialog and API-key folder scope, so
  do not "simplify" the lists back into one filtered at each call site.
  `library.createFolder`/`saveFolder` require an explicit `kind`; `removeFolder` reads it
  back off state. **Each branch of the split must name its own kind.** The profile line
  was written as `kind !== 'proxy' && kind !== 'cookie'` and would have swallowed every
  automation folder the day a fourth kind existed; there is no CHECK on the column, so
  nothing but that filter stands between a new kind and the profiles rail.
- A folder icon may be `flag:<ISO>` (e.g. `flag:US`) instead of a `FOLDER_ICONS` key —
  same contract, still a short key and never markup. `FolderGlyph` is the one place that
  resolves it, and a flag folder ignores its colour (the mark carries its own), which is
  why the folder dialog hides the colour picker once a flag is chosen.
- `useProxyActions.save()` rebuilds the whole proxy row, so it must keep carrying
  `folder_id` off the existing row. Drop that line and editing a proxy's password silently
  files it back under All proxies.
- Shared extensions and the built-in cookie manager are loaded into browser sessions via
  `--load-extension`.
- Cookie import is handled through a temporary generated `ScoutCookieSeed` extension in
  the profile user data dir.
- **`cookie_sets.source_url` is the source of truth for a launch; `cookie_sets.cookies` is
  only a read cache for the inspector.** `electron/main.cjs` fetches that URL and holds no
  Supabase credentials by design, so any write that changes a set's cookies must upload a
  fresh file and rewrite `source_url` alongside the jsonb — see
  `useCookieActions.saveEntries`. A jsonb-only save looks correct in every screen of the
  app and still seeds the browser with the pre-edit cookies.
- `cookieSets.list()` deliberately omits the `cookies` column: `useCloudData` reloads on
  every window focus, and pulling every payload each time would not scale. Payloads load
  one set at a time through `loadPayload`.
- `src/lib/cookieFile.ts` is a hand-maintained TypeScript port of the cookie parsing in
  `electron/main.cjs` (~lines 1326-1423). Nothing compiles `electron/`, so the two cannot
  be one module. The contract that must not drift is the object shape `normalizeCookie()`
  returns — the inspector writes it into the database and re-uploads it as the file
  main.cjs parses back. Change one, change the other.
- **Unassigning cookies means clearing `cookie_import_path/_url/_name/_count` as well as
  `cookie_id`** — `NO_COOKIES` in `useCookieActions`. Nulling the FK alone does nothing
  visible and everything wrong: `buildLaunchPayload` used to fall back to the legacy
  fields, `drafts.ts` preserves them through every save, and `ProfileModal` hides them
  whenever `cookie_mode === 'saved'`. So a profile that was once imported into directly
  and later put on a library set keeps a live second copy of that file, and trashing the
  set would report "N profiles unassigned" while the next launch signed straight back in.
  It is also what stops `migrateLegacyCookieImports` re-minting a purged set from the same
  stale URL on the next window focus.
- `buildLaunchPayload` treats `cookie_mode === 'saved'` as authoritative: the set resolves
  or the profile launches with no cookies. It must never fall through to the legacy
  fields, for the reason above.
- Trashing a cookie-set unassigns every profile using it, and `buildLaunchPayload` /
  `migrateLegacyCookieImports` both refuse to resolve a set with `deleted_at`. All of
  these are needed together: without the self-heal guard the delete undoes itself on the
  next window focus.
- `useProfileActions.matchCookies` (Profiles tab → bulk "Import cookies") still writes
  per-profile `cookie_import_*` rather than library entries, and should stay that way:
  one library set per profile turns 40 profiles into 40 single-use sets, which is the
  opposite of a library. Same for the automation bridge's push-local.
- Profile ids double as on-disk directory names under `E:\ScoutProfiles\<id>`. Never
  renumber them.

## Windows Porting Debt

`electron/main.cjs` still shells out to macOS binaries in several places — these
silently no-op or throw on Windows:

- `killExistingProfileProcess()` uses `/usr/bin/pgrep` (~line 1533)
- other `pkill`-based cleanup paths
- `resolveBrowserExecutable()` (~line 801) and the `MONTI_BROWSER_APP` default expect a
  `.app` bundle

`scripts/start-macos-app.cjs` and `scripts/ensure-macos-app.cjs` are macOS-only by name
and by content. Audit before shipping a Windows build.

## API Port Warning

Port `3001` was owned by Dolphin Anty on the previous (macOS) machine. The Scout API tab
mentions `http://127.0.0.1:3001`. Confirm what actually holds that port here before
debugging token auth against it:

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue |
  Select-Object OwningProcess |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

If a real Scout local API is implemented, use a different port and update the API tab.

**API tokens are currently fake.** `tokenForEmail()` in `src/main.tsx` (~line 2168) is a
client-side FNV-1a hash of the email address — anyone who knows a user's email can
compute their "token", and nothing server-side ever validates it. Do not build anything
on top of it; `../prompts/07-api-tokens.md` replaces it with real hashed tokens.

Never hardcode a token in this file. If one ever ends up here, treat it as compromised
and rotate it immediately.

## Automations

**Never `upsert` an automation.** `trg_automation_limit` is BEFORE INSERT, and
Postgres fires those for `insert ... on conflict do update` even down the
conflict path — so an upsert used to *edit* a workflow fails whenever the org
sits at its cap. `src/db/automations.ts` splits create/replace for this reason,
exactly as `src/db/profiles.ts` does.

**The step catalogue is `electron/automation/step-schema.json`, not TypeScript.**
Nothing compiles `electron/`, so a TS catalogue would be maintained twice by
hand. `src/automations/schema.ts` pins the JSON to the `StepType` union in both
directions; adding a step means a JSON entry, a union member and an executor,
and the editor needs no change at all. Do not "simplify" that binding into a
cast — a cast on the right-hand side satisfies the annotation and checks
nothing.

**An automation's `parameters` are a declaration; `variables` is a bag.** Both
sit on the row. `parameters` (jsonb array, `src/automations/parameters.ts`) is
what the editor renders, what a profile answers through
`profiles.automation_vars`, and what `resolveRunVars` coerces. `variables` is
the untyped seed map MCP has always accepted and has no UI at all — a declared
parameter of the same name **shadows** its entry. That precedence is documented
on the type and enforced in `resolveRunVars`; it is deliberately not a
constraint, because the bag predates the declaration and rows using both are
already valid.

**All parameter resolution happens in the renderer, and the runner did not
change for it.** `useAutomationActions.run()` calls `resolveRunVars` and hands
the result to the `vars` argument `runner.cjs` already merged
(`{...automation.variables, ...vars}`). Do not teach the main process about
parameters: it has no automation catalogue, so it cannot see a `callAutomation`
callee's declarations, which is exactly why callee defaults and `secret` names
are both collected renderer-side and passed in.

**A `secret` parameter is redacted in three places, and `persist()` is the one
that is easy to miss.** `redactSecrets` (`electron/automation/redact.cjs`) runs
in `Run.seal()`, in the per-step log entry, **and** in `Run.persist()` — persist
rewrites `record.vars` from the raw bag on every change and once more after the
seal, so masking only in `seal()` puts the secret straight back into the record
the renderer writes to Supabase and into the disk mirror under
`<userData>/AutomationRuns/`. Masking is display protection in a record, not
encryption; the value is plaintext in the column either way.

**A field that names a variable a step WRITES is marked `writesVar` in
step-schema.json.** Six fields carry it (`setVar.name` and five `into`s). The
editor's insert chips and its unset-variable warning (`src/automations/varRefs.ts`)
read the marker rather than matching on the key name — the same argument
`check: 'selector'` already makes, and it matters here because those six share a
regex and a kind with fields that write nothing.

**`evaluate.script` is never interpolated.** Splicing user data into source is
injection, and a `{{ }}` inside real JavaScript would be silently rewritten.
Values reach a script through `args`, which are interpolated and passed as a
JSON-encoded argument.

**The local API's routes live in `electron/api/routes.json`.** `main.cjs` builds
its pathname allow-list from it, `mcp/tools.cjs` generates the automations tools
from it, and the API tab renders it. Before that table there were three
hand-written copies of one list and they had already drifted — the API tab
documented `POST /v1/proxies`, `POST /v1/profiles` and
`POST /v1/profiles/{id}/launch`, none of which were ever routed, so every agent
handed the brief burned its first turns on 404s. Add a route to the table, not
to the allow-list, and run `scripts/verify-api-routes.mjs`.

**A table's columns are a registry, and the ids are stored.** `src/tables/`
holds one registry per configurable table (Profiles, Proxies, Cookies); the tabs
render their headers, their cells and their empty-state colSpan from it, and
`useTableSort` is fed the whole registry rather than the visible slice so hiding
a column cannot strand the active sort key. What a user has hidden is stored in
Supabase auth `user_metadata` under `monti_table_columns`, keyed by column id —
so **never rename an id**. Renaming one silently hides that column for everyone
who had saved a layout naming it; retire a column by dropping it from the
registry and never reusing the id. The stored value is the user's *deviations*
from the defaults, not the list of visible columns: a list cannot tell "I hid
this" from "this did not exist when I saved", and it would permanently lose the
Assigned column for anyone who configured their tables while working alone.

**The automations tools are generated, and the filter is `channel || local`, not
`mcp`.** Nine profile/proxy routes also carry an `mcp` name so the agent brief
can list every tool from one file; filtering the generator on `mcp` alone builds
a second, field-less copy of each of those nine. `tools/list` then answers with
thirty tools and `scout_update_profile` resolves to the copy that forwards no
fields. `verify-api-routes` checks for exactly this.

**A folder-scoped key may not author automations.** A key granted one folder
could otherwise rewrite a workflow every other folder runs. List, read and run
are allowed; create, update and delete are `403`. Enforced in `main.cjs` off the
route's `scope` field.

The original reason was that automations had no folder at all. 20260817 gave
them one, and the rule stayed — deliberately. An automation folder is filing,
not a permission boundary: every member's RLS policy on `automations` is plain
org membership, so scoping authorship by folder would read a guarantee into a
label the database does not enforce. Widening it is a permissions change and
wants its own change.

**The showcase example is an ordinary automation.** `src/data/showcaseAutomation.ts`
is a plain template with **no `id`** — `exampleAutomation()` mints one with
`newId()` at insert, because the id becomes a directory name under
`<userData>/AutomationRuns/` and has to satisfy `automations_id_fs_safe`; a
constant would also collide on the primary key the second time anyone loaded
it. Once inserted it is a row like any other. Nothing reads it at runtime,
nothing keys off its name, and no code path asks "is this the example?" —
keep it that way, or the first user who renames it finds a feature that
stopped working. Its `else` branch is currently the one that always runs: we do
not rank for "monti browser" and the site is not indexed.

**Do not add `--remote-allow-origins`.** It used to be `*` on every automation
launch, which let any web page reach the CDP socket. Our clients send no
`Origin` and Chromium accepts that.

**`close_on_finish` is real now, and it closes only what the run opened.**
It was persisted, mapped both ways and editable for months while nothing read
it — `showcaseAutomation.ts` said so in a comment. The rule has two halves and
both are load-bearing: the automation asks for it, AND the renderer reports
`ownsSession` (the `!session.running` branch of `startRun` — the run had to
launch the profile). `main.cjs` ANDs them and hands `runner.start` an
`onFinish` callback that calls `killAutomationLaunch`. Drop `ownsSession` and
ticking that box closes the window a user was working in the moment they run
anything against that profile. Cancelling never closes anything either — the
user just asked for the run to stop, not for their window to go.

The runner takes a **callback**, not the launch table. It owns the CDP socket
for the length of a run and nothing else; teaching it to kill processes puts
both halves of the process boundary in one file. `run.finish()` moved into
`execute`'s `finally` for this: the close happens before the record is sealed,
so a browser that will not die is logged into the run the user reads rather
than into a record that was already flushed.

**Connectors are the one table for every outside service** (`public.connectors`,
category `'ai' | 'message'`), replacing the short-lived `ai_providers`. The UI
lives under **Automations → Connectors** (fourth chip), NOT in Settings — the
old `AiProvidersSection` is deleted. The preset catalogue is
`src/data/connectors.ts`: each kind declares its config fields (`secret` is
what masking and the password inputs key off), and both the connector form and
validation are generated from it — adding a kind is a catalogue entry plus a
send adapter in `electron/automation/connectors.cjs`, never a schema change.
`is_default` is per `(org_id, category)`; `db/connectors.setDefault` demotes
then promotes AND scopes both statements by category.

**A connector's secret never leaves the main process.** Steps store a
connector *id*; the renderer reads `connectors` from Supabase and pushes the
resolved list over `scout:set-connectors`, where `automation/connectors.cjs`
holds it in a module-level Map — memory only, like run tokens. That is what
keeps the credential out of the steps, the vars, the log and `run.json`, which
is what makes it safe for a run record to be flushed to the cloud and read by
the org. Do not add a step field that carries a token, and do not let any MCP
tool list connectors with `config` — `useAutomationBridge` already strips
proxy credentials for exactly this reason.

The **adapter and base URL are resolved on the renderer side**
(`runtimeConnector` in `src/data/connectors.ts`) before the push. Nothing
compiles `electron/`, so the alternative is a second hand-kept copy of thirteen
base URLs over there — the same drift `step-schema.json` exists to prevent.
There are two AI adapters for thirteen providers because eleven of them publish
an OpenAI-compatible `/chat/completions` (`automation/ai.cjs`, which now holds
ONLY the completion protocol — the Map and the HTTP transport moved to
`connectors.cjs`). Do not write a third without checking first. Message kinds
get one send adapter each in `connectors.cjs`; its `postText` treats 2xx
non-JSON as success on purpose — Slack's webhook answers the literal text `ok`
and Discord answers 204, and "fixing" that fails every send that worked.

**Notify-on-finish runs between `seal()` and `flush()`** — the old
`run.finish()` split in two (`electron/automation/runner.cjs`). The order in
`execute()`'s finally is: close the browser → `seal` the verdict → `onNotify`
(awaited; composes title/body off the sealed record via `automation/notify.cjs`
and sends through a connector) → `flush` (persist + finished event). A send
that fails is logged into the record the user reads; move the send after
`flush` and it is logged into a record already gone. `onNotify` never throws
for a dead connector — it returns `sendError` on the notification instead, so
a broken webhook cannot also silence the bell row. Cancelled never notifies,
even on `'always'`; `'failure'` includes `partial`. Both rules live in
`notify.cjs` `shouldNotify` and are tested from
`src/automations/notifyOnFinish.test.ts` through the hand-kept `notify.d.cts`.

**The `notifications` row is written by the renderer, not by main.** Main has
no Supabase; it composes the notification, raises the OS `Notification` (first
use in the repo — skipped while the window is focused, `raiseOsNotification`
in `main.cjs`) and rides the row on the `finished` event;
`useAutomationRuns`'s `onNotification` callback (wired in
`useAutomationActions`) inserts it and patches the bell. The bell
(`InboxBell.tsx`) renders two kinds — handoffs first, then run notifications —
and tones a notification from its stored `status`, never recomputing the
verdict. Read state is `notification_reads`, insert-only, one row per
(notification, user); `markRead` swallows 23505 one id at a time because a
batched insert fails atomically.

**`aiCheck` stores `'yes'`/`'no'` as a string, not a boolean.**
`evaluateCondition` compares with `String()` on both sides, so a boolean would
work by accident and read as a bug. Anything the model says that is not one of
those two words fails the step rather than being guessed at — a hedge silently
resolving to `no` is how a branch starts taking the wrong arm.

**The Run button never picks a profile.** It opens `RunAutomationModal`. It used
to call `runTarget()` — the single attached profile, else whatever row happened
to be highlighted on the Profiles tab — and the first sign that the guess was
wrong was the main process refusing the spawn seconds later with "Proxy
1.2.3.4:5678 did not respond … Fix the proxy in Scout Web and try again",
a sentence about a profile the user never chose. The dialog shows each profile's
proxy health before the commit and a profile whose proxy failed its check cannot
be ticked. `runTarget` still exists for the editor's Check button alone, and now
prefers `automations.lastRunProfileId()` so Check tests against the page the
last run actually used — the two agreeing is the reason that file exists.

**Why Run is greyed out is `describeRunBlock`, and it lives beside
`runReadiness`.** The card used to disable Run for one reason (no profiles) and
leave it enabled for the other (every profile's proxy dead), which opened a
dialog where nothing could be ticked and nothing said why. Both reasons now come
from the same pure function the dialog's rows use, so the button and the dialog
cannot disagree. It returns a sentence, not a structure: the card shows it as a
`title` on a **wrapper span**, because Chromium suppresses pointer events on a
disabled control and a `title` on the button itself never appears at the one
moment it is needed. There is deliberately no banner on the card — the tab
already carries one standing note, and repeating it per card says it twelve
times.

**`RUN_CONCURRENCY` (`src/automations/limit.ts`) must equal
`MAX_CONCURRENT_RUNS` (`electron/automation/runner.cjs`).** The runner's cap
does not queue — over it, `start()` throws `Too many runs at once (3 is the
limit)` with `status = 429`. `runMany` is the renderer-side queue that stops
that being reached, and it paces on **completion**, not on `startRun` returning:
`execute()` is deliberately not awaited over there, so a queue built on the
start alone launches every profile at once and trips the cap. `waitForRun` in
`useAutomationRuns` is what turns the cap into a queue. Nothing compiles
`electron/` and no IPC reports the runner's cap, so the pair is hand-kept.

**The automation run path goes through `proxies.resolveForLaunch`, like every
other launch.** It used to read `state.proxies` directly and hand the result to
`buildLaunchPayload`, which is why a dead proxy surfaced as a dead run rather
than as a blocked launch with a reason. That function was `resolveLaunchProxy`
in `useProfileActions`; it moved to `useProxyActions` so the Launch button and
the runner share one gate. It resolves through `matchedProxyForProfile`, not a
find on `proxy_id` — as does `automations/runReadiness.ts`, or the dialog would
offer a profile the gate then refuses.

**The debugging port is opened when a launch has start-page tiles, not on every
launch.** `useProfileActions.launch` reserves one when the profile has an
automation attached *or* any automation is pinned — `startPageAutomations()` in
`src/lib/startPageAutomations.ts` is the single answer to "what tiles does this
launch have", and `buildLaunchPayload` renders the tiles from the same call, so
the port and the tiles cannot disagree. Pinning is the opt-in: a workspace that
pins nothing and attaches nothing still launches with no extra switches at all.
Do not widen this to every launch — an always-on `--remote-debugging-port` is
connectable by any local process and CDP attachment is observable from the page.

**The two page routes are not part of the keyed API surface.**
`POST /v1/automations/run-from-page` and `POST /v1/proxies/recheck-from-page` sit
*above* the bearer gate in `main.cjs` and authenticate with the per-launch run
token instead, because the caller is a `file://` document that has no key and
must never be given one. They are deliberately absent from
`electron/api/routes.json`; `verify-api-routes.mjs` skips them by name. Both take
their id off the token's entry rather than the request body, which is what makes
them safe to open at all — the run route names an automation from a list minted
with the token, and the re-check route names nothing. Every refusal on both is
the same 403 with the same body, so neither is an oracle. If you add a third,
extend `scripts/verify-run-token.mjs` with its refusal paths.

**A run token is minted on every launch**, including one with nothing pinned and
nothing attached — the proxy panel needs it. Those carry `cdpPort: null` and an
empty automations list, and `authorize()` looks every requested id up in that
list, so such a token can re-check and nothing else.

## Verification Checklist

Before handing back UI/app changes:

```powershell
cd E:\scout\launcher
npm run typecheck
npm run build
```

Both must be clean. `npm test` runs the vitest suite (pure functions only —
no jsdom is configured), and there are three end-to-end verification scripts;
anything touching the runner, the start-page token or the local API should run
them:

```
node scripts/verify-automation.mjs   # drives a real browser through a workflow
node scripts/verify-run-token.mjs    # the start-page endpoint's refusal paths
node scripts/verify-api-routes.mjs   # the route table vs what main.cjs serves
```

`verify-api-routes` needs nothing running — no Electron, no browser, no
Supabase — so there is no excuse for skipping it. Then restart the app and click through the
path you changed.
