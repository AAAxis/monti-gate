// Hand-written row shapes for the tables prompt 03 created. They stay
// hand-written because they carry refinements the generator cannot infer --
// BuiltInExtensionToggles rather than Json, and the comments explaining why a
// given column is nullable.
//
// They are no longer unchecked, though. `database.types.ts` is generated from
// the live schema, and `rows.schema-check.ts` asserts at typecheck time that
// every column named here still exists. Regenerate after any schema change:
//
//   supabase gen types typescript --linked --schema public > src/db/database.types.ts
//
// Modelling fewer columns than the table has is safe. Naming one that is not
// there is not: PostgREST rejects the whole select, and the user sees an empty
// table rather than an error.
import type {BuiltInExtensionToggles} from '../types';

export type OrganizationRow = {
  id: string;
  name: string;
  plan: string;
  profile_limit: number | null;
  seat_limit: number;
  billing_status: string;
  current_period_end: string | null;
  created_at: string;
  built_in_extensions: BuiltInExtensionToggles | null;
  // How many automations this org may save; null is unlimited. Nullable here
  // for the same reason FolderRow.kind is -- a row read back before the
  // migration lands must map to something defined, and the client treats
  // null-or-missing as "no automations" rather than as unlimited.
  automation_limit: number | null;
  // Who the workspace belongs to (2026-08-08-org-profile.sql). All nullable:
  // every org that predates onboarding has nulls here and there is deliberately
  // no backfill, because inventing a country or a company for an existing
  // customer would be phantom data.
  //
  // Descriptive only. Nothing gates on these -- unlike the four columns above,
  // which the triggers enforce -- and they are writable by any member, because
  // the entitlement boundary is the column grant rather than the role.
  org_type: string | null;
  legal_name: string | null;
  country: string | null;
  website: string | null;
  logo_url: string | null;
  onboarded_at: string | null;
  // The workspace's notification bot (@BotFather-minted). Org-readable like
  // every connector credential; owner-writable via per-column grants.
  telegram_bot_token: string | null;
  telegram_bot_name: string | null;
};

export type OrgMemberRow = {
  org_id: string;
  user_id: string;
  role: string;
  created_at: string;
  // Who added them. Has existed since 0001 and was never written until
  // accept_org_invite started carrying it across from the invite.
  invited_by: string | null;
};

// What org_members_with_identity() returns -- NOT a table row.
//
// org_members holds ids and nothing else, and auth.users is not exposed to
// clients, so the roster comes from a SECURITY DEFINER function that joins the
// two server-side for orgs the caller belongs to. Added 2026-08-05-teams.sql.
export type OrgMemberIdentityRow = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  role: string;
  created_at: string;
  invited_by: string | null;
};

// Added 2026-08-05-teams.sql. The table existed before that but was unused and
// empty; the migration drops and recreates it, so this shape is the only one
// that has ever been read.
export type OrgInviteRow = {
  id: string;
  org_id: string;
  email: string;
  role: string;
  token: string;
  status: string;
  invited_by: string | null;
  accepted_by: string | null;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  // Null until the website has managed to email this invitation at least once.
  // The send route uses it as a 60-second floor; the Team tab uses it to decide
  // whether the owner still has to deliver the link by hand.
  last_emailed_at: string | null;
};

// An offer to take an item over. Read straight from the table with no RPC and
// no join: handoffs_select is is_org_member, and both parties are members of
// the same org, so the launcher resolves their names from CloudState.members
// rather than asking the server to join auth.users.
//
// Added 2026-08-06-handoffs.sql.
export type HandoffRow = {
  id: string;
  org_id: string;
  kind: string;
  item_id: string;
  item_name: string | null;
  from_user: string | null;
  to_user: string;
  note: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
};

// id is text, not uuid: a profile id is also its on-disk directory name under
// E:\ScoutProfiles\<id>, and 30 of the 44 legacy directories are plain numbers.
// 0005 widened it and added profiles_id_fs_safe to keep the name path-safe.
export type ProfileRow = {
  id: string;
  org_id: string;
  name: string;
  folder_id: string | null;
  proxy_id: string | null;
  cookie_set_id: string | null;
  fingerprint: Record<string, unknown>;
  status: string | null;
  tags: string[] | null;
  start_urls: string[] | null;
  command_line_switches: string[] | null;
  created_by: string | null;
  deleted_at: string | null;
  updated_at: string;
  created_at: string;
  color: string | null;
  proxy_mode: string | null;
  cookie_mode: string | null;
  cookie_import_path: string | null;
  cookie_import_url: string | null;
  cookie_import_name: string | null;
  cookie_import_count: number | null;
  // The login for whatever account the profile is signed into, plaintext -- the
  // same treatment proxies.password already gets. Added 2026-08-03; before that
  // the editor had both fields and the mappers silently dropped them.
  email: string | null;
  password: string | null;
  // The sign-in page those two belong to. Added 2026-08-09 (20260818000000);
  // null on every row written before then. Reference only -- nothing fills a
  // login form; see ScoutProfile.login_url.
  login_url: string | null;
  // The automation to run when this profile launches. Added 2026-08-05.
  automation_id: string | null;
  // This profile's parameter values, keyed by automation id:
  // {"flat-search": {"city_name": "Dortmund"}}. Not limited to automation_id --
  // a profile holds values for every parameterised automation it is run with,
  // however that run starts. Added 20260814000000_automation_parameters.sql.
  automation_vars: Record<string, Record<string, unknown>> | null;
  // The profile's picture: `brand:<slug>`, an https URL, or null for the
  // initials plate. Added 2026-08-05. See ScoutProfile.avatar in src/types.ts.
  avatar: string | null;
  // Who is on the hook for it. Added 2026-08-06-handoffs.sql. Nullable on every
  // table that has it -- unclaimed is the default and the common case.
  assigned_to: string | null;
};

// One entry in a profile's note thread. Added 20260807000000_profile_notes.sql,
// which also drops the dead scalar `profiles.notes` this replaces.
export type ProfileNoteRow = {
  id: string;
  org_id: string;
  // text, matching ProfileRow.id above.
  profile_id: string;
  body: string;
  // 'user' | 'agent'. Kept as a plain string here for the same reason every
  // other enumerated column is: the check constraint is what enforces it, and a
  // narrower type here would only mean a cast at the boundary.
  author_kind: string;
  // The session the note was written THROUGH, which is not the same as who said
  // it -- an API or MCP write carries the uid of whichever human had the
  // launcher open. author_kind is what tells the two apart. The migration's
  // comment has the full reasoning.
  created_by: string | null;
  // The API key's name, on agent rows only. Null for anything a person wrote.
  author_label: string | null;
  created_at: string;
  updated_at: string;
};

// The profile_note_summaries view: one row per profile that has any notes,
// carrying the newest one and the count. What the table's Notes column reads,
// so a page of 25 rows costs one query rather than 25.
export type ProfileNoteSummaryRow = {
  profile_id: string;
  org_id: string;
  note_count: number;
  last_id: string;
  last_body: string;
  last_author_kind: string;
  last_created_by: string | null;
  last_author_label: string | null;
  last_created_at: string;
};

export type ProxyRow = {
  id: string;
  org_id: string;
  name: string | null;
  // See 20260810000000_proxy_cookie_statuses.sql. Free text, null for every row
  // written before the column existed -- which reads as baseProxyStatuses[0].
  status: string | null;
  type: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null;
  folder_id: string | null;
  last_checked_at: string | null;
  last_ip: string | null;
  last_country: string | null;
  last_latency_ms: number | null;
  created_at: string;
  last_country_code: string | null;
  last_error: string | null;
  // Where the last check saw this proxy exit, at city granularity. The timezone
  // is the load-bearing one: it decides what every launched profile reports, and
  // resolving it from last_country_code alone put every US proxy in New York.
  // See 20260809000000_proxy_ip_geolocation.sql.
  last_timezone: string | null;
  last_city: string | null;
  last_region: string | null;
  last_latitude: number | null;
  last_longitude: number | null;
  assigned_to: string | null;
  // Who added it. Null for every row written before
  // 20260815000000_created_by_attribution.sql, and null forever if they later
  // leave the workspace -- the FK is ON DELETE SET NULL. Both cases read as
  // "no known author", which arrivalsSince treats as not-new.
  created_by: string | null;
};

export type FolderRow = {
  id: string;
  org_id: string;
  name: string | null;
  parent_id: string | null;
  created_at: string;
  icon: string | null;
  color: string | null;
  // 'profile' or 'proxy'. Not null in the database (default 'profile'), but
  // typed nullable here so a row read back before the migration lands maps to
  // a profile folder rather than to undefined behaviour.
  kind: string | null;
};

// `cookies` holds the cookie payload itself and is unused by the launcher
// today -- the app stores a Storage URL in source_url, exactly as the blob did.
// Prompt 06 is what starts filling `cookies`.
export type CookieSetRow = {
  id: string;
  org_id: string;
  name: string | null;
  // The parsed cookie array. '[]' for every row written before the inspector
  // existed, backfilled lazily the first time such a set is opened. Never in
  // cookieSets.list()'s column list -- see COLUMNS there for why.
  cookies: unknown[];
  updated_at: string;
  created_at: string;
  // Where a launch actually reads the payload from. electron/main.cjs fetches
  // this URL and has no Supabase credentials, so `cookies` above is a read
  // cache and this is the source of truth. Every write updates both.
  source_url: string | null;
  count: number | null;
  folder_id: string | null;
  // The column is NOT NULL default '{}', but typed nullable here for the same
  // reason FolderRow.kind is: a row read back before the migration lands maps
  // to an empty tag list rather than to undefined behaviour.
  tags: string[] | null;
  deleted_at: string | null;
  assigned_to: string | null;
  // Both from 20260810000000_proxy_cookie_statuses.sql, both null for every row
  // written before it: `status` reads as baseCookieStatuses[0] and `color`
  // falls back to the folder's tint.
  status: string | null;
  color: string | null;
  // Who added it. Same shape and same reasoning as ProxyRow.created_by.
  created_by: string | null;
};

// Primary key is (org_id, id), not (id): addExtensionFromWebStoreLink uses the
// Web Store id as the row id, so two orgs sharing one extension share its id.
export type SharedExtensionRow = {
  id: string;
  org_id: string;
  name: string | null;
  source: string | null;
  storage_path: string | null;
  created_at: string;
  webstore_id: string | null;
  storage_url: string | null;
  // Nullable for the same reason FolderRow.tags is: a row read back before the
  // migration lands maps to "enabled", not to undefined behaviour.
  enabled: boolean | null;
};

export type SharedBookmarkRow = {
  id: string;
  org_id: string;
  title: string | null;
  url: string | null;
  position: number | null;
  icon: string | null;
};

export type CustomStatusRow = {
  id: string;
  org_id: string;
  label: string | null;
  color: string | null;
};

// A saved workflow. `steps` and `variables` are jsonb; they come back already
// parsed, so they are typed as what they hold rather than as string.
//
// Unlike the tables above, nothing here is renamed on the way through
// mappers.ts -- these columns were named to match the app type, so the mapper
// is a near-identity that only coerces null to undefined. The renames that do
// exist elsewhere are historical (src/types.ts predates the schema); do not add
// new ones.
export type AutomationRow = {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  steps: unknown[];
  variables: Record<string, unknown> | null;
  // The declared inputs, an ordered list of AutomationParam. Order is the form
  // order, which is why it is an array. `variables` above stays the untyped
  // seed bag MCP has always accepted; a declared parameter of the same name
  // shadows its entry (resolveRunVars).
  parameters: unknown[] | null;
  tags: string[] | null;
  pinned: boolean | null;
  timeout_ms: number | null;
  close_on_finish: boolean | null;
  // "Tell me when this finishes." notify_on is 'always' | 'failure' | null,
  // null meaning the automation does not notify. notify_connector_id names a
  // message connector, or null for delivery to Scout Web alone (the bell and a
  // desktop notification); deliberately no FK -- see the migration.
  notify_connector_id: string | null;
  notify_on: string | null;
  // Card identity: 'brand:<slug>' (the profile-avatar grammar) or null for the
  // default workflow glyph; a ProfileColorKey or '#rrggbb' tinting its plate,
  // or the card's frame where a brand mark leaves no plate to tint.
  icon: string | null;
  color: string | null;
  // The automation folder this is filed in. Shares the `folders` table with
  // profiles, proxies and cookie sets, separated by folders.kind.
  folder_id: string | null;
  // Set while in Trash, cleared on restore. 20260817.
  deleted_at: string | null;
  // Denormalized verdict of the newest finished run -- reported by
  // recordRunOutcome, never recomputed. automation_runs holds the truth.
  last_run_at: string | null;
  last_run_status: string | null;
  created_by: string | null;
  // 'user' | 'mcp'. created_by_label names the agent for the mcp case, where
  // created_by is just whichever human's launcher answered the request.
  created_via: string | null;
  created_by_label: string | null;
  // Who last saved -- maintained by a DB trigger, not the mappers.
  updated_by: string | null;
  // The schedule document, shaped and validated by src/automations/schedule.ts.
  schedule: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  assigned_to: string | null;
};

// One per-user star. Insert/delete only -- see the migration for why this is
// not a starred_by[] array on automations.
export type AutomationStarRow = {
  org_id: string;
  automation_id: string;
  user_id: string;
  starred_at: string;
};

// "I, personally, want a Telegram message about this automation." Independent
// of automations.notify_on, which is the org-connector path.
export type AutomationTelegramPrefRow = {
  org_id: string;
  automation_id: string;
  user_id: string;
  notify_on: string;
};

// The signed-in user's own Telegram link. chat_id is written only by the
// landing backend; the launcher reads its own row to learn "linked or not".
export type UserTelegramRow = {
  user_id: string;
  chat_id: string;
  telegram_username: string | null;
  linked_at: string;
};

// An outside service automations talk to: an AI endpoint or a messaging
// target, told apart by `category`. Org-scoped, owner-writable, member-
// readable -- `config` (credentials included) selected in full, which is what
// lets a teammate run a shared workflow. See
// supabase/migrations/20260805201923_connectors.sql.
export type ConnectorRow = {
  id: string;
  org_id: string;
  name: string;
  category: string;
  kind: string;
  config: Record<string, unknown> | null;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// One "a run finished" row for the whole org -- the bell's second kind, next
// to handoffs. `status` is copied off the run record, never recomputed.
export type NotificationRow = {
  id: string;
  org_id: string;
  kind: string;
  title: string;
  body: string;
  status: string | null;
  automation_id: string | null;
  run_id: string | null;
  created_by: string | null;
  created_at: string;
};

// Per-user read state for the table above, insert-only -- a row per
// (notification, person) rather than an array column, so marking one read is
// an insert that cannot lose a concurrent one.
export type NotificationReadRow = {
  notification_id: string;
  user_id: string;
  read_at: string;
};

// One execution. Inserted when the run starts and updated when it ends, so an
// interrupted run leaves a `running` row rather than no row at all.
export type AutomationRunRow = {
  id: string;
  org_id: string;
  automation_id: string | null;
  automation_name: string;
  profile_id: string | null;
  profile_name: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  step_count: number;
  failed_step_id: string | null;
  error: string | null;
  vars: Record<string, unknown> | null;
  log: unknown[];
};
