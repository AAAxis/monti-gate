# Giving agents the browser: page control, full API coverage, and a readable API tab

Date: 2026-08-05
Status: approved, not yet implemented

## Why

`docs/mcp-capabilities.md` audited what an agent can actually do through the
Scout MCP server. Its top four recommendations have since been implemented —
proxy credentials are redacted (`src/hooks/useAutomationBridge.ts:143-158`),
signed-out no longer masquerades as an empty account (`requireSignedIn()`), and
every write path enforces folder scope through `resolveInScope`
(`useAutomationBridge.ts:430-437`), including the re-folder escape the audit
called the most serious finding (`useAutomationBridge.ts:453-454`). Those
sections of that document are now stale and are corrected as part of this work.

What remains open is recommendations **#5, #6, #7 and #9**, and they are one
theme: an agent can look at a page but cannot touch it.

- There is no click, type, press, scroll, hover, select or wait-for-selector
  tool. The only lever is `scout_eval` running `element.click()`, which fires
  **untrusted** DOM events — precisely the signature an anti-detect browser
  exists to avoid. Meanwhile `electron/automation/steps.cjs:177-198` already
  dispatches real `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` and
  `Input.insertText` for the automation runner's own `click` and `type` steps.
  The correct code exists; MCP simply cannot reach it.
- `scout_list_tabs` returns tab ids **no other tool accepts**. Every page tool
  silently drives whatever `pageTarget()` picks — the first `http(s)` page, else
  the first page (`electron/cdp-core.cjs:72`). "The active page" in the tool
  descriptions is a fiction.
- `folderId` is a settable argument on `scout_update_profile` with no tool that
  lists valid folder ids. `status` is a free string with no tool that lists the
  workspace's statuses.
- An agent can drive a fleet of profiles but cannot create one.

Separately, the API tab renders every group flat and permanently expanded —
roughly thirty endpoint rows with no way to collapse any of them
(`src/components/tabs/ApiTab.tsx:195-223`) — and it is about to get much longer.

## What this is not

The MCP **connection** flow is already built and is not being rebuilt. The
Integrations tab connects ten clients (Claude Code, Codex, Cursor, Gemini CLI,
VS Code, Windsurf, Zed, Hive, and "any other MCP client"), mints a folder-scoped
key, writes the server block into that tool's own config, and verifies the
result by actually speaking MCP to the spawned server rather than trusting that
a file was written. `electron/mcp/server.cjs` ships inside the app, so
connecting installs nothing.

## Design

### 1. `electron/page-actions.cjs` — one implementation of touching a page

The input-synthesis internals of `electron/automation/steps.cjs:177-198` move
into a new module beside `electron/cdp-core.cjs`. Both the automation runner and
the new HTTP routes call it.

The property this buys: a click issued by an agent and a click issued by an
automation step are the same code path, so a future trusted-event fix lands in
both at once and neither can silently regress into `element.click()`. It also
means the anti-detect guarantee is stated in exactly one place.

The module owns: `click`, `hover`, `type`, `press`, `select`, `scroll`,
`upload`, `waitFor`, and the tab and history operations. It takes a CDP session
from `cdp-core.cjs` and knows nothing about HTTP, MCP or keys.

`steps.cjs` keeps its executors and its own error/retry semantics; only the
"how do I press a key" half moves. The runner's observable behaviour must not
change — `npm test` and `scripts/verify-automation.mjs` are the check.

### 2. `/v1/pages/*` — eighteen routes, every tool generated

Every page tool becomes a row in `electron/api/routes.json` carrying
`local: true`, answered in the main process with no renderer round trip.

Consequence worth having deliberately: page control keeps working while the
launcher window is closed, exactly as `POST /v1/profiles/cdp` does today. The
main process needs only the debugging port, which it can resolve itself.

| Group | Routes |
|---|---|
| Backfilled (MCP-only today, no HTTP route) | `navigate` `read` `screenshot` `eval` `tabs` |
| Pointer and keyboard | `click` `hover` `type` `press` `select` `scroll` `upload` |
| Synchronisation | `wait` (selector, URL, text, or navigation-idle) |
| Tabs and history | `open-tab` `close-tab` `switch-tab` `back` `forward` |

All eighteen tools are then **generated** from the table by the existing
`AUTOMATION_TOOLS` machinery (`electron/mcp/tools.cjs:349`), which replaces the
hand-written `TOOLS` block above it for these tools. Names, descriptions,
input schemas and required fields stop being a second hand-maintained copy —
which is the drift this table was introduced to end, and which the file's own
header comment already argues for.

The five backfilled routes leave `sessionTools` in `routes.json` empty; the
array and `mcpToolNames()`'s use of it (`src/api/routes.ts:76`) can then be
removed, since every tool is a route.

**`tabId` becomes an optional argument on every page route.** Omitted, it
resolves as today. Supplied, it addresses a real tab. This retires the "active
page" fiction and makes `scout_list_tabs`'s output usable for the first time.

**Prerequisite, and the one non-obvious piece of work:** the `local` branch at
`electron/main.cjs:4306-4321` is hardcoded to answer with the step schema —
`local` currently means exactly one route. It generalises into a handler map
keyed by pathname, with `/v1/automations/schema` becoming its first entry rather
than its only behaviour.

Folder scope for page routes reuses the existing session resolution, so a scoped
key reaches only sessions it launched — the rule `maySeeAutomationSession`
already enforces. Field validation comes free from `payloadForRoute`.

### 3. Coverage gaps

New routes and tools:

- `list_folders`, `list_statuses`, `list_cookie_sets` — closes the "`folderId`
  is settable with no way to discover one" hole, and the same for `status`.
- `create_profile` — the single largest "the app can, the agent cannot" gap.
- `create_folder`, `create_proxy`, `update_proxy`.
- `proxyMode` becomes a field on `update_profile`, so an agent can move a
  profile to Direct or Free Proxy. Today `scout_assign_proxy` always forces
  `'assigned'` and nothing can change it back.

Routes that exist and work over HTTP today but have no tool at all
(`electron/mcp/tools.cjs:9-13` states the rule) become reachable:
`profiles/delete`, `profiles/update-fingerprint`, `proxies/delete` and
`proxies/reimport` join the **destructive** pack; `proxies/create` and
`proxies/update` join **manage**; the new `folders/delete` joins destructive.

Two stay withheld, and for stated reasons rather than by omission:

- `cookies/bulk-match` and `cookies/push-local` are in the destructive pack —
  they write cookie snapshots into profiles, which is identity-altering.
- `monitoring/report` stays unreachable. It is the monitoring feature's own
  write path into Supabase, not an agent-facing capability, and an agent able to
  fabricate monitoring results can make a broken fleet look healthy.

**Deliberately still withheld: a read-the-cookie-jar tool.** Every other gap
here is about reach. That one hands an agent transferable session credentials
for accounts the profile is logged into, and `scout_eval` already serves the
legitimate "am I signed in" case without the httpOnly ones. This is a decision,
not an oversight, and the omission is to be commented as such in `routes.json`
so a later session does not "complete" the surface by adding it.

### 4. Tool packs

A `toolPacks` field joins `folderScope` on the key record
(`createAutomationKey`, `electron/main.cjs:3380`). Each route gains a `pack`
field in `routes.json`.

Two layers, and only one of them is a boundary:

- **Enforcement.** `main.cjs` checks the route's `pack` against the calling
  key's `toolPacks` and answers 403 with a message naming the pack. This is the
  real gate, and it is checked on the HTTP route — so it holds for plain `curl`
  and for a stale MCP client alike.
- **Advertisement.** `SCOUT_TOOL_PACKS=read,drive,manage` is written into the
  client's config beside the token at connect time, so `tools/list` filters
  instantly with no network call and no dependency on the launcher being up when
  the agent starts. This is a courtesy, not a boundary — the same relationship
  the Connectors work records between masking and access.

| Pack | Count | Contents | Default |
|---|---|---|---|
| `read` | 14 | list/get profiles, session, folders, statuses, proxies, cookie sets, tabs, read page, screenshot, automations list/get/schema, table columns | on, not disableable |
| `drive` | 18 | launch, close, navigate, back, forward, click, hover, type, press, select, scroll, upload, wait, open/close/switch tab, eval, run automation | on |
| `manage` | 10 | create profile, update profile, assign proxy, create folder, create/update proxy, create/update/delete automation, set table columns | on |
| `destructive` | 7 | delete profile, delete folder, delete proxy, reimport proxies, update fingerprint, cookies push-local, cookies bulk-match | **off** |

49 tools total; 42 enabled on a default connection. The count is the cost of
"fully listed" and was accepted with that trade-off stated.

`scout_delete_automation` stays in **manage** rather than moving to
`destructive`, even though its name argues otherwise. It is exposed today, so
filing it under a default-off pack would silently narrow every connection that
already exists. It is already gated to unscoped keys, which is the protection
that matters for an org-wide object.

**Existing keys have no `toolPacks` field.** They are read as
`['read', 'drive', 'manage']` — every tool they can reach today, and nothing
new that is destructive. No key silently gains or loses a capability on
upgrade.

Changing packs requires the agent to restart. That is already true of every one
of these tools — `src/data/integrations.ts:49` records that they read their MCP
config at process start with no reload signal — and the connect flow already
tells the user so. The pack picker sits beside the existing folder-scope picker
in the integration dialog.

### 5. The API tab

Two-level disclosure, reusing the `<details className="integration-guide">`
pattern already established on the Integrations tab
(`src/components/tabs/IntegrationsTab.tsx:324-361`) rather than inventing a
second collapsible idiom.

- Each group is a collapsed row: name, endpoint count, pack badges. Click opens
  it.
- Each endpoint row shows **both faces of one capability** — `POST
  /v1/pages/click` and `scout_click` — with its pack badge. Click opens the
  field list, request body and curl line.
- A search box filters across paths, labels and tool names, and auto-opens the
  groups holding matches.
- Nothing is expanded on arrival. The tab opens as a short index.

The existing base-URL summary, the agent-brief buttons, the create-key form and
the your-keys list stay above it and stay uncollapsed — they are tasks, not
reference.

### 6. Corrections carried along

Small, and each one is a false statement a model currently plans around:

- `electron/mcp/server.cjs:48-53` — the server instructions still claim "a
  launched session is anonymous — never send it credentials or tokens." A
  profile's assigned cookie set is seeded into the launch payload, so a launched
  profile is frequently logged into real accounts. `tools.cjs` has already been
  corrected on this point; the server-level instructions have not.
- `src/data/apiDocs.ts:198-199` — the agent brief repeats the same claim.
- `src/data/integrations.ts:203` — `MCP_TOOL_SUMMARY` is hand-maintained and
  four lines long. It becomes derived from the route table, or is updated and
  commented to say what keeps it honest.
- `docs/mcp-capabilities.md` — §4c, §5a, §6-1 and §7 items 1-4 describe problems
  that are fixed. The document is re-verified against the new surface rather
  than left asserting stale findings.

## Testing

- `scripts/verify-api-routes.mjs` extends to assert every route carries a
  `pack`, every `local` route has a handler in the map, and every generated tool
  resolves — the same cross-check it already performs for the automations tools.
- New unit coverage for `page-actions.cjs` against a stub CDP session: each
  action emits the expected `Input.*` sequence. This is the module whose
  correctness the anti-detect claim rests on.
- `scripts/verify-automation.mjs` and `npm test` must pass unchanged, proving
  the extraction did not alter the runner.
- A pack-enforcement test: a key without `destructive` gets 403 from
  `POST /v1/profiles/delete`, over HTTP, not merely a filtered `tools/list`.
- `npm run typecheck` — `src/api/routes.ts` fails compilation in both directions
  if the table and the types disagree, and that is deliberate. Do not cast
  around it.

## Order of work

1. `page-actions.cjs` extraction, runner unchanged and proven so.
2. Generalise the `local` handler map in `main.cjs`.
3. `/v1/pages/*` routes and generated tools; retire the hand-written page tools
   and `sessionTools`.
4. `tabId` plumbing.
5. Coverage-gap routes and tools.
6. Packs: key field, enforcement, config env var, dialog picker.
7. API tab redesign.
8. Corrections and doc re-verification.

Steps 1-4 are shippable on their own and are the answer to "agents can take
control over the browser". 5-8 can follow without blocking that.

## Rules this work must not break

- The main process never holds Supabase credentials; the renderer never holds a
  CDP socket. Page routes are answered in main because they need only a port —
  they must not start reading the database.
- The route table is the single source of truth. Adding a route means a
  `routes.json` entry, not a second hand-written tool.
- Folder scope is an authorization gate, not a display filter. Every new write
  route enforces it through `resolveInScope`.
- Never `upsert`.
