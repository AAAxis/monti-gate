#!/usr/bin/env node
// Asserts the route table and the server agree, in both directions.
//
// electron/api/routes.json is the source of truth for three consumers: the
// pathname allow-list in electron/main.cjs, the tool catalogue in
// electron/mcp/tools.cjs, and the endpoint list the API tab shows. main.cjs now
// derives its allow-list from the table, so those two cannot disagree by
// construction -- but the older routes are still *dispatched* by hand-written
// blocks further down that file, and a route present in the table with no block
// behind it is a documented 404. That is the drift this checks for, and it is
// the exact failure the previous hand-written catalogue shipped: three routes
// documented that were never built.
//
//   node scripts/verify-api-routes.mjs
//
// No Electron, no Supabase, no running launcher. Exits non-zero on the first
// failure so it can sit in the verification checklist next to the other two.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const {routes, sessionTools} = JSON.parse(
    readFileSync(join(root, 'electron/api/routes.json'), 'utf8'));
const mainSource = readFileSync(join(root, 'electron/main.cjs'), 'utf8');
const toolsSource = readFileSync(join(root, 'electron/mcp/tools.cjs'), 'utf8');

let failures = 0;

function check(ok, message) {
  if (ok) {
    return;
  }
  failures += 1;
  console.error(`FAIL  ${message}`);
}

// Reports the section just finished. It has to consult the failure count
// rather than print unconditionally: the first version did print
// unconditionally, and a run with ten failures still ended every section with
// an "ok" line -- including "ok 30 tools, no duplicates" directly underneath
// the duplicates it had just found.
let reported = 0;

function pass(message) {
  if (failures > reported) {
    console.log(`FAIL  ${message}`);
    reported = failures;
    return;
  }
  console.log(`ok    ${message}`);
}

// ── 1. Every route is dispatched somewhere ───────────────────────────────────
// A table route is served either by a `channel` (table-driven dispatch), by
// `local: true` (answered in main), or by a hand-written block that names its
// pathname as a string literal.
for (const route of routes) {
  const key = `${route.method} ${route.path}`;
  if (route.channel || route.local) {
    continue;
  }
  check(
      mainSource.includes(`'${route.path}'`),
      `${key} is documented but no handler in main.cjs names its pathname`);
}
pass(`${routes.length} routes each reach a handler`);

// ── 2. Every pathname main.cjs compares against is in the table ──────────────
// The reverse direction: a route served but not documented is invisible to
// agents and to the API tab.
const served = new Set();
for (const match of mainSource.matchAll(/pathname === '(\/v1\/[^']+)'/g)) {
  served.add(match[1]);
}
// These page routes authenticate with a per-launch run token instead of a key
// and sit above the bearer gate on purpose -- they are not part of the keyed
// surface and must never be advertised as one. run-from-page runs one of the
// launch's own automations; run-any-from-page runs any automation in that
// launch's WORKSPACE, resolved on demand by the launcher's renderer;
// list-from-page lists that workspace's automations for the side panel;
// status-from-page and cancel-from-page report and stop whatever is running
// against that launch's own profile; open-in-launcher raises the launcher
// window, with one of the launch's own automations showing or just on the
// Automations tab; recheck-from-page re-checks that launch's own proxy;
// push-from-profile/pull-for-profile/list-for-profile/list-sets-for-profile
// sync the cookie-manager extension's jar with that launch's profile and let
// the panel pick from the workspace's cookie library.
//
// Every one of them takes its profile id AND its org id from the token's entry
// rather than from the request, which is what makes them safe to open to a
// file:// document (or, for the panel routes, the bundled extension). Three of
// them do read an id out of the body -- run-any-from-page's automationId,
// pull/list-for-profile's setId, push-from-profile's saveToSetId -- and every
// one of those is resolved against the entry's own workspace in the renderer
// before it is acted on. That is the compensating control; it is not RLS, on
// purpose. See run-token.cjs.
const PAGE_ROUTES = new Set([
  '/v1/automations/run-from-page',
  '/v1/automations/run-any-from-page',
  '/v1/automations/list-from-page',
  '/v1/automations/status-from-page',
  '/v1/automations/cancel-from-page',
  '/v1/automations/open-in-launcher',
  '/v1/proxies/recheck-from-page',
  '/v1/cookies/push-from-profile',
  '/v1/cookies/pull-for-profile',
  '/v1/cookies/list-for-profile',
  '/v1/cookies/list-sets-for-profile',
]);

for (const pathname of served) {
  if (PAGE_ROUTES.has(pathname) || pathname.startsWith('/v1/oauth/')) {
    continue;
  }
  check(
      routes.some((route) => route.path === pathname),
      `main.cjs serves ${pathname} but the table does not document it`);
}
pass(`${served.size} pathnames in main.cjs are accounted for`);

// Every route this file exempts as a page route must actually be served by
// main.cjs -- otherwise PAGE_ROUTES could silently accumulate dead entries
// (or, worse, hide a route that was renamed and never re-registered) with
// nothing here to notice.
for (const pathname of PAGE_ROUTES) {
  check(served.has(pathname), `PAGE_ROUTES names ${pathname} but main.cjs does not serve it`);
}
check(
    !routes.some((route) => PAGE_ROUTES.has(route.path)),
    'a PAGE_ROUTES entry leaked into electron/api/routes.json, the keyed route table');
pass(`${PAGE_ROUTES.size} page routes are served and stay off the keyed table`);

// A literal-string match only proves the pathname appears somewhere in
// main.cjs, not that it is dispatched before the bearer-key gate -- which is
// the actual invariant that makes these routes safe to reach from a
// file:// document with no key at all. Comparing source offsets catches a
// route that got moved below the gate as surely as one that was never wired
// up. The anchor is the CALL site, not `function resolveAutomationKey(req) {`
// -- that definition also contains the literal text `resolveAutomationKey(req)`
// and sits above every route dispatch in the file, which would make every
// route's offset come out larger than the anchor's and fail this check
// unconditionally, for routes that are in fact correctly positioned.
// Every from-page handler must answer through sendPageJson, not sendJson.
//
// sendPageJson adds `Access-Control-Allow-Origin: *`; sendJson does not, on
// purpose (the keyed surface must not carry it). A from-page route wired to the
// wrong one works perfectly from the side panel -- a chrome-extension:// page
// holding <all_urls> is exempt from CORS -- and is silently unreadable from the
// file:// start page, where fetch() rejects before the caller sees the status.
// The page then reports whatever its blanket catch says, which for Re-check is
// "The check did not complete", a sentence that describes neither the cause nor
// the fix.
//
// That is not hypothetical and it is why this check exists: every start-page
// POST was broken this way once already, the fix was a one-word change at each
// of eight call sites, and nothing in the repo would have noticed the ninth.
// A comment saying "any new from-page route must use sendPageJson" was the only
// thing holding the invariant, and comments do not fail CI.
for (const match of mainSource.matchAll(/handle(\w*)FromPage\(\{/g)) {
  const body = mainSource.slice(match.index, match.index + 700);
  const end = body.indexOf('\n}');
  const call = end === -1 ? body : body.slice(0, end);
  check(/sendJson:\s*sendPageJson\b/.test(call),
      `main.cjs's handle${match[1]}FromPage call does not pass sendJson: sendPageJson -- ` +
      'its replies would be unreadable from the file:// start page');
}
pass('every from-page handler answers through sendPageJson');

const gateOffset = mainSource.indexOf('const key = resolveAutomationKey(req);');
check(gateOffset !== -1,
    'main.cjs no longer calls resolveAutomationKey(req) as expected -- update this check');
for (const pathname of PAGE_ROUTES) {
  const routeOffset = mainSource.indexOf(`pathname === '${pathname}'`);
  check(routeOffset !== -1, `main.cjs does not compare pathname against ${pathname}`);
  check(
      routeOffset !== -1 && gateOffset !== -1 && routeOffset < gateOffset,
      `${pathname} is dispatched at or after resolveAutomationKey(req) -- it must sit above the bearer gate`);
}
pass(`${PAGE_ROUTES.size} page routes are dispatched above the bearer gate`);

// ── 3. Table-driven routes declare a channel preload will accept ─────────────
const preloadSource = readFileSync(join(root, 'electron/preload.cjs'), 'utf8');
check(
    preloadSource.includes('api/routes.json'),
    'preload.cjs builds its channel allow-list from the table');
for (const route of routes.filter((item) => item.channel)) {
  check(
      /^scout:[a-z-]+$/.test(route.channel),
      `${route.path} declares a malformed channel: ${route.channel}`);
}
pass('table-driven routes declare well-formed channels');

// ── 4. Declared fields are well formed ───────────────────────────────────────
const FIELD_TYPES =
  new Set(['string', 'number', 'boolean', 'object', 'objects', 'steps', 'tags', 'strings']);
for (const route of routes) {
  for (const field of route.fields || []) {
    check(
        FIELD_TYPES.has(field.type),
        `${route.path} field ${field.key} has unknown type ${field.type}`);
  }
  check(
      route.scope === 'any' || route.scope === 'unscoped',
      `${route.path} has unknown scope ${route.scope}`);
}
pass('every declared field has a known type');

// ── 5. Every named MCP tool exists ───────────────────────────────────────────
// The generated automations tools come from the table itself, so this catches
// the other direction: a route naming a hand-written tool that was renamed or
// removed, which would leave the agent brief advertising a tool that is not
// there.
const generated = new Set(routes.filter((r) => r.channel || r.local).map((r) => r.mcp));
for (const route of routes.filter((item) => item.mcp)) {
  if (generated.has(route.mcp)) {
    continue;
  }
  check(
      toolsSource.includes(`name: '${route.mcp}'`),
      `${route.path} names MCP tool ${route.mcp}, which tools.cjs does not define`);
}
for (const tool of sessionTools) {
  check(
      toolsSource.includes(`name: '${tool.mcp}'`),
      `sessionTools names ${tool.mcp}, which tools.cjs does not define`);
  // The label is what the API tab prints for a tool with no route to describe
  // it. An entry without one renders as a bare name, which is the drift this
  // table exists to prevent.
  check(
      Boolean(tool.label) && Boolean(tool.group),
      `sessionTools entry ${tool.mcp} needs both a group and a label`);
}
pass('every MCP tool named in the table is defined');

// ── 6. Tools that need a description have one ────────────────────────────────
for (const route of routes.filter((item) => item.channel || item.local)) {
  check(
      Boolean(route.mcpDescription),
      `${route.path} is table-driven and exposed as ${route.mcp} but has no mcpDescription`);
}
pass('generated tools carry descriptions');

// ── 7. The built catalogue has no duplicates ─────────────────────────────────
// The generator filters on `channel || local`, not on `mcp`, because nine of
// the hand-written tools also carry an `mcp` name so the agent brief can list
// every tool from one file. Filtering on `mcp` alone silently generated a
// second, field-less copy of each of those nine: tools/list answered with
// thirty tools, and BY_NAME resolved scout_update_profile to the generated
// copy, which forwards no fields at all. Nothing else would have caught it.
const {listed} = await import(`file://${join(root, 'electron/mcp/tools.cjs')}`)
    .then((module) => module.default || module);
const built = listed();
const names = built.map((tool) => tool.name);
check(
    names.length === new Set(names).size,
    `tools.cjs defines duplicate tool names: ${
      names.filter((name, i) => names.indexOf(name) !== i).join(', ')}`);
for (const tool of built) {
  check(
      Boolean(tool.description) && Boolean(tool.inputSchema),
      `${tool.name} is missing a description or inputSchema`);
}
pass(`${built.length} tools, no duplicates`);

if (failures > 0) {
  console.error(`\n${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\nAll route-table checks passed.');
