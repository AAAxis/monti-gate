# launcher/ — Scout Web

Electron + React + Vite desktop app. The **control plane**: everything to do with
accounts, cloud state, billing, and deciding what a browser session gets handed.
`npm` package name `scout-web`, appId `com.monti.anty` (kept from before the rebrand: ShipIt only installs an update whose bundle id matches the running app).

## Layout

| Path | Size | What |
|---|---|---|
| `src/main.tsx` | **~215 KB, one file** | The entire React app. Profiles table, dialogs, proxy library, cookie library, fingerprint editor, settings, API tab. Start here for any UI change. **It contains no Supabase queries** — those all live in `src/db/`. |
| `src/db/` | 13 files | The data layer. One module per table plus `client.ts`, `rows.ts`, `mappers.ts`, `errors.ts`. See below. |
| `src/org.tsx` | | `OrgProvider` / `useOrg()`. Owns the auth subscription and resolves which organization the signed-in user is looking at. Mounted above `App`. |
| `src/supabase.ts` | 13 lines | Creates the client from `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Exports `null` when env is missing — every caller must null-check. |
| `src/types.ts` | | `ScoutProfile`, `ScoutCookie`, `CloudState`, `ScoutOrg`, `OrgMembership`, etc. |
| `src/native.ts` | | Typed wrapper over the preload bridge. |
| `electron/main.cjs` | **87 KB** | Main process. Browser executable resolution, launch payload assembly, proxy assignment written into the profile dir, cookie-seed extension generation, session-restore clearing, auto-update. |
| `electron/preload.cjs` | | contextBridge surface. |
| `extensions/` | | Vendored unpacked extensions: `cookie-manager`, `foxywall`, `onlinesim-sms`. Loaded into sessions via `--load-extension`. Which built-ins exist, and where each one's files come from, is the table in `electron/built-in-extensions.cjs` — Captcha Plugin is listed there but not here, since it is fetched from the Web Store on enable rather than vendored. |
| `scripts/` | | `verify-launch.mjs`, plus two **macOS-only** helpers (`start-macos-app.cjs`, `ensure-macos-app.cjs`) that `npm start`/`npm run dev` call. |
| `docs/process-boundary.md` | | The browser/launcher contract. Authoritative. |
| `bundled-browser/` | empty (`.gitkeep`) | electron-builder copies this to `resources/browser` at package time. |

## Commands

```powershell
cd E:\scout\launcher
npm run typecheck     # tsc --noEmit          <- works
npm run build         # vite build            <- works
npm run dist:win      # electron-builder nsis <- works
```

`npm run dev` and `npm start` **fail on Windows** — they use the Unix `env -u
ELECTRON_RUN_AS_NODE` and then call `scripts/start-macos-app.cjs`. For a dev loop run
Vite and Electron separately:

```powershell
npx vite --host 127.0.0.1
# in a second shell:
$env:SCOUT_LAUNCHER_DEV = "1"; npx electron .
```

## How cloud state works

Relational and multi-tenant, on Supabase project **`jpsmdjtxuxlkyuotwxfg`**. The tenant is
an `organizations` row; a client firm's workers are its `org_members`, and they share one
pool of profiles, proxies and cookies. Schema in `../docs/data-model.md`.

`src/main.tsx` contains **no queries**. Every one lives in `src/db/`:

| Module | Covers |
|---|---|
| `client.ts` | `requireClient()` / `optionalClient()`, `CloudUnavailableError`, the `raise()` error funnel, `STORAGE_BUCKET` |
| `rows.ts` | Hand-written row types. There is no generated `database.types.ts` and the Supabase CLI is not installed here — keep these in step with `../supabase/migrations/`. |
| `mappers.ts` | The **only** place row columns and `src/types.ts` shapes are translated. They genuinely differ: `checked_at`↔`last_checked_at`, `cookie_id`↔`cookie_set_id`, `start_url`↔`start_urls[]`, `command_line_switches` string↔`text[]`, `custom_statuses: string[]`↔rows. |
| `errors.ts` | `describeDbError()` — turns `profile_limit_reached`, `seat_limit_reached` and the `*_id_fs_safe` CHECKs into sentences. |
| `orgs.ts` | `listMyOrgs`, `getOrg`, `createOrg` (the `bootstrap_org` RPC), `updateBuiltInExtensions`, `currentOrgId` |
| `profiles.ts` | `list`, `create`, `replace`, `save`, `update`, `softDelete`, `restore`, `purge`, `purgeExpired` |
| `profileNotes.ts` | `list`, `summaries`, `add`, `edit`, `remove`. A profile's note thread. Only the `summaries` view rides in `CloudState`; the threads are read on demand with a limit, like `runs.ts`. `edit`/`remove` return null/false rather than throwing when RLS refuses — a note is only its author's to change. |
| `proxies.ts` | `list`, `upsert`, `remove`, `recordCheck` |
| `cookieSets.ts` | `list`, `loadPayload`, `create`, `update`, `savePayload`, `cachePayload`, `softDelete`, `restore`, `purge`, `purgeExpired`, `uploadCookieFile`, `downloadCookieFile`. `list` deliberately omits the `cookies` column — payloads are fetched one set at a time. |
| `folders.ts`, `extensions.ts`, `bookmarks.ts`, `statuses.ts` | one table each |

Two invariants the whole layer keeps:

1. **Every function takes `orgId` first and every query filters on `org_id`**, even though
   RLS enforces the same thing. A query without that filter is a bug.
2. **Every mutation touches one row.** There is no read-modify-write of an array anywhere.
   That is what makes two workers editing different profiles unable to clobber each other
   — the failure the old one-row-per-user `monti_cloud_state` blob made unavoidable.

Three consequences worth knowing before changing anything here:

- `profileToRow()` **omits `deleted_at`**. Trash membership belongs to
  `softDelete`/`restore`/`purge` alone, so an ordinary edit from a session that has not
  noticed someone else trashed a profile cannot resurrect it.
- **`profiles` is never upserted.** Postgres fires `BEFORE INSERT` triggers for
  `insert … on conflict do update` even when the conflict path is taken, so an upsert used
  to save an edit raises `profile_limit_reached` whenever the org is at its cap — a
  free-tier org with 5 profiles could not edit any of them. Hence `create` / `replace` /
  `save(…, exists)`. The other tables have no limit trigger, so their upserts are fine.
- **No `updated_at` trigger exists** in the database. `profiles` and `cookie_sets` writes
  set it explicitly.
- `built_in_extensions` lives on `organizations`, whose RLS UPDATE policy is
  `is_org_member`, so every member can toggle them — the Extensions tab states the org-wide
  blast radius rather than disabling the switches. What holds the entitlement line is the
  *column* grant, not the policy: `plan`, `seat_limit`, `profile_limit`,
  `automation_limit` and `billing_status` are not in it and are service-role only.
  `db.orgs.updateBuiltInExtensions` still asks for the row back, because RLS filters rows
  rather than erroring and a silently-reverting toggle is the failure worth catching.

### Roles

Two, since `2026-08-10-owner-member-roles.sql`: **owner** and **member**.

- The **owner** is the account holder — whoever ran `bootstrap_org`. Only they can invite,
  remove, or mint an API token (`is_org_owner` gates `org_invites`, the delete policy on
  `org_members`, and the writes on `api_tokens`). Their membership row cannot be deleted by
  anyone, including themselves: `org_members_delete` carries `role <> 'owner'`, so an org
  can never be left ownerless. Ownership transfer does not exist yet.
- A **member** has full access to everything else — every profile, proxy, cookie set and
  automation, plus the workspace's name, branding and extension toggles. They can leave of
  their own accord (`user_id = auth.uid()` in the same policy).
- Nothing changes a role. There is no `setMemberRole`, no role picker, and no UPDATE
  policy or grant on `org_members` at all — membership arrives only through
  `accept_org_invite`, which is the only writer of that table and checks the invited
  address against `auth.users`.
- `'admin'` was removed. `mappers.orgRole()` reads anything that is not `'owner'` as
  `'member'`, so a stale database that still holds the value renders safely.

Auth and org context live in `src/org.tsx`: it subscribes to `onAuthStateChange`, loads
the user's `org_members` rows, calls the idempotent `bootstrap_org()` RPC when they have
none, shows a header switcher when they have several, and persists the choice in
`localStorage` under `monti.activeOrgId`. `App` reloads whenever that id changes, and
again on window focus (throttled to 10s) so a second worker's changes arrive without a
restart.

Still in `src/main.tsx`: `requestCode()` / `verifyCode()` / `signOut()` (Supabase email OTP,
plus `signInWithGoogle()` over PKCE), and
`tokenForEmail()` — **not a real token**, a client-side FNV-1a hash of the email, so anyone
who knows an email can compute that user's "API token". Replaced in `prompts/07`.

## Launch contract (what the browser receives)

`--monti-profile-launch`, `--monti-profile-id`, `--monti-profile-name`,
`--user-data-dir`, proxy flags, shared extension paths, per-profile command-line
switches. Nothing else. The browser must never receive credentials, tokens, or a
Supabase session.

`--user-data-dir` resolves under `E:\ScoutProfiles\<profile-id>`. Profile ids are
therefore on-disk directory names — a schema migration that renumbers them orphans
every existing profile's data.

## Known Windows gaps in `electron/main.cjs`

Several helpers still shell out to macOS binaries and silently no-op or throw here:

- `killExistingProfileProcess()` calls `/usr/bin/pgrep` (~line 1533).
- Various `pkill`-based cleanup paths.
- `resolveBrowserExecutable()` (~line 801) and the `MONTI_BROWSER_APP` env default
  expect an `.app` bundle.

Worth auditing before shipping a Windows build; not blocking the cloud/billing work.

## Distribution

Two programs ship from here and update independently: this launcher, and the Monti
Browser it launches profiles into. They use different feeds and different rituals.

### Releasing the launcher

electron-builder, `publish.provider = generic` pointing at a Cloudflare R2 public bucket
(`pub-a6c0e96f900b4b698762591fddd497aa.r2.dev`). Auto-update via `electron-updater`.

```bash
# 1. bump the version. Nothing else sets it -- there is no buildVersion to keep
#    in step any more, electron-builder derives CFBundleVersion from this.
npm version 1.0.59 --no-git-tag-version
git commit -am "Release v1.0.59"
git push

# 2. tag. This, and only this, publishes.
git tag v1.0.59 && git push origin v1.0.59
```

**A push to `main` builds and typechecks but publishes nothing.** That guard exists
because the opposite cost us a release: `build-release.yml` used to publish on every
push, republishing `v<package.json version>` and overwriting `latest.yml` /
`latest-mac.yml` with a new build under a version clients already had. Six commits
landed on top of 1.0.57 that way; every 1.0.57 install reported "up to date" while
running months-old code, and only a hand re-download fixed it. CI now refuses to
publish when the tag and `package.json` disagree, and refuses to publish at all
without mac signing secrets.

### Releasing the browser

The browser is not in this repo — it is the Chromium fork in `../browser`. It has its
own feed: a per-platform manifest at
`…r2.dev/resources/browser/latest-<platform>-<arch>.json`, which `electron/main.cjs`
polls and installs itself. See `../browser/publish-browser.mjs`; the short version is

```bash
bash browser/package_dmg.sh out/Release   # sign, notarize, staple
node browser/publish-browser.mjs          # zip, hash, manifest, gh release
```

which creates a `browser-v<version>-<key>` release on this repo. `publish-browser.yml`
then mirrors the assets to R2, using the same credentials as the launcher feed. Version
comes from `browser/src/chrome/VERSION` — there is nothing to bump by hand.
