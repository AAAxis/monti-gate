# What an AI agent can do through the Scout MCP server

Scope: the 39 tools in `electron/mcp/tools.cjs`, the loopback automation API in
`electron/main.cjs` they call, and the renderer handlers in
`src/hooks/useAutomationBridge.ts` that actually answer.

## Re-probe this document; do not reason about it from source

The tool count above has been wrong twice, in both directions, and the reason is
structural rather than clerical.

`~/.claude.json` points the `scout` MCP server at
`Scout Web.app/Contents/Resources/app/electron/mcp/server.cjs`. On a
development machine that `app` is a **symlink to the repo**, so a new MCP
process picks up `routes.json` and `tools.cjs` the moment they are saved — no
build, no reinstall. But three things move at three different speeds:

| Layer | Picks up a change when |
|---|---|
| MCP tool list (`tools.cjs`, `routes.json`) | the next MCP process starts |
| Route dispatch (`electron/main.cjs`) | the launcher app restarts |
| Bridge handlers (`src/hooks/…`) | `npm run build`, then the window reloads |

And on top of that, **an MCP client caches `tools/list` at connect time.** A
Claude Code session started before a change never sees the new tools no matter
what the server would answer. During the connectors work this produced a session
holding 23 tools against a server serving 29 — the agent in it could not know
what it was missing.

So the failure mode is not "the doc is stale". It is "the doc, the server, the
router and the client all disagree, and every one of them answers confidently".
Before trusting anything below, drive `server.cjs` over stdio with the command
and env from `~/.claude.json` and read `tools/list` yourself. A route that
answers `Not found` with a valid token means the launcher has not restarted
since the route was added.

Everything below is marked either **[verified]** — actually executed against the
running launcher over stdio JSON-RPC, exactly as an agent client would — or
**[read]** — inferred from the source, not run. Nothing that opens a browser
window or mutates state was executed.

Verification harness: the server was spawned with the same command, args and env
an agent client uses (`process.execPath` with `ELECTRON_RUN_AS_NODE=1` and the
user's own key), then driven with newline-delimited JSON-RPC. Launcher version
reported by the server: `1.0.55`.

---

## 1. The surface

**[verified]** `tools/list` returned exactly 23 tools at the time of the run
below. It now returns 25: `scout_profile_notes` and `scout_add_profile_note`
were added afterwards and are marked **[read]** in the table.

| Tool | Backed by | Verified? |
|---|---|---|
| `scout_list_profiles` | `GET /v1/profiles` | verified |
| `scout_get_profile` | `POST /v1/profiles/get` | verified |
| `scout_profile_session` | `POST /v1/profiles/cdp` | verified |
| `scout_launch_profile` | `POST /v1/profiles/launch-automation` | read only |
| `scout_close_profile` | `POST /v1/profiles/close-automation` | read only |
| `scout_update_profile` | `POST /v1/profiles/update` | read only |
| `scout_profile_notes` | `POST /v1/profiles/notes` | read only |
| `scout_add_profile_note` | `POST /v1/profiles/notes/add` | read only |
| `scout_list_proxies` | `GET /v1/proxies` | verified |
| `scout_assign_proxy` | `POST /v1/profiles/assign-proxy` | read only |
| `scout_check_proxy` | `POST /v1/proxies/check` | verified |
| `scout_list_tabs` | CDP `/json/list` | error path verified |
| `scout_navigate` | CDP `Page.navigate` | error path verified |
| `scout_read_page` | CDP `Runtime.evaluate` | read only |
| `scout_screenshot` | CDP `Page.captureScreenshot` | read only |
| `scout_eval` | CDP `Runtime.evaluate` | read only |
| `scout_list_automations` | `GET /v1/automations` | read only |
| `scout_automation_schema` | `GET /v1/automations/schema` | read only |
| `scout_get_automation` | `POST /v1/automations/get` | read only |
| `scout_create_automation` | `POST /v1/automations/create` | read only |
| `scout_update_automation` | `POST /v1/automations/update` | read only |
| `scout_delete_automation` | `POST /v1/automations/delete` | read only |
| `scout_run_automation` | `POST /v1/automations/run` | read only |
| `monti_table_columns` | `GET /v1/tables/columns` | read only |
| `monti_set_table_columns` | `POST /v1/tables/columns` | read only |
| `scout_list_connectors` | `GET /v1/connectors` | read only |
| `scout_create_connector` | `POST /v1/connectors/create` | read only |
| `scout_update_connector` | `POST /v1/connectors/update` | read only |
| `scout_delete_connector` | `POST /v1/connectors/delete` | read only |
| `scout_test_connector` | `POST /v1/connectors/test` | read only |
| `scout_list_folders` | `GET /v1/folders` | read only |
| `scout_list_statuses` | `GET /v1/statuses` | read only |
| `scout_telegram_status` | `GET /v1/telegram` | read only |
| `scout_set_telegram_pref` | `POST /v1/telegram/pref` | read only |
| `scout_set_telegram_bot` | `POST /v1/telegram/bot` | read only |

Twenty tools are thin wrappers over loopback HTTP routes; five need a running
browser and speak CDP directly (`electron/mcp/cdp.cjs`).

The seven automations tools, the two table-column tools and the two
profile-notes tools are **generated**
from `electron/api/routes.json` rather than written out, so their names,
descriptions and input schemas cannot drift from the routes they call. `scripts/verify-api-routes.mjs` checks the rest
of the table the same way. The nine profile/proxy wrappers above them are still
hand-written.

Two things about that surface worth stating plainly, because they are the
answers to the questions an agent asks first:

- **Automations are org-wide and have no folder.** A folder-scoped key may list,
  read and run them; only an unscoped key may create, change or delete one.
  Anything else would let a key granted one folder rewrite a workflow every
  other folder runs. Refusals are `403`.
- **Steps are validated in the main process before anything is stored**, by the
  same `validateSteps` the runner uses (`electron/automation/steps.cjs`). An
  agent cannot persist a workflow the runner would then refuse, and the error
  names the failing path (`steps[2].then[0].selector is required`).

**[verified]** The server is dual-era: it answers both `initialize` (returning
`protocolVersion: 2025-06-18`) and `server/discover` (returning
`supportedVersions: ["2026-07-28","2025-11-25","2025-06-18","2025-03-26","2024-11-05"]`).
`ping` works. `resources/list` returns `-32601 Method not found` — there are no
resources and no prompts, only tools (`electron/mcp/server.cjs:151-192`).

---

## 2. What an agent CAN do — verified by execution

### Enumerate profiles
`scout_list_profiles` returned five real profiles. The payload is deliberately
minimal — **`id` and `name` only**:

```json
{"status": true, "profiles": [
  {"id": "d77190bb-e59b-41bc-8286-e021c62fd6a1", "name": "Profile 10:31 PM"},
  {"id": "f8078410-9be3-40b6-a742-e73b1ecd81ea", "name": "mosley.caterina"},
  {"id": "69880ec5-5250-4e5d-b885-ab2590a2a025", "name": "ponce_shill"},
  {"id": "1792d3f2-0b3e-4a81-a486-2d04438aa930", "name": "kunze_elson"},
  {"id": "47868305-551f-4df9-ae1d-304064055849", "name": "adeshinayomi.alatalo.4097"}
]}
```

Shape fixed at `src/hooks/useAutomationBridge.ts:375-381`. Trashed profiles
(`deleted_at`) are filtered out. The optional `folder` argument works but is an
exact id match — passing an unknown folder returned `{"profiles": []}`, not an
error.

### Read one profile in full
`scout_get_profile` returns the whole row, including the complete fingerprint:

```
id, name, status ("Ready"), color, tags[], folder_id, proxy_id, proxy_mode,
start_url, cookie_import_path/url/name/count, cookie_mode ("saved"), cookie_id,
command_line_switches, created_at, deleted_at,
fingerprint: { os, audio, webgl, canvas, screen, webgpu, webrtc, language,
  timezone, cpu_cores, cpu_model, memory_gb, user_agent, geolocation,
  client_rects, do_not_track, webgl_vendor, media_devices, webgl_renderer,
  browser_version, rotate_on_launch }
```

### Enumerate proxies — **including plaintext credentials**
`scout_list_proxies` returned 11 proxies. Each row carries
`id, name, type, host, port, username, password, folder_id, country,
country_code, egress_ip, ping_ms, checked_at, assignedProfileIds[]`.

`username` and `password` are returned **in clear text**. This is the raw
`ScoutProxy` row spread wholesale (`src/hooks/useAutomationBridge.ts:229-237`).
Any agent connected to this MCP server has the user's full proxy credential set
in its context after one tool call.

### Check whether a profile is running
`scout_profile_session` answered entirely in the main process, no renderer round
trip (`electron/main.cjs:3736-3753`):
`{"status":true,"profileId":"…","running":false,"cdpUrl":null,"pid":null}`.

### Test a proxy
`scout_check_proxy` returned `{"ok":true,"ip":"206.251.200.232","country":"US","countryCode":"US","pingMs":497}`.
It runs `curl` in the main process against three geo-IP endpoints
(`electron/main.cjs:1663-1686`) and needs neither the renderer nor a signed-in
session (`electron/main.cjs:3865-3879`).

### Error handling that a model can actually recover from
Tool failures come back as `isError: true` content, not JSON-RPC errors
(`electron/mcp/server.cjs:91-97`) — verified:

- unknown profile → `"Profile not found"`, `isError: true`
- CDP tool on a closed profile → `"Profile <id> is not open. Call scout_launch_profile first."`
- unknown tool name → JSON-RPC `-32602`
- bogus bearer token → `"Missing or invalid Authorization bearer token"`
- missing token → same, plus a stderr warning at startup
  (`electron/mcp/server.cjs:250-253`)

---

## 3. What an agent can do in principle — read from code, NOT executed

These were deliberately not run (they open real windows, kill sessions, or write
to the user's account).

- **`scout_launch_profile`** — `POST /v1/profiles/launch-automation`
  (`electron/main.cjs:3843-3914`, `4008-4014`). Allocates a free loopback port,
  forwards to the renderer, which calls `spawnProfile` with
  `--remote-debugging-port=<port> --remote-allow-origins=*`
  (`src/hooks/useAutomationBridge.ts:389-413`). Main waits up to 15 s for
  `/json/version` to answer, then records the session in `automationLaunches`
  keyed by profile id with the launching key's id, and returns
  `{profileId, cdpUrl, pid}` (`electron/main.cjs:3447-3473`). If the profile is
  already open it returns `{reused: true}` instead of restarting, unless
  `relaunch: true`. The automation path deliberately skips the interactive
  proxy-retry UI **and skips fingerprint rotate-on-launch**
  (`src/hooks/useAutomationBridge.ts:384-388`) — automated runs get a stable
  fingerprint, unlike the Launch button.
- **`scout_close_profile`** — kills only sessions this process tracks; a window
  a human opened by hand is never reachable (`electron/main.cjs:3116-3120`,
  `3237-3261`).
- **`scout_update_profile`** — sets `name`, `tags` (capped at 5 by
  `normalizeTags`), `status`, `color`, `folderId`, `avatar`, `proxyMode`,
  `startUrl`, `loginUrl`, `automationId` and `automationVars`
  (`electron/main.cjs:3977-3994`, `src/hooks/useAutomationBridge.ts:294-313`).
  `automationVars` is the profile's answers to automations' declared
  parameters, keyed by automation id — `{"flat-search": {"city_name":
  "Dortmund"}}`. It **replaces the whole map**, so read it back with
  `scout_get_profile` and merge rather than sending one automation on its own.
  The tool forwards only its declared fields, so a name it does not advertise
  (`email`, `password`) cannot be reached through it. `loginUrl` **is**
  advertised, and deliberately: it records *where* a stored credential is used,
  not what it is, so an agent writing it cannot lock anybody out. It is also the
  address a sign-in workflow reads as `{{profile.login_url}}`.
- **`scout_assign_proxy`** — resolves a proxy by id (or host/port) and writes
  `proxy_id` + `proxy_mode: 'assigned'` (`src/hooks/useAutomationBridge.ts:190-212`).
- **CDP tools** (`electron/mcp/cdp.cjs`):
  - `scout_list_tabs` — `GET <cdpUrl>/json/list`, filtered to `type === 'page'`,
    returning `{id, title, url}` (`cdp.cjs:295-299`).
  - `scout_navigate` — `Page.navigate` + wait for `Page.frameStoppedLoading`,
    30 s cap; returns `{loaded, url, title}` and reports `loaded: false` rather
    than failing if the page never settles (`cdp.cjs:207-231`).
  - `scout_read_page` — `el.innerText` of `document.body` or a CSS selector,
    truncated to 20 000 chars by default (`cdp.cjs:233-254`, `tools.cjs:17`).
  - `scout_screenshot` — JPEG q70 by default, PNG on request, optional
    `captureBeyondViewport`; returns a text caption plus an image block
    (`cdp.cjs:273-293`, `tools.cjs:222-235`).
  - `scout_eval` — **arbitrary JavaScript** with `returnByValue` and
    `awaitPromise` (`cdp.cjs:256-269`). This is the only way to interact with a
    page; see §6.

---

### Automation parameters — one workflow, many profiles

An automation may declare **parameters**: typed, named inputs its steps read as
`{{vars.<name>}}`. That is what lets a single flat-search workflow run Dortmund
on one profile and Essen on the next, instead of the city being a literal buried
in a `goto` step.

- **`scout_automation_schema`** returns a `parameters` block alongside the step
  catalogue: the descriptor shape, the seven kinds, the resolution order and the
  limits. Call it before authoring — it is the only place the vocabulary is
  written down for an agent.
- **`scout_create_automation` / `scout_update_automation`** take `parameters`,
  an ordered list of `{name, kind, label?, required?, default?, options?, hint?,
  placeholder?}`. Update replaces the whole list. Bad declarations come back as
  a 400 naming the index and the problem, from the same `validateParams` the
  editor runs (`src/automations/parameters.ts`) — what the dialog refuses the
  API refuses identically.
- **`scout_list_automations`** returns each automation's `parameters`, so an
  agent can see what to pass without pulling the whole step tree.
- **`scout_update_profile.automationVars`** stores a profile's answers.
- **`scout_run_automation.vars`** overrides them for one run. A declared name is
  coerced to its kind; any other name is passed through as a plain seed
  variable, exactly as this field worked before parameters existed.

**Resolution order**, weakest first: callee defaults of any `callAutomation`
target → the automation's own `default` → the profile's stored value → `vars`.
A blank never overrides — it falls through. A **required** parameter with no
value and no default refuses the run before a browser opens, in a sentence
naming the profile and the parameter.

**One call is one profile.** `scout_run_automation` takes a single `profileId`
and answers with a single run id. To run the same automation with different
values across profiles, call it once per profile with that profile's `vars` —
which is also the only way to get a run id per profile to poll through
`scout_automation_runs`.

**`secret` parameters are masked in run history** (`••••` in
`automation_runs.vars` and in every log line), so a value an agent writes there
cannot be read back out through `scout_automation_runs`. It is still stored as
plain text in the database, like every proxy password and connector credential.

### Connectors — write-only credentials

A `notify`, `aiPrompt` or `aiCheck` step names a connector by id and carries
nothing else. That is what keeps every bot token, webhook URL and API key out of
the steps, the vars, the run log and `run.json` — which is what makes it safe for
a run record to be flushed to Supabase and read by the whole org.

An API that handed those credentials back would put them somewhere strictly
worse: an agent transcript, which is logged and which the user cannot unsend. So
the boundary here is not "connectors are hidden" — it is **`config` is
write-only**:

- `scout_list_connectors` returns `{id, name, kind, category, is_default,
  configured}` and a `kinds` catalogue. `configured` is the list of config keys
  that hold a non-empty value — **key names, never values**. Without it, "the
  send failed" and "the bot token was never saved" are indistinguishable from
  outside, and the second is the likelier one.
- `scout_create_connector` and `scout_update_connector` accept `config`. Anything
  sent that way is in the caller's transcript by definition — that is the
  caller's decision to make, and it is the only way to set a workspace up from
  chat. Nothing sent can be read back afterwards.
- `update` **merges** `config` key by key. A caller changing a chat id must not
  have to re-send the bot token to keep it, and a caller that omits `config`
  entirely must not blank every credential on the row.
- `category` is derived from `kind` via the preset catalogue and is never
  accepted from the caller — otherwise a Telegram bot could be filed as an AI
  provider and resolve into an `aiPrompt` step.

Writes are owner-only. RLS enforces it, but an UPDATE or DELETE that RLS filters
out returns success with no rows, so the bridge checks `org.isOwner` first and
answers 403 with a sentence — a member's edit must not look like it worked.

The `kinds` block is derived from `CONNECTOR_PRESETS` by `connectorKindsForApi()`
(`src/data/connectors.ts`), not hand-written in `electron/`. Same reason
`step-schema.json` is one file: nothing compiles `src/` into `electron/`, so a
second copy of five messaging shapes and thirteen AI ones is drift by
construction. `src/data/connectors.test.ts` asserts the block carries only static
catalogue keys, so a stored value cannot start riding along by accident.

Every write goes through `useConnectorActions` rather than `db.connectors`
directly, and that is load-bearing rather than stylistic: those actions patch
cloud state, and the hook's effect pushes the resolved list to the main process
on every patch. Writing straight to the database would leave
`electron/automation/connectors.cjs` holding a stale map — so a connector created
over MCP would exist in Supabase and be unusable by a run until the app
restarted.

**Telegram appears twice and the two are not the same thing.** A `telegram`
*connector* is org-shared, carries its own bot token, and is what a `notify` step
or `notifyConnectorId` sends through. The *personal* path
(`scout_telegram_status`, `scout_set_telegram_pref`) is the workspace's
notification bot messaging one member's own chat about runs they subscribed to —
`organizations.telegram_bot_*` + `user_telegram` + `automation_telegram_prefs`,
per person, no id. An agent that conflates them will hunt for a connector id that
does not exist.

## 4. What an agent CANNOT do

### 4a. Deliberately omitted

`electron/mcp/tools.cjs:9-13` states the rule: bulk-import routes are not
exposed, and destructive ones only behind an explicit opt-in. As of the
profile-CRUD change, `profiles/delete` (soft-only), `profiles/update-fingerprint`
and `profiles/create` now have tools — see §4b. These routes still exist and work
over HTTP but have **no MCP tool**:

| Route | Effect withheld from agents |
|---|---|
| `POST /v1/proxies/create` | add a proxy to the library |
| `POST /v1/proxies/update` | edit a proxy |
| `POST /v1/proxies/delete` | delete a proxy (unassigns profiles) |
| `POST /v1/proxies/reimport` | bulk proxy import |
| `POST /v1/cookies/bulk-match` | match a cookies folder onto profiles |
| `POST /v1/cookies/push-local` | write a cookie snapshot into a profile |
| `POST /v1/monitoring/report` | write a monitoring result to Supabase |

Note `scout_delete_profile` is soft-delete only: the route accepts
`permanent: true`, but the tool never sends it, so an irreversible purge stays in
the app.

Editing and deleting a profile note have no route at all, let alone a tool, and
that is a security boundary rather than a decision about scope. Every write on
this bridge runs through the signed-in user's Supabase session, so RLS sees
`created_by = auth.uid()` on that person's own notes and would allow an agent to
rewrite them. The database can refuse an agent editing an *agent* note — the
update policy requires `author_kind = 'user'` — but it cannot tell that a write
claiming to be the user is not. Agents append to the backlog; they never rewrite
it, and the absent routes are what enforces that.

Note the header comment names `proxies/create` but not `proxies/update` or
`proxies/delete`; all three are in fact omitted, which is consistent with the
stated intent.

### 4b. Not built — no route exists at all

**[verified]** `POST /v1/folders/list` and `GET /v1/cookies` return
`404 {"status":false,"msg":"Not found"}` with a valid token. The route allow-list
is the pathname chain at `electron/main.cjs:3687-3706`; anything not on it 404s.
(`POST /v1/profiles/create` was on this list and is now a real route — see below.)

Compared against what the app itself can do, an agent has **no** way to:

- **Create a profile.** ~~No create route exists.~~ **Now possible** via
  `scout_create_profile` / `POST /v1/profiles/create`, which builds the row
  through the same `newProfileDraft`/`profileFromDraft` pipeline the New Profile
  dialog uses.
- **Duplicate, restore from Trash, or purge.** (`useProfileActions.ts:117,126`)
- **Import or export profiles as CSV.** (`useProfileActions.ts:242,319`)
- **See folders.** ~~No route lists folders.~~ **Now possible** via
  `scout_list_folders`, which returns the profile, proxy, cookie and automation
  folder ids the four `folderId` arguments take (profile folders narrowed to the
  key's scope; the other three are listed whole, because the scope is a gate on
  profiles and means nothing to them). The four groups are separate namespaces
  even though one table backs them, so an automation's `folderId` has to come
  from the `automations` group — `automationExtras` rejects an id from any of
  the others. **Creating, renaming and deleting** folders
  (`src/workspace/useLibraryActions.ts:64,74,90`) are still unreachable, on
  purpose: a folder is how a workspace is organised, not a side effect of a
  script.
- **Restore an automation from Trash, or delete one permanently.**
  `scout_delete_automation` moves an automation to Trash, where it stops
  running and stops being listed but stays recoverable for 30 days. Both ways
  out of Trash — Restore and Delete permanently — are app-only, on the same
  terms as the profile Trash above: an agent may undo its own reach, but only a
  person may make it final.
- **See statuses.** ~~`custom_statuses` is never listed.~~ **Now possible** via
  `scout_list_statuses`, which returns the built-in labels per table plus the
  workspace's custom ones. `scout_update_profile.status` is still a free string,
  so an agent *can* still write a label the pickers do not offer — it just no
  longer has to guess. Creating a custom status stays app-only.
- **Touch cookies at all.** The whole cookie library — upload a set, edit
  entries, duplicate, trash, assign a set to profiles, export JSON/Netscape
  (`src/workspace/useCookieActions.ts:100,131,168,249,358`) — has no MCP
  surface. `cookie_id` is readable via `scout_get_profile` and nothing more.
- **Manage extensions.** Install from the Web Store or a folder, enable/disable
  (`useLibraryActions.ts:197,242,261,273,291`). Not exposed.
- **Manage bookmarks / the start page.** (`useLibraryActions.ts:136,164,183`)
- **Edit fingerprints.** ~~The route exists but is deliberately withheld.~~
  **Now possible** via `scout_update_fingerprint`, which merges a whitelisted set
  of fingerprint fields into the stored one.
- **Set `proxy_mode`.** ~~`scout_update_profile` does not accept it.~~ **Now
  possible**: `scout_update_profile` accepts `proxyMode` (assigned/direct/
  free_proxy). Assigning a specific proxy is still `scout_assign_proxy`; switching
  to direct/free_proxy clears the proxy.
- **Set the start URL** — **now possible** via `scout_update_profile.startUrl`
  and `scout_create_profile.startUrl`. The profile's **login URL** is writable
  too (`scout_update_profile.loginUrl`). **Command-line switches and the
  profile's account email/password** are still not exposed through any declared
  tool parameter — they are edited in the UI, in the profile editor's Credentials
  card — by design: switches are a launch-time code-execution surface and
  credentials are a deliberately closed write hole. See the caveat in §4c.
- **Manage account, org, plan, API keys or integrations.** Nothing under
  `src/settings/` is reachable. API keys especially: an agent cannot mint or
  revoke the credential it is itself holding.
- **Link a member's Telegram.** `scout_telegram_status` reports whether the
  signed-in user is linked and `scout_set_telegram_pref` changes what they are
  subscribed to, but the link itself stays in the app. It needs a human to press
  Start in the bot, and `electron/telegram-link.cjs` watches the bot's
  `getUpdates` feed for up to 120 s — four times the MCP HTTP client's 30 s cap
  (`electron/mcp/api.cjs:11`), so the call could not survive the wait even if the
  human were instant. The tool says so in its `linked: false` reply rather than
  leaving a model to invent a reason.
- **Control tabs.** `scout_list_tabs` returns tab ids, but no tool accepts one.
  There is no open-tab, close-tab or switch-tab. Every CDP tool silently targets
  whatever `pageTarget()` picks — the first `http(s)` page in `/json/list`, else
  the first page (`electron/mcp/cdp.cjs:67-76`). "Active page" in the tool
  descriptions is a fiction; it is "first page found".
- **Interact with a page.** There is no click, type, hover, scroll, select,
  upload, wait-for-selector or cookie-jar tool. The only lever is `scout_eval`.

### 4c. Looks like an oversight, not intent

1. ~~**`scout_update_profile` declares a `notes` parameter that does nothing.**~~
   **Fixed.** The phantom `notes` parameter is gone; the tool's schema now
   declares only fields the route actually maps.
2. ~~**`scout_update_profile` forwards every argument it is given.**~~ **Fixed.**
   Its `run` now forwards only the declared fields via an explicit whitelist, so
   a guessed `email`/`password` is dropped at the tool layer rather than written.
3. **`scout_check_proxy` declares `type` and the route drops it.**
   `tools.cjs:162` documents `type: 'http or socks5'`; the handler passes only
   `{host, port, username, password}` to `checkProxy`
   (`electron/main.cjs:3871-3876`), so `proxyUrl` always builds `http://…`
   (`electron/main.cjs:1602-1605`). **[verified]** identical results with
   `type: "socks5"` and with no type at all. A socks5-only proxy will be
   reported dead.
4. **`scout_assign_proxy`'s description is wrong.** It says "direct connection
   is not allowed" (`tools.cjs:140-141`). `ProxyMode` is
   `'assigned' | 'direct' | 'free_proxy'` (`src/types.ts:59`), all three are
   selectable in the UI (`ProfileModal.tsx:239-251`), and the launch path only
   requires a proxy when the mode is `'assigned'`
   (`src/hooks/useAutomationBridge.ts:402-407`). The accurate statement is: *a
   profile in the default `assigned` mode needs a valid, reachable proxy, and
   MCP cannot change the mode.*
5. **The server instructions claim launched sessions are anonymous.**
   `electron/mcp/server.cjs:52-53` and `tools.cjs:83` both tell the model "the
   browser session is anonymous — never pass it credentials." A profile's
   assigned cookie set is seeded into the launch payload
   (`src/lib/launch.ts:23-25,62-69`), so a launched profile is frequently
   **logged into real accounts**. The profile read above carries
   `cookie_mode: "saved"` and a live `cookie_id`. The instruction is true about
   *not sending new* credentials and misleading about what is already there.
6. **Folder scoping is not enforced on the write routes.** See §5a — this is the
   most serious of the six.

---

## 5. Limits, scoping and failure modes

### 5a. Folder scoping — enforced on reads, missing on writes

A key is either full-access (`folderScope: null`) or restricted to an explicit
list of folder ids (`electron/main.cjs:3037-3067`). Main forwards
`allowedFolders: key.folderScope` to the renderer, and the renderer enforces it.

Enforced:

| Route | Where |
|---|---|
| `GET /v1/profiles` | `main.cjs:3669` → `useAutomationBridge.ts:379` |
| `POST /v1/profiles/get` | `main.cjs:3975` → `useAutomationBridge.ts:219` |
| `POST /v1/profiles/delete` | `main.cjs:4000` → `useAutomationBridge.ts:328` (re-reads from the DB rather than the render cache, because it is an authorization gate) |
| `POST /v1/profiles/launch-automation` | `main.cjs:4013` → `useAutomationBridge.ts:398-400` |

**Not enforced — `allowedFolders` is never sent and never checked:**

| Route | Where |
|---|---|
| `POST /v1/profiles/update` | `main.cjs:3990-3994`, `useAutomationBridge.ts:294-313` |
| `POST /v1/profiles/assign-proxy` | `main.cjs:3963-3970`, `useAutomationBridge.ts:190-212` |
| `POST /v1/profiles/update-fingerprint` | `main.cjs:4002-4007`, `useAutomationBridge.ts:355-370` |
| `GET /v1/proxies` | `main.cjs:3673-3686` — the full library, credentials included, regardless of scope |
| all `/v1/proxies/*` writes | no scope plumbing at all |

Two consequences, both **[read]**, not executed:

- A folder-scoped key can rename, retag, restatus, recolour and **re-folder any
  profile in the account**, including ones it cannot see. `folderId` is a
  settable field.
- That is a scope escape: move an out-of-scope profile into an in-scope folder
  with `scout_update_profile`, then `scout_get_profile` and
  `scout_launch_profile` it legitimately.

Scoping is also not a secret-hiding boundary: `scout_list_proxies` hands every
key the whole proxy library in clear text.

**[verified]** When a scoped key does hit an enforced check, the MCP layer
rewrites the 403 into a message that names the cause:
`"…. This connection's key is scoped to specific folders."`
(`electron/mcp/server.cjs:121-126`).

### 5b. Session ownership and launcher restarts

`resolveProfileCdp` (`electron/main.cjs:3187-3216`) resolves a running session in
two tiers:

1. `automationLaunches`, an in-process map, liveness-checked with
   `GET /json/version`. A stale entry is dropped so `close-automation` cannot
   later kill a recycled pid.
2. Failing that, Chromium's `DevToolsActivePort` file inside the profile's own
   user-data-dir — which survives a launcher restart. A session re-adopted this
   way is recorded with `pid: null` and **`launchedByKeyId: null`**.

`maySeeAutomationSession` (`electron/main.cjs:3230-3235`): a full-access key sees
everything; a folder-scoped key sees only sessions carrying its own
`launchedByKeyId`.

The consequence, documented in the source and worth restating: **after the
launcher restarts, a folder-scoped key can no longer see, drive or close even
its own still-running session** — the re-adopted entry has no owner, so the
scoped check denies it. It must relaunch. Full-access keys are unaffected.

Closing is guarded separately at `electron/main.cjs:3722-3729`: a scoped key
gets 403 if the tracked session was launched by a different key. Killing an
untracked session falls back to `killStaleProfileProcess` rather than signalling
pid `null`, which on POSIX would signal the launcher's own process group
(`electron/main.cjs:3243-3250`).

Sessions a **human** opened with the Launch button are not in
`automationLaunches` at all — but they still write `DevToolsActivePort`… without
`--remote-debugging-port`, so no port is bound and the file resolves to nothing
drivable. In practice CDP tools only reach automation-launched windows.

### 5c. Hard dependencies

| Condition | What the agent sees |
|---|---|
| Launcher not running | `"Scout Web is not running, or its local API is not ready yet"` — `ECONNREFUSED` is translated (`electron/mcp/api.cjs:62-66`) |
| Launcher window closed (`mainWindow === null`, `main.cjs:923-928`) | HTTP 503 `"Scout Web window is not open"` on every renderer-backed route (`main.cjs:3656,3674,3755`). On macOS the app survives window close, so the API stays up and returns 503 for reads/writes. |
| Window busy / renderer wedged | HTTP 504 `"Timed out waiting for Scout Web to respond"` after **`AUTOMATION_REQUEST_TIMEOUT_MS = 20000`** (`main.cjs:2976`), surfaced verbatim as an `isError` tool result. The MCP HTTP client's own cap is 30 s (`electron/mcp/api.cjs:11`), so the server-side 504 normally wins. |
| **Signed out** | **Silent empty results.** See below. |

Two routes are answered entirely in the main process and keep working while the
window is closed or the renderer is wedged: `POST /v1/profiles/cdp`
(`main.cjs:3736`) and `POST /v1/proxies/check` (`main.cjs:3865`). The five CDP
tools also keep working, since they only need the port.

**Signed-out behaviour — [verified], and the worst failure mode here.**
`useAutomationBridge` is mounted unconditionally at `src/App.tsx:87`, above the
sign-in early return at `src/App.tsx:140-141`. When there is no session, cloud
state stays `defaultCloudState` — every array empty
(`src/data/statuses.ts:23-34`). The bridge therefore answers, successfully, with
nothing. During this investigation the app moved from signed-in to signed-out
between probe runs and the difference was directly observable:

```
10:01  scout_list_profiles → 5 profiles;  scout_list_proxies → 11 proxies
10:06  scout_list_profiles → {"status": true, "profiles": []}
       scout_list_proxies  → {"status": true, "proxies": []}
       scout_get_profile("d77190bb-…")  → isError "Profile not found"
```

HTTP 200, `status: true`, `isError: false`. An agent cannot distinguish
"signed out" from "this account has no profiles", and a profile it read
successfully five minutes earlier now reports as not found. Nothing in the
response mentions authentication.

### 5d. Profile launch preconditions

**[read]** In order, a launch needs:

1. The profile to exist and not be trashed (`useAutomationBridge.ts:394-397`).
2. The key's folder scope to allow it (`useAutomationBridge.ts:398-400`).
3. **If `proxy_mode` is `'assigned'` (the default when unset): a proxy with both
   host and port**, or the launch fails with
   `"Proxy for <name> is invalid"` (`useAutomationBridge.ts:401-407`).
   Modes `'direct'` and `'free_proxy'` launch with no proxy — so the blanket
   claim that direct connection is disabled is **not** accurate; what is
   accurate is that MCP cannot set the mode, so from an agent's point of view a
   profile is whatever mode a human left it in.
4. A resolvable browser binary. If Monti Browser is still downloading the error
   is explicit (`electron/main.cjs:2033-2046`).
5. **The proxy to actually answer.** `spawnProfileUnchecked` runs a live
   `checkProxy` before spawning and fails closed:
   `"Proxy <host>:<port> did not respond … Fix the proxy in Scout Web and
   try again."` (`electron/main.cjs:2047-2064`). Budget: 6 s connect, 10 s total
   per endpoint, three endpoints in parallel.
6. CDP to come up within 15 s of the renderer reporting success
   (`electron/main.cjs:3461`).

**Timeout arithmetic worth knowing [read]:** the renderer round trip may take up
to 20 s and the CDP wait a further 15 s, for a worst case near 35 s — beyond the
MCP client's 30 s HTTP cap (`electron/mcp/api.cjs:11`). A slow launch can be
reported to the agent as a timeout while the browser is in fact coming up. The
agent's correct recovery is `scout_profile_session`, not a retry.

### 5e. CDP-layer limits

- One WebSocket per tool call, opened and closed each time
  (`electron/mcp/cdp.cjs:14-17`) — no state, no cursors, no handles.
- Command timeout 30 s, connect timeout 10 s, navigation settle 30 s
  (`cdp.cjs:22-26`).
- `scout_read_page` truncates at 20 000 characters and returns `innerText`, so
  it sees no `<title>`-less SPA shells, no shadow DOM, no iframes, and nothing
  the layout hides.
- `scout_screenshot` defaults to JPEG q70 explicitly to keep bytes out of the
  agent's context (`cdp.cjs:271-272`).
- If the profile has no page at all: `"That profile has no open page to drive"`
  (`cdp.cjs:73`).

---

## 6. Security notes an operator might not expect

1. **Proxy credentials leave the machine with the agent.** One
   `scout_list_proxies` call puts every proxy username and password into the
   agent's context, and therefore into whatever the agent's transcript is
   uploaded to. **[verified]**
2. **`scout_eval` is unrestricted JavaScript in a session that is often logged
   in.** Combined with the cookie seeding in `src/lib/launch.ts:62-69`, an agent
   that can launch a profile can act as the account that profile belongs to —
   read mail, post, transfer, exfiltrate — and the server's own instructions
   tell the model the session is anonymous. There is no allow-list of origins,
   no confirmation step, and no audit trail beyond `lastUsedAt` on the key.
3. **The token lives in plaintext, world-readable.** The key store itself is
   written `0600` (`electron/main.cjs:3034`), but the token is copied into the
   agent's own config — on this machine `~/.claude.json`, mode `-rw-r--r--`.
   Any local process, or any other agent, can read it and drive the API.
4. **CORS preflight is fully permissive.** `OPTIONS` is answered before
   authentication with `Access-Control-Allow-Origin: *`,
   `Access-Control-Allow-Methods: GET, POST, OPTIONS` and
   `Access-Control-Allow-Headers: Content-Type, Authorization`
   (`electron/main.cjs:3626-3633`) — **[verified]** including from
   `Origin: https://evil.example`. Actual responses carry **no**
   `Access-Control-Allow-Origin`, so a cross-origin page cannot *read* replies;
   but the preflight succeeds, so a page holding a leaked token can still fire
   side-effecting `POST`s blind. `/health` is likewise unauthenticated and
   confirms the app is installed and running to any web page. **[verified]**
5. **No key expiry, no rate limit, no scope beyond folders.** `createAutomationKey`
   (`electron/main.cjs:3048-3067`) records no TTL and no read/write distinction.
   Revocation is manual, from the API tab.
6. **`scout_check_proxy` is an outbound-connection primitive.** It takes an
   arbitrary host and port from the agent and runs `curl --proxy` against three
   external endpoints (`electron/main.cjs:1614-1686`), needing neither the
   renderer nor a signed-in session. Timing differences make it usable as a
   crude port prober, and it will happily attempt credentials the agent supplies
   against a host the user never configured.

---

## 7. Recommendations, ranked

1. **Enforce `folderScope` on `profiles/update`, `profiles/assign-proxy` and
   `profiles/update-fingerprint`.** Today a scoped key can re-folder any profile
   in the account and thereby escalate into full access — the scope is a read
   filter, not an authorization boundary. (`main.cjs:3963-4007`)
2. **Stop returning proxy passwords from `GET /v1/proxies`.** Redact
   `username`/`password`, or return a `hasCredentials` boolean. Nothing an agent
   does with the current tool set needs them — `scout_assign_proxy` takes a
   `proxyId`. (`useAutomationBridge.ts:229-237`)
3. **Distinguish "signed out" from "empty".** Have the bridge return an explicit
   error (or main return 503) when `orgId` is null, instead of a successful empty
   array. An agent silently told "you have no profiles" will confidently report
   the wrong thing. (`src/App.tsx:87,140`; `src/data/statuses.ts:23`)
4. **Fix the two descriptions that mislead the model.** Drop "direct connection
   is not allowed" (`tools.cjs:140-141`) and replace "the browser session is
   anonymous" with the truth — the profile may carry a live cookie set
   (`server.cjs:52`, `tools.cjs:83`). A model that believes a session is
   anonymous will treat it as safe to point at anything.
5. **Add page-interaction tools: click, type, wait-for-selector.** Right now
   every interaction has to go through `scout_eval` and `element.click()`, which
   produces untrusted DOM events — precisely the signature an anti-detect
   browser exists to avoid. Synthesising real input via
   `Input.dispatchMouseEvent`/`dispatchKeyEvent` would make the integration fit
   the product.
6. **Make tabs addressable.** `scout_list_tabs` returns ids no other tool
   accepts, and every CDP tool silently drives the first `http(s)` page it finds
   (`cdp.cjs:67-76`). Either accept a `tabId` argument or stop advertising the
   list.
7. **Add a read-only folder/status listing tool.** `folder` and `folderId`
   arguments exist with no way to discover valid values, and `status` is a free
   string that can be set to something the UI never offers.
8. **Drop the dead `notes` parameter, honour `type` in `proxies/check`, and set
   `additionalProperties: false` on `scout_update_profile`.** Three small
   correctness fixes: a parameter that silently does nothing
   (`tools.cjs:124`), a parameter silently discarded so socks5-only proxies
   read as dead (`main.cjs:3871-3876`), and an unfiltered passthrough that lets
   undeclared `email`/`password` reach the account row (`tools.cjs:129`).
9. **Consider exposing profile creation behind an opt-in.** It is the single
   largest "the app can, the agent cannot" gap — an agent can drive a fleet but
   cannot grow one — and unlike deletion it is not destructive.
