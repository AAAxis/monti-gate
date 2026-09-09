// The one place row shapes and app shapes are translated.
//
// src/types.ts predates the relational schema and its field names do not match
// the columns: a proxy's check result is `checked_at`/`egress_ip`/`ping_ms`/
// `check_error` in the app and `last_checked_at`/`last_ip`/`last_latency_ms`/
// `last_error` in the table, a profile's cookie set is `cookie_id` here and
// `cookie_set_id` there, and two scalar fields are arrays in the database.
// Renaming the app types would touch every tab and dialog in main.tsx, so the
// translation lives here instead and the UI keeps reading what it always read.
import {normalizeParams, normalizeProfileVars} from '../automations/parameters';
import {normalizeSchedule} from '../automations/schedule';
import {isRunStatus} from '../automations/runStatus';
import {normalizeTags} from '../lib/tags';
import type {
  ScoutAutomation,
  ScoutConnector,
  ScoutCookie,
  ScoutFolder,
  ScoutOrg,
  ScoutProfile,
  ScoutProxy,
  AutomationRun,
  ScoutNotification,
  BuiltInExtensionToggles,
  NoteAuthorKind,
  OrgInvite,
  OrgMember,
  OrgRole,
  ProfileNote,
  ProfileNoteSummary,
  ProxyMode,
  Handoff,
  HandoffKind,
  HandoffStatus,
  SharedBookmark,
  SharedExtension,
} from '../types';
import type {
  AutomationStep,
  AutomationVars,
  RunLogEntry,
  RunStatus,
  RunTrigger,
} from '../automations/types';
import type {
  AutomationRow,
  AutomationRunRow,
  ConnectorRow,
  CookieSetRow,
  CustomStatusRow,
  FolderRow,
  NotificationRow,
  OrganizationRow,
  OrgInviteRow,
  OrgMemberIdentityRow,
  ProfileNoteRow,
  ProfileNoteSummaryRow,
  ProfileRow,
  ProxyRow,
  HandoffRow,
  SharedBookmarkRow,
  SharedExtensionRow,
} from './rows';

// A row payload on the way in: org_id is always ours to set, and every column
// is optional so an update can carry only what changed.
export type Insert<T> = {org_id: string} & Partial<T>;

function undef<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

// The app keeps command-line switches as the raw contents of a textarea and
// electron/main.cjs's splitSwitches() is what trims and drops blank lines at
// launch time. So the round trip here splits and rejoins on \n and nothing
// else -- trimming here would silently rewrite the user's text every time the
// app reloaded it.
function switchesToArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split('\n');
}

function switchesToText(value: string[] | null | undefined): string | null {
  if (!value || value.length === 0) {
    return null;
  }
  return value.join('\n') || null;
}

// ---- organizations ------------------------------------------------------

export function rowToOrg(row: OrganizationRow): ScoutOrg {
  return {
    id: row.id,
    name: row.name,
    plan: row.plan,
    profile_limit: row.profile_limit,
    seat_limit: row.seat_limit,
    billing_status: row.billing_status,
    current_period_end: row.current_period_end,
    built_in_extensions: row.built_in_extensions || undefined,
    // `?? 0`, not `?? null`: null means unlimited, and a row read back from a
    // database that has not had the migration applied would otherwise hand
    // every org an unlimited automation allowance.
    automation_limit: row.automation_limit ?? 0,
    // Passed through as-is, unlike the limit above. Null here means "not
    // answered", which is a real state the setup prompt keys on -- collapsing it
    // to a default would make an un-onboarded workspace look onboarded.
    //
    // org_type is narrowed rather than cast: the column has a CHECK constraint,
    // but this build could be talking to a database where it does not yet, and
    // an unrecognised value should read as unanswered rather than render as
    // itself in a sentence that says "You work as a ___".
    org_type: row.org_type === 'solo' || row.org_type === 'business' ? row.org_type : null,
    legal_name: row.legal_name,
    country: row.country,
    website: row.website,
    logo_url: row.logo_url,
    onboarded_at: row.onboarded_at,
    telegram_bot_token: row.telegram_bot_token ?? null,
    telegram_bot_name: row.telegram_bot_name ?? null,
  };
}

// ---- profiles -----------------------------------------------------------

export function rowToProfile(row: ProfileRow): ScoutProfile {
  const fingerprint = row.fingerprint && Object.keys(row.fingerprint).length > 0 ?
    row.fingerprint as ScoutProfile['fingerprint'] :
    undefined;
  return {
    id: row.id,
    name: row.name,
    status: undef(row.status),
    color: undef(row.color),
    avatar: undef(row.avatar),
    tags: undef(row.tags),
    email: undef(row.email),
    password: undef(row.password),
    login_url: undef(row.login_url),
    folder_id: row.folder_id,
    proxy_id: row.proxy_id,
    proxy_mode: undef(row.proxy_mode) as ProxyMode | undefined,
    start_url: row.start_urls?.[0] ?? null,
    cookie_import_path: row.cookie_import_path,
    cookie_import_url: row.cookie_import_url,
    cookie_import_name: row.cookie_import_name,
    cookie_import_count: row.cookie_import_count,
    cookie_mode: undef(row.cookie_mode) as ScoutProfile['cookie_mode'],
    cookie_id: row.cookie_set_id,
    automation_id: row.automation_id,
    automation_vars: normalizeProfileVars(row.automation_vars),
    command_line_switches: switchesToText(row.command_line_switches),
    fingerprint,
    created_at: undef(row.created_at),
    created_by: row.created_by,
    assigned_to: row.assigned_to,
    deleted_at: row.deleted_at,
  };
}

// Full-row payload for an upsert.
//
// `deleted_at` is deliberately NOT included. Trash membership is owned by
// softDelete/restore/purge alone, so an ordinary edit -- from a session that
// has not noticed someone else trashed this profile -- cannot bring it back.
// That is verification check 3 of prompt 05 in one omitted line.
//
// `created_by` is omitted for a related reason, and it matters twice. On insert
// the column's DEFAULT auth.uid() fills it, which is the only version of it
// that cannot be forged. On update -- `replace` sends every key of this object
// -- omitting it is what stops a colleague's edit from rewriting authorship to
// themselves.
//
// `assigned_to` is omitted on exactly the same grounds. It is owned by
// accept_handoff and set_assignee, so an ordinary edit -- by anyone, from a
// session that may not have seen the hand-off at all -- must not carry a stale
// value back over it and silently unassign the row.
//
// `updated_at` is set here because no trigger maintains it: 0001/0005 give the
// column a default but nothing refreshes it on update.
export function profileToRow(orgId: string, profile: ScoutProfile): Insert<ProfileRow> {
  const startUrl = profile.start_url?.trim();
  return {
    id: profile.id,
    org_id: orgId,
    name: profile.name,
    folder_id: profile.folder_id ?? null,
    proxy_id: profile.proxy_id ?? null,
    cookie_set_id: profile.cookie_id ?? null,
    automation_id: profile.automation_id ?? null,
    automation_vars: profile.automation_vars ?? {},
    fingerprint: (profile.fingerprint || {}) as Record<string, unknown>,
    status: profile.status ?? null,
    tags: profile.tags ?? [],
    email: profile.email ?? null,
    password: profile.password ?? null,
    login_url: profile.login_url ?? null,
    start_urls: startUrl ? [startUrl] : [],
    command_line_switches: switchesToArray(profile.command_line_switches),
    color: profile.color ?? null,
    avatar: profile.avatar ?? null,
    proxy_mode: profile.proxy_mode ?? null,
    cookie_mode: profile.cookie_mode ?? null,
    cookie_import_path: profile.cookie_import_path ?? null,
    cookie_import_url: profile.cookie_import_url ?? null,
    cookie_import_name: profile.cookie_import_name ?? null,
    cookie_import_count: profile.cookie_import_count ?? null,
    created_at: profile.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// Partial patch for an update -- only the keys present in `patch` are sent, so
// two workers editing different fields of the same profile do not overwrite
// each other's untouched columns.
export function profilePatchToRow(patch: Partial<ScoutProfile>): Partial<ProfileRow> {
  const row: Partial<ProfileRow> = {updated_at: new Date().toISOString()};
  if ('name' in patch) {
    row.name = patch.name as string;
  }
  if ('status' in patch) {
    row.status = patch.status ?? null;
  }
  if ('color' in patch) {
    row.color = patch.color ?? null;
  }
  if ('avatar' in patch) {
    row.avatar = patch.avatar ?? null;
  }
  if ('tags' in patch) {
    row.tags = patch.tags ?? [];
  }
  if ('email' in patch) {
    row.email = patch.email ?? null;
  }
  if ('password' in patch) {
    row.password = patch.password ?? null;
  }
  if ('login_url' in patch) {
    row.login_url = patch.login_url ?? null;
  }
  if ('folder_id' in patch) {
    row.folder_id = patch.folder_id ?? null;
  }
  if ('proxy_id' in patch) {
    row.proxy_id = patch.proxy_id ?? null;
  }
  if ('proxy_mode' in patch) {
    row.proxy_mode = patch.proxy_mode ?? null;
  }
  if ('start_url' in patch) {
    const startUrl = patch.start_url?.trim();
    row.start_urls = startUrl ? [startUrl] : [];
  }
  if ('automation_id' in patch) {
    row.automation_id = patch.automation_id ?? null;
  }
  if ('automation_vars' in patch) {
    row.automation_vars = patch.automation_vars ?? {};
  }
  if ('cookie_id' in patch) {
    row.cookie_set_id = patch.cookie_id ?? null;
  }
  if ('cookie_mode' in patch) {
    row.cookie_mode = patch.cookie_mode ?? null;
  }
  if ('cookie_import_path' in patch) {
    row.cookie_import_path = patch.cookie_import_path ?? null;
  }
  if ('cookie_import_url' in patch) {
    row.cookie_import_url = patch.cookie_import_url ?? null;
  }
  if ('cookie_import_name' in patch) {
    row.cookie_import_name = patch.cookie_import_name ?? null;
  }
  if ('cookie_import_count' in patch) {
    row.cookie_import_count = patch.cookie_import_count ?? null;
  }
  if ('command_line_switches' in patch) {
    row.command_line_switches = switchesToArray(patch.command_line_switches);
  }
  if ('fingerprint' in patch) {
    row.fingerprint = (patch.fingerprint || {}) as Record<string, unknown>;
  }
  if ('deleted_at' in patch) {
    row.deleted_at = patch.deleted_at ?? null;
  }
  return row;
}

// ---- profile notes ------------------------------------------------------

// author_kind is narrowed here rather than trusted. The check constraint means
// the database cannot hold a third value, but this row also arrives from a
// PostgREST response typed as `unknown`, and defaulting to 'user' on anything
// unrecognised is the safe direction: a note that renders as a person's when it
// should have said agent is a display bug, where the reverse would hand an
// edit button for an agent's note to whoever is signed in.
function noteAuthorKind(value: string): NoteAuthorKind {
  return value === 'agent' ? 'agent' : 'user';
}

export function rowToProfileNote(row: ProfileNoteRow): ProfileNote {
  return {
    id: row.id,
    profile_id: row.profile_id,
    body: row.body,
    author_kind: noteAuthorKind(row.author_kind),
    created_by: row.created_by,
    author_label: row.author_label,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function rowToProfileNoteSummary(row: ProfileNoteSummaryRow): ProfileNoteSummary {
  return {
    profile_id: row.profile_id,
    // count(*) comes back as a bigint, which PostgREST serialises as a JSON
    // number here but has been known to send as a string on other drivers.
    note_count: Number(row.note_count) || 0,
    last_id: row.last_id,
    last_body: row.last_body,
    last_author_kind: noteAuthorKind(row.last_author_kind),
    last_created_by: row.last_created_by,
    last_author_label: row.last_author_label,
    last_created_at: row.last_created_at,
  };
}

// ---- proxies ------------------------------------------------------------

export function rowToProxy(row: ProxyRow): ScoutProxy {
  return {
    id: row.id,
    name: row.name || '',
    status: undef(row.status),
    type: undef(row.type) as ScoutProxy['type'],
    host: row.host || '',
    port: row.port || 0,
    username: undef(row.username),
    password: undef(row.password),
    folder_id: row.folder_id,
    country: undef(row.last_country),
    country_code: undef(row.last_country_code),
    timezone: undef(row.last_timezone),
    city: undef(row.last_city),
    region: undef(row.last_region),
    latitude: undef(row.last_latitude),
    longitude: undef(row.last_longitude),
    egress_ip: undef(row.last_ip),
    ping_ms: undef(row.last_latency_ms),
    checked_at: undef(row.last_checked_at),
    check_error: undef(row.last_error),
    assigned_to: row.assigned_to,
    // Both only ever read. The select has carried created_at since the table
    // existed; nothing mapped it until the arrivals marker needed to know when
    // a proxy showed up. See newSince.ts.
    created_at: undef(row.created_at),
    created_by: row.created_by,
  };
}

// `created_at` and `created_by` are deliberately NOT included, on the same
// grounds as profileToRow above -- and it matters more here, because this is
// the app's one true upsert: `save` sends every key of this object on the
// update path too. created_by keeps its DB default, auth.uid(), so a
// colleague's edit cannot rewrite authorship to themselves, and created_at
// keeps the moment the proxy actually arrived.
export function proxyToRow(orgId: string, proxy: ScoutProxy): Insert<ProxyRow> {
  return {
    id: proxy.id,
    org_id: orgId,
    name: proxy.name || null,
    status: proxy.status ?? null,
    type: proxy.type ?? null,
    host: proxy.host || null,
    port: proxy.port || null,
    username: proxy.username ?? null,
    password: proxy.password ?? null,
    folder_id: proxy.folder_id ?? null,
    last_checked_at: proxy.checked_at ?? null,
    last_ip: proxy.egress_ip ?? null,
    last_country: proxy.country ?? null,
    last_country_code: proxy.country_code ?? null,
    last_timezone: proxy.timezone ?? null,
    last_city: proxy.city ?? null,
    last_region: proxy.region ?? null,
    last_latitude: proxy.latitude ?? null,
    last_longitude: proxy.longitude ?? null,
    last_latency_ms: proxy.ping_ms ?? null,
    last_error: proxy.check_error ?? null,
  };
}

// ---- folders ------------------------------------------------------------

export function rowToFolder(row: FolderRow): ScoutFolder {
  return {
    id: row.id,
    name: row.name || '',
    // Anything that names no library is the profile one, so a row written
    // before the column existed reads as what it always was. Listed positively
    // rather than as "not proxy" so a fourth kind cannot silently land in the
    // profiles rail.
    kind: row.kind === 'proxy' ? 'proxy' : row.kind === 'cookie' ? 'cookie' : 'profile',
    icon: undef(row.icon),
    color: undef(row.color),
    created_at: undef(row.created_at),
  };
}

// ---- cookie sets --------------------------------------------------------

export function rowToCookie(row: CookieSetRow): ScoutCookie {
  return {
    id: row.id,
    name: row.name || '',
    url: row.source_url || '',
    count: row.count,
    status: undef(row.status),
    color: undef(row.color),
    folder_id: row.folder_id,
    tags: row.tags ?? [],
    created_at: undef(row.created_at),
    updated_at: undef(row.updated_at),
    assigned_to: row.assigned_to,
    deleted_at: row.deleted_at,
    // Read only, and absent from cookieToRow below for the reason profileToRow
    // gives: the column's DEFAULT auth.uid() is the only authorship that cannot
    // be forged. See newSince.ts for what reads it.
    created_by: row.created_by,
  };
}

// The full row for an insert. `deleted_at` is deliberately absent, for exactly
// the reason profileToRow omits it: Trash membership belongs to softDelete /
// restore / purge alone, and a create path that could set it would be a way to
// insert a row nobody can find.
//
// `cookies` is not here either -- the payload is passed separately by
// cookieSets.create, because it is the one column large enough that a caller
// should have to mean it.
export function cookieToRow(orgId: string, cookie: ScoutCookie): Insert<CookieSetRow> {
  return {
    id: cookie.id,
    org_id: orgId,
    name: cookie.name || null,
    source_url: cookie.url || null,
    count: cookie.count ?? null,
    // Carried rather than dropped so `duplicate` -- which spreads the whole set
    // and inserts it -- keeps the mark the user put on the original. A genuinely
    // new set has neither field set, so both land as null and it starts
    // unmarked.
    status: cookie.status ?? null,
    color: cookie.color ?? null,
    folder_id: cookie.folder_id ?? null,
    tags: cookie.tags ?? [],
    updated_at: new Date().toISOString(),
  };
}

// Only the keys actually present are sent, so two workers renaming and
// re-filing the same set cannot clobber each other's field. updated_at is
// stamped on every patch: no trigger maintains it.
export function cookiePatchToRow(patch: Partial<ScoutCookie>): Partial<CookieSetRow> {
  const row: Partial<CookieSetRow> = {updated_at: new Date().toISOString()};
  if ('name' in patch) {
    row.name = patch.name ?? null;
  }
  if ('url' in patch) {
    row.source_url = patch.url || null;
  }
  if ('count' in patch) {
    row.count = patch.count ?? null;
  }
  if ('folder_id' in patch) {
    row.folder_id = patch.folder_id ?? null;
  }
  if ('tags' in patch) {
    row.tags = patch.tags ?? [];
  }
  if ('status' in patch) {
    row.status = patch.status ?? null;
  }
  if ('color' in patch) {
    row.color = patch.color ?? null;
  }
  if ('deleted_at' in patch) {
    row.deleted_at = patch.deleted_at ?? null;
  }
  return row;
}

// ---- shared extensions --------------------------------------------------

export function rowToExtension(row: SharedExtensionRow): SharedExtension {
  return {
    id: row.id,
    name: undef(row.name),
    source: row.source === 'webstore' ? 'webstore' : 'local',
    webstoreId: undef(row.webstore_id),
    storageUrl: undef(row.storage_url),
    // null (column missing before the migration, or never written) reads as
    // enabled, matching SharedExtension.enabled's documented convention.
    enabled: row.enabled ?? undefined,
  };
}

export function extensionToRow(
    orgId: string, extension: SharedExtension,
    storagePath?: string | null): Insert<SharedExtensionRow> {
  const row: Insert<SharedExtensionRow> = {
    id: extension.id,
    org_id: orgId,
    name: extension.name ?? null,
    source: extension.source,
    webstore_id: extension.webstoreId ?? null,
    storage_url: extension.storageUrl ?? null,
    enabled: extension.enabled !== false,
  };
  // Only written on upload: it is the object key a future cleanup pass needs to
  // delete the zip from the bucket. Omitted on a plain row edit so an upsert
  // never blanks it.
  if (storagePath !== undefined) {
    row.storage_path = storagePath;
  }
  return row;
}

// ---- shared bookmarks ---------------------------------------------------

export function rowToBookmark(row: SharedBookmarkRow): SharedBookmark {
  return {
    id: row.id,
    title: row.title || '',
    url: row.url || '',
    icon: undef(row.icon),
    position: undef(row.position),
  };
}

// ---- custom statuses ----------------------------------------------------

// The app models custom statuses as a plain string[]; the table stores one row
// per label (with an unused `color`). The label is the string.
export function rowToStatus(row: CustomStatusRow): string {
  return row.label || '';
}

// ---- automations --------------------------------------------------------
//
// Near-identity, on purpose. The renames at the top of this file are historical
// -- src/types.ts predates the schema -- and the automations tables were named
// to match the app type precisely so no new ones were needed. Everything below
// only coerces null to undefined and fills defaults for a row written before a
// column existed.

// config is guarded back to an object even though the table has a CHECK
// constraint saying it is one: a row read through a future view or a cast
// that loses the guarantee must deserialise into "no fields set", not crash
// whatever reads a field off null.
export function rowToConnector(row: ConnectorRow): ScoutConnector {
  const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ?
    row.config : {};
  return {
    id: row.id,
    name: row.name,
    category: row.category === 'message' ? 'message' : 'ai',
    kind: row.kind,
    config: Object.fromEntries(Object.entries(config)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => [key, String(value)])),
    is_default: row.is_default ?? false,
    created_at: undef(row.created_at),
    updated_at: undef(row.updated_at),
  };
}

// Blank config values are dropped rather than written through. An empty
// base_url means "use the preset's endpoint", and '' is not that -- it would
// resolve to a request against the empty URL. Same for a blank api_key.
export function connectorToRow(
    orgId: string, connector: ScoutConnector): Insert<ConnectorRow> {
  return {
    id: connector.id,
    org_id: orgId,
    name: connector.name.trim(),
    category: connector.category,
    kind: connector.kind,
    config: Object.fromEntries(Object.entries(connector.config || {})
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value !== '')),
    is_default: connector.is_default ?? false,
    created_at: connector.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function rowToAutomation(row: AutomationRow): ScoutAutomation {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    steps: (row.steps || []) as AutomationStep[],
    variables: (row.variables || {}) as AutomationVars,
    parameters: normalizeParams(row.parameters),
    tags: row.tags || [],
    pinned: row.pinned ?? false,
    timeout_ms: row.timeout_ms ?? undefined,
    close_on_finish: row.close_on_finish ?? false,
    // Null-preserving on purpose: a row written before these columns existed
    // must map to "does not notify", not to a default that starts sending.
    notify_connector_id: row.notify_connector_id ?? null,
    notify_on: row.notify_on === 'always' || row.notify_on === 'failure' ?
      row.notify_on : null,
    icon: row.icon ?? null,
    color: row.color ?? null,
    folder_id: row.folder_id ?? null,
    deleted_at: row.deleted_at ?? null,
    last_run_at: row.last_run_at ?? null,
    last_run_status: isRunStatus(row.last_run_status) ? row.last_run_status : null,
    created_by: row.created_by ?? null,
    created_via: row.created_via === 'mcp' ? 'mcp' : 'user',
    created_by_label: row.created_by_label ?? null,
    updated_by: row.updated_by ?? null,
    schedule: normalizeSchedule(row.schedule),
    created_at: undef(row.created_at),
    updated_at: undef(row.updated_at),
    assigned_to: row.assigned_to,
  };
}

// `updated_at` is set here for the same reason profileToRow sets it: no trigger
// maintains it, so a save that did not touch it would leave the column at
// whatever the insert default wrote.
export function automationToRow(
    orgId: string, automation: ScoutAutomation): Insert<AutomationRow> {
  return {
    id: automation.id,
    org_id: orgId,
    name: automation.name,
    description: automation.description ?? null,
    steps: automation.steps as unknown[],
    variables: (automation.variables || {}) as Record<string, unknown>,
    parameters: (automation.parameters || []) as unknown[],
    // normalizeTags is the only enforcement point for the 5-tag cap and it is
    // applied at the edges, exactly as it is for profiles -- see AGENTS.md.
    tags: normalizeTags(automation.tags || []),
    pinned: automation.pinned ?? false,
    timeout_ms: automation.timeout_ms ?? 300000,
    close_on_finish: automation.close_on_finish ?? false,
    notify_connector_id: automation.notify_connector_id ?? null,
    notify_on: automation.notify_on ?? null,
    icon: automation.icon ?? null,
    color: automation.color ?? null,
    folder_id: automation.folder_id ?? null,
    // deleted_at is absent on purpose. replace() writes every editable column,
    // and Trash is not one of them -- softDelete and restore own that field.
    // Writing it here would let an ordinary editor save on a trashed row
    // silently restore it, bypassing trg_automation_limit_restore.
    // created_via/created_by_label are set on create and then never rewritten:
    // replace() runs on every editor save, and a human's save must not adopt
    // an agent's automation (or the reverse). created_by keeps its DB default,
    // auth.uid(); last_run_* belong to recordRunOutcome alone; updated_by is
    // the trigger's.
    ...(automation.created_via ? {created_via: automation.created_via} : {}),
    ...(automation.created_by_label ? {created_by_label: automation.created_by_label} : {}),
    schedule: (automation.schedule as Record<string, unknown> | null) ?? null,
    created_at: automation.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function automationPatchToRow(
    patch: Partial<ScoutAutomation>): Partial<AutomationRow> {
  const row: Partial<AutomationRow> = {updated_at: new Date().toISOString()};
  if ('name' in patch) {
    row.name = patch.name as string;
  }
  if ('description' in patch) {
    row.description = patch.description ?? null;
  }
  if ('steps' in patch) {
    row.steps = (patch.steps || []) as unknown[];
  }
  if ('variables' in patch) {
    row.variables = (patch.variables || {}) as Record<string, unknown>;
  }
  if ('parameters' in patch) {
    row.parameters = (patch.parameters || []) as unknown[];
  }
  if ('tags' in patch) {
    row.tags = normalizeTags(patch.tags || []);
  }
  if ('pinned' in patch) {
    row.pinned = patch.pinned ?? false;
  }
  if ('timeout_ms' in patch) {
    row.timeout_ms = patch.timeout_ms ?? 300000;
  }
  if ('close_on_finish' in patch) {
    row.close_on_finish = patch.close_on_finish ?? false;
  }
  if ('notify_connector_id' in patch) {
    row.notify_connector_id = patch.notify_connector_id ?? null;
  }
  if ('notify_on' in patch) {
    row.notify_on = patch.notify_on ?? null;
  }
  if ('icon' in patch) {
    row.icon = patch.icon ?? null;
  }
  if ('color' in patch) {
    row.color = patch.color ?? null;
  }
  if ('folder_id' in patch) {
    row.folder_id = patch.folder_id ?? null;
  }
  if ('schedule' in patch) {
    row.schedule = (patch.schedule as Record<string, unknown> | null) ?? null;
  }
  // created_via, created_by_label, last_run_* and updated_by are deliberately
  // not patchable: attribution is set once at create, the run verdict belongs
  // to recordRunOutcome, and updated_by to the DB trigger.
  return row;
}

// ---- automation runs ----------------------------------------------------

export function rowToRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automation_id: row.automation_id,
    automation_name: row.automation_name || '',
    profile_id: row.profile_id,
    profile_name: row.profile_name || '',
    trigger: (row.trigger || 'manual') as RunTrigger,
    status: (row.status || 'running') as RunStatus,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    step_count: row.step_count ?? 0,
    failed_step_id: row.failed_step_id,
    error: row.error,
    vars: (row.vars || {}) as AutomationVars,
    log: (row.log || []) as RunLogEntry[],
  };
}

export function runToRow(orgId: string, run: AutomationRun): Insert<AutomationRunRow> {
  return {
    id: run.id,
    org_id: orgId,
    automation_id: run.automation_id ?? null,
    automation_name: run.automation_name || '',
    profile_id: run.profile_id ?? null,
    profile_name: run.profile_name || '',
    trigger: run.trigger,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at ?? null,
    duration_ms: run.duration_ms ?? null,
    step_count: run.step_count ?? 0,
    failed_step_id: run.failed_step_id ?? null,
    error: run.error ?? null,
    vars: (run.vars || {}) as Record<string, unknown>,
    log: (run.log || []) as unknown[],
  };
}

// ---- notifications ------------------------------------------------------

export function rowToNotification(row: NotificationRow): ScoutNotification {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    // Reported off the run record when the row was written, never recomputed
    // here -- the run record decided the verdict.
    status: row.status,
    automation_id: row.automation_id,
    run_id: row.run_id,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function notificationToRow(
    orgId: string, notification: ScoutNotification): Insert<NotificationRow> {
  return {
    id: notification.id,
    org_id: orgId,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    status: notification.status ?? null,
    automation_id: notification.automation_id ?? null,
    run_id: notification.run_id ?? null,
    created_at: notification.created_at || new Date().toISOString(),
  };
}

// ---- team ---------------------------------------------------------------

// Anything that is not 'owner' reads as 'member', the less privileged of the two.
//
// The column has a CHECK constraint so this should be unreachable, but the
// direction of the fallback is the point: if a future role is added and an old
// build reads it, showing that person as a member under-states what they can do
// rather than handing the UI's owner controls to someone this build cannot
// reason about. RLS decides either way; this only decides what is drawn.
//
// This is also what carries a database still holding 'admin' -- one that has not
// had 2026-08-10-owner-member-roles.sql run against it -- into the two-role UI
// without a crash: those people render, and act, as members.
function orgRole(value: string): OrgRole {
  return value === 'owner' ? 'owner' : 'member';
}

export function rowToMember(row: OrgMemberIdentityRow): OrgMember {
  return {
    user_id: row.user_id,
    email: row.email || '',
    display_name: row.display_name || '',
    avatar_url: row.avatar_url || '',
    role: orgRole(row.role),
    created_at: row.created_at,
    invited_by: row.invited_by,
  };
}

export function rowToInvite(row: OrgInviteRow): OrgInvite {
  return {
    id: row.id,
    email: row.email,
    // Always 'member'. The column's check constraint permits nothing else and
    // create_org_invite refuses anything else, so reading the row's own value
    // would only be a way to render a role that cannot be granted.
    role: 'member',
    status: row.status === 'accepted' || row.status === 'revoked' ? row.status : 'pending',
    token: row.token,
    expires_at: row.expires_at,
    created_at: row.created_at,
    invited_by: row.invited_by,
    last_emailed_at: row.last_emailed_at ?? null,
  };
}

// ---- handoffs ------------------------------------------------------------

// Both open text columns are narrowed here, so an unknown value from a newer
// server renders as the safe default rather than as a blank chip or an
// undefined branch. Same reasoning as orgRole above: the table's CHECK decides
// what is legal, this only decides what is drawn.
function handoffKind(value: string): HandoffKind {
  return value === 'proxy' || value === 'cookie_set' || value === 'automation' ?
    value : 'profile';
}

function handoffStatus(value: string): HandoffStatus {
  return value === 'accepted' || value === 'declined' || value === 'cancelled' ?
    value : 'pending';
}

export function rowToHandoff(row: HandoffRow): Handoff {
  return {
    id: row.id,
    kind: handoffKind(row.kind),
    status: handoffStatus(row.status),
    item_id: row.item_id,
    item_name: row.item_name || 'Untitled',
    from_user: row.from_user,
    to_user: row.to_user,
    note: row.note || '',
    created_at: row.created_at,
  };
}

// ---- built-in extension toggles -----------------------------------------

export function toggles(value: unknown): BuiltInExtensionToggles | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as BuiltInExtensionToggles;
}
