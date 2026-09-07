import type {AutomationParam, ProfileAutomationVars} from './automations/parameters';
import type {AutomationSchedule} from './automations/schedule';
import type {
  AutomationStep,
  AutomationVars,
  RunLogEntry,
  RunStatus,
  RunTrigger,
} from './automations/types';

// Mirrors monti::Fingerprint's JSON dict keys (chrome/browser/monti/
// monti_fingerprint.cc ToDict/FromDict) so it can be dropped straight into
// --monti-fingerprint-json for the browser to apply verbatim. timezone,
// languages, latitude, and longitude are left undefined when the profile is
// set to derive them from the assigned proxy's country -- electron/main.cjs
// fills those in (reusing its existing COUNTRY_DEFAULTS resolution) right
// before the payload is serialized, so that logic stays in exactly one place.
export type RuntimeFingerprint = {
  platform?: string;
  ua_string?: string;
  preset?: string;
  // Sec-CH-UA-Platform-Version. Separate from `preset` because Windows 10 and
  // Windows 11 collapse to the same preset and the same UA string, and this
  // hint is the only thing that distinguishes them. See platformVersionFor()
  // in lib/fingerprint.ts and Fingerprint::platform_version browser-side.
  platform_version?: string;
  seed: number;
  webrtc_mode?: string;
  canvas_mode?: string;
  webgl_mode?: string;
  webgpu_mode?: string;
  client_rects_mode?: string;
  audio_mode?: string;
  webgl_vendor?: string;
  webgl_renderer?: string;
  timezone?: string;
  languages?: string[];
  geolocation_mode?: string;
  latitude?: number;
  longitude?: number;
  cpu_cores?: number;
  memory_gb?: number;
  // Mobile signals, derived from the platform in buildRuntimeFingerprint()
  // rather than edited directly, same as webrtc_mode/canvas_mode.
  //
  // NOT CONSUMED BY THE BROWSER TODAY. This comment used to claim there were
  // "matching Fingerprint::touch_points/sensor_mode/battery_* fields" in
  // chrome/browser/monti/monti_fingerprint.h; there are not, and FromDict has
  // never read these keys, so everything below is serialized into the launch
  // payload and silently dropped on arrival. navigator.maxTouchPoints is
  // therefore unspoofed -- an "Android" profile reports 0, which no real phone
  // does.
  //
  // Kept rather than deleted because the mobile presets need them and the
  // browser-side half is queued; they are inert until it lands. Anyone
  // debugging why a touch spoof "does nothing" should start here.
  touch_points?: number;
  sensor_mode?: string;
  battery_spoof?: boolean;
  battery_level?: number;
  battery_charging?: boolean;
  screen?: string;
  media_devices?: string;
  ports_to_protect?: string;
  do_not_track?: boolean;
  rotate_on_launch?: boolean;
};

// How this profile connects: 'assigned' requires a real proxy_id (the
// existing, default behavior); 'direct' explicitly opts out of any proxy
// (no fallback extension either); 'free_proxy' explicitly opts into the
// bundled FoxyWall Proxy extension as a fallback. Undefined means 'assigned'
// for backward compatibility with profiles saved before this field existed.
export type ProxyMode = 'assigned' | 'direct' | 'free_proxy';

export type MontiProfile = {
  id: string;
  name: string;
  status?: string;
  color?: string;
  // What the profiles table draws in the Name column instead of the initials
  // plate. One text column carrying a tagged union, the same shape folders.icon
  // uses for `flag:US` alongside its FOLDER_ICONS keys:
  //
  //   'brand:<slug>'  one of the TAG_PRESETS slugs (src/data/tagPresets.ts),
  //                   drawn as that brand's own mark
  //   'https://…'     a picture, uploaded to the `global` bucket or pasted
  //   undefined       the initials plate, which is what every profile had
  //                   before this field existed
  //
  // Anything else downgrades to the initials plate client-side, so removing a
  // brand from the catalog costs a profile its logo rather than breaking it.
  // Parsed in exactly one place: src/lib/profileAvatar.ts.
  avatar?: string;
  tags?: string[];
  // Login credentials for whatever account this profile is logged into.
  // Stored in plaintext the same way MontiProxy.password already is -- no
  // separate encrypted store, consistent with the rest of this app's model.
  email?: string;
  password?: string;
  // Where those two go. Reference only, like the pair above: nothing in the
  // launcher or the browser fills a login form, and this does not make it. What
  // it does is make the pair legible -- a colleague picking the profile up can
  // see which site it signs into -- and give an automation one place to read
  // the address from, as {{profile.login_url}}.
  //
  // Deliberately separate from start_url, which is where a launch lands. The
  // two are often the same page and just as often are not: a warmed profile
  // opens a feed and signs in from a different address entirely.
  login_url?: string;
  folder_id?: string | null;
  proxy_id?: string | null;
  proxy_mode?: ProxyMode;
  start_url?: string | null;
  cookie_import_path?: string | null;
  cookie_import_url?: string | null;
  cookie_import_name?: string | null;
  cookie_import_count?: number | null;
  // 'saved' resolves cookie_id against CloudState.cookies at launch time
  // (see MontiCookie); undefined/'paste' uses the cookie_import_* fields
  // above instead.
  cookie_mode?: 'paste' | 'saved';
  cookie_id?: string | null;
  // The automation that runs when this profile launches, or null for none.
  // One per profile on purpose: the on-launch trigger fires exactly once, so
  // "what runs when I click Launch" must have exactly one answer -- the same
  // argument cookie_id above is built on, and why neither has a join table.
  //
  // Attaching one is also what opens --remote-debugging-port for that launch.
  // A profile with no automation gets no port, because an always-open debug
  // port is connectable by any local process and CDP attachment is observable
  // from the page.
  automation_id?: string | null;
  // What this profile answers when a parameterised automation asks, keyed by
  // automation id: {"flat-search": {"city_name": "Dortmund"}}. This is the
  // whole point of parameters -- one workflow, a different city per profile.
  //
  // NOT limited to automation_id above. A profile holds values for every
  // parameterised automation it is ever run with, however that run starts
  // (dialog, launch, schedule, MCP), which is why it is a map and not a second
  // scalar beside the on-launch slot.
  automation_vars?: ProfileAutomationVars;
  command_line_switches?: string | null;
  fingerprint?: {
    os?: string;
    browser_version?: string;
    user_agent?: string;
    language?: string;
    timezone?: string;
    geolocation?: string;
    webrtc?: string;
    canvas?: string;
    webgl?: string;
    webgpu?: string;
    client_rects?: string;
    audio?: string;
    webgl_vendor?: string;
    webgl_renderer?: string;
    screen?: string;
    cpu_model?: string;
    cpu_cores?: number | null;
    memory_gb?: number | null;
    media_devices?: string;
    do_not_track?: boolean;
    rotate_on_launch?: boolean;
  };
  created_at?: string;
  // Who made this profile, as an auth user id. Resolved to a name through
  // CloudState.members, which is why the Profiles table only shows the column
  // once there is more than one member to tell apart.
  //
  // Null on every row created before 2026-08-05-teams.sql set the column's
  // default to auth.uid(): the column existed and was selected all along, but
  // nothing ever wrote it. Those rows render "—" rather than being backfilled
  // to the owner, because guessing an author is worse than admitting to none.
  created_by?: string | null;
  // Who is on the hook for this row, as an auth user id. Distinct from
  // created_by, which never changes: authorship is history, an assignment is a
  // current fact and moves when work is handed over. Null means unclaimed.
  //
  // NOT a permission. Everyone in the org sees every profile either way -- see
  // the note on Handoff.
  assigned_to?: string | null;
  // Soft-delete timestamp (ISO 8601). Set when a profile is moved to Trash;
  // the profile is hidden from the normal profiles list but kept for 30 days
  // (auto-purged on the next app launch after that) so an accidental delete
  // can be restored.
  deleted_at?: string | null;
};

export type MontiFolder = {
  id: string;
  name: string;
  // Which library this folder belongs to. Profile, proxy, cookie-set and
  // automation folders all share one `folders` table -- the column exists so
  // they stay separate namespaces rather than one pile the user has to read
  // twice. Undefined means 'profile', the column's default and what every row
  // predating proxy folders is.
  //
  // There is no CHECK on the column, so a fifth library needs no migration --
  // only a wider union here and a matching branch in the load-time split.
  // 'automation' was exactly that: 20260817 adds automations.folder_id and
  // touches this table not at all.
  kind?: 'profile' | 'proxy' | 'cookie' | 'automation';
  // A key into FOLDER_ICONS (src/data/folderIcons.ts), or a "flag:<ISO>" key
  // for a country flag -- never a URL or markup, so an unknown value can only
  // ever downgrade to the plain folder glyph.
  icon?: string;
  // A PROFILE_COLORS key or a custom #rrggbb, read through profileColorStyle()
  // exactly like MontiProfile.color. Tints the folder's glyph in the rail and
  // in the profiles table; the card itself stays neutral.
  color?: string;
  created_at?: string;
};

export type MontiProxy = {
  id: string;
  name: string;
  // A label the user marks this proxy with, free text exactly as
  // MontiProfile.status is. Undefined means the first of baseProxyStatuses --
  // there is no stored default, the same way an unset profile status reads as
  // 'Ready'. The built-in labels differ from the profile ones (a proxy has no
  // Warmup); custom labels are shared across both. See src/data/statuses.ts.
  status?: string;
  type?: 'http' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
  // The proxy-kind folder this proxy is filed under, or null for "All proxies".
  // Same shape and same ON DELETE SET NULL as MontiProfile.folder_id.
  folder_id?: string | null;
  country?: string;
  country_code?: string;
  // The exit location the last check measured, from the same lookup that fills
  // country. `timezone` is what resolveTimezone prefers over the country default
  // -- a US proxy is only ever Eastern by coincidence.
  timezone?: string;
  city?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  egress_ip?: string;
  ping_ms?: number;
  checked_at?: string;
  check_error?: string;
  // Who is on the hook for this proxy. See MontiProfile.assigned_to.
  assigned_to?: string | null;
  // When it arrived, and who put it there. Read-only in both cases: the row
  // carries created_at from the moment of insert and created_by from the
  // column's DEFAULT auth.uid(), and proxyToRow sends neither back.
  //
  // created_by is null for every proxy added before
  // 20260815000000_created_by_attribution.sql, and for anyone who has since
  // left the workspace. Both read as "no known author" -- see newSince.ts.
  created_at?: string;
  created_by?: string | null;
};

// A shared, reusable cookie-set in the Cookies tab library. A set is attached
// to a profile through MontiProfile.cookie_id (profiles.cookie_set_id): a
// profile carries at most one set, a set may be used by any number of
// profiles. The FK is the whole model -- there is no join table and there must
// not be one, or "which cookies does this profile launch with" stops having a
// single answer.
//
// `url` is a Supabase Storage public URL (or a data: URL fallback), produced by
// the exact same upload path as the per-profile cookie_import_url flow (see
// cloudCookieFromSelection) -- so the launch payload consumes it identically,
// no separate backend handling needed. It stays the source of truth for a
// launch: electron/main.cjs fetches it and holds no Supabase credentials.
//
// The cookies themselves are deliberately NOT on this type. They live in the
// cookie_sets.cookies jsonb column and are loaded on demand by the inspector --
// a workspace with 200 sets would otherwise pull every payload on every load,
// and useCloudData reloads on window focus.
export type MontiCookie = {
  id: string;
  name: string;
  url: string;
  count?: number | null;
  // A label the user marks this set with. Same contract as MontiProxy.status
  // above; undefined reads as the first of baseCookieStatuses.
  status?: string;
  // A PROFILE_COLORS key or a custom #rrggbb, read through profileColorStyle()
  // exactly like MontiProfile.color -- and set from the same ColorPicker.
  // Tints the set's icon in the Name cell. Undefined keeps the behaviour that
  // preceded this field: the icon takes the colour of its folder, which left
  // two sets in one folder looking identical.
  color?: string;
  // The cookie-kind folder this set is filed under, or null for
  // "All cookie-sets". Same shape and same ON DELETE SET NULL as
  // MontiProfile.folder_id.
  folder_id?: string | null;
  // Free text, capped at MAX_PROFILE_TAGS and read through the same tag catalog
  // profiles use -- a set tagged "instagram" and a profile tagged "Instagram"
  // are the same idea and render alike.
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  // Who is on the hook for this set. See MontiProfile.assigned_to. Distinct
  // from "assigned to profiles", which is what cookie_set_id does -- that says
  // which profiles USE it, this says which person looks after it.
  assigned_to?: string | null;
  // Soft-delete timestamp, the same 30-day contract as MontiProfile.deleted_at.
  // Trashing a set also unassigns every profile using it, because a trashed set
  // that could still seed a launch would be a lie.
  deleted_at?: string | null;
  // Who added it. Same shape, same nullability and same reasoning as
  // MontiProxy.created_by.
  created_by?: string | null;
};

export type SharedExtension = {
  // Stable id (generated at add-time) used as the local cache-directory name
  // every team member materializes this extension into -- the actual files
  // are never stored directly in cloud state, only enough to fetch/rebuild
  // them locally on any machine.
  id: string;
  name?: string;
  source: 'local' | 'webstore';
  // source === 'webstore': downloaded/unpacked fresh from Google's own CDN
  // by each team member, so it's always the current published version and
  // never re-hosted by us.
  webstoreId?: string;
  // source === 'local': a public Supabase Storage URL for the zipped
  // folder, uploaded once by whoever added it; every other team member
  // downloads+unpacks it into their own local cache the first time they
  // launch a profile that uses it.
  storageUrl?: string;
  // Whether profiles actually launch with it. Undefined/missing means enabled,
  // the same convention BuiltInExtensionToggles uses below, so rows written
  // before the column existed keep loading. Installed-but-off is a real state:
  // it keeps the extension in the org's library (and out of every profile)
  // without anyone having to re-find it in the store to turn it back on.
  enabled?: boolean;
};

export type SharedBookmark = {
  // Row id (uuid) once the bookmark has been persisted. The UI still
  // identifies a bookmark by its normalized url -- id only exists so an edit
  // or delete can address the exact row instead of matching on url server-side.
  id?: string;
  title: string;
  url: string;
  icon?: string;
  // Display order, written from the array index. Rows are read back ordered by
  // it so the list is stable across machines.
  position?: number;
};

// Per-extension on/off switches for the built-in (non-removable) "stock"
// extensions -- these ship with every install (cookie-manager, SMS-Activate)
// or are conditionally bundled per profile (foxywall_free_proxy, gated on a
// profile's proxy_mode === 'free_proxy').
//
// What a missing key means is NOT uniform, and is defined once per extension in
// electron/built-in-extensions.cjs rather than inferred here. The first three
// default to enabled, so cloud state saved before their toggles existed does
// not silently lose them. captcha_plugin defaults to disabled: its files are
// not vendored in extensions/ but downloaded on enable (~56 MB), so an org that
// has never heard of it must not read as having opted into that.
export type BuiltInExtensionToggles = {
  cookie_manager?: boolean;
  sms_activate?: boolean;
  foxywall_free_proxy?: boolean;
  captcha_plugin?: boolean;
};

// A workflow: an ordered list of steps driven against one profile's browser
// over CDP. The steps themselves are typed in src/automations/types.ts.
//
// Saved automations are documents, not assets -- nothing on disk belongs to
// one, so there is no deleted_at and no Trash. Deleting one detaches the
// profiles pointing at it (ON DELETE SET NULL) and leaves its runs readable,
// which is what automation_name on AutomationRun is for.
export type MontiAutomation = {
  id: string;
  name: string;
  description?: string | null;
  steps: AutomationStep[];
  // Seed values every run starts with, before any setVar or extract. Untyped
  // and undeclared -- the bag MCP has always accepted, with no UI of its own.
  // A declared parameter of the same name SHADOWS its entry; the precedence
  // lives in resolveRunVars (src/automations/parameters.ts).
  variables?: AutomationVars;
  // What this automation asks for before it runs: ordered, typed, and the
  // reason one workflow can serve many profiles. Each is addressable from any
  // interpolated step field as {{vars.<name>}}, and every profile can hold its
  // own values (MontiProfile.automation_vars). Shape in
  // src/automations/parameters.ts.
  parameters?: AutomationParam[];
  // Free text, at most 5, normalized through normalizeTags on every write --
  // the same contract profiles.tags has, and the same catalog behind the
  // suggestions, so "facebook" means the same thing on both.
  tags?: string[];
  // Shows as a tile on every profile's generated start page. Org-wide: the
  // per-profile slot is MontiProfile.automation_id, and pins are the
  // many-to-many case that would otherwise need a join table.
  pinned?: boolean;
  // Whole-run ceiling. The runner also caps every individual step.
  timeout_ms?: number;
  // Close the browser when the run ends -- but only a browser this run opened.
  // A run that attached to a window that was already there leaves it alone, and
  // that covers the on-launch and start-page triggers by construction: the user
  // opened those. Cancelling never closes anything either. The main process
  // holds the whole rule; see the onFinish wiring in main.cjs.
  //
  // (This comment used to describe a default that varied by trigger. It never
  // did: nothing read this field at all until the runner learned to.)
  close_on_finish?: boolean;
  // "Tell me when this finishes." null/undefined means it does not notify;
  // 'failure' also covers a partial run, whose continue-past step failure is
  // still a failure the user asked to hear about. Cancelling never notifies --
  // the user just did it themselves.
  notify_on?: 'always' | 'failure' | null;
  // Where the finish message additionally goes: a message connector's id, or
  // null for delivery to Scout Web alone (the topbar bell and a desktop
  // notification, which fire whenever notify_on says to regardless of this
  // field). Deliberately no FK behind it -- a deleted connector fails the send
  // with a sentence naming it rather than silently notifying nobody.
  notify_connector_id?: string | null;
  // Card identity: 'brand:<slug>' (the profile-avatar grammar, decoded by
  // parseAvatar) or null for the default workflow glyph. `color` is a
  // ProfileColorKey or '#rrggbb'; it tints the plate behind the default glyph,
  // and with a brand mark picked it tints the card's frame instead -- a logo
  // brings its own colours and does not want a second one behind it. See
  // components/automations/AutomationMark.tsx.
  icon?: string | null;
  color?: string | null;
  // Which automation folder this is filed in, or null for "All automations".
  // The folders table is shared with profiles, proxies and cookie sets and
  // separated by `kind` -- see MontiFolder.
  folder_id?: string | null;
  // Set when the automation is in Trash, cleared when it is restored. The grid
  // filters on it exactly as the profiles table does, so Trash is a view of
  // this list rather than a second read. Purged 30 days later, by the renderer
  // on workspace load and by purge_expired_data for the org nobody opens.
  deleted_at?: string | null;
  // Verdict of the newest finished run, denormalized onto the row by
  // recordRunOutcome so the card can show it without reading runs. The runs
  // table holds the truth; these are reported, never recomputed.
  last_run_at?: string | null;
  last_run_status?: RunStatus | null;
  // Attribution. created_by is the human whose session wrote the row (DB
  // default auth.uid()); created_via says whether a person or an agent over
  // MCP authored it, because for MCP writes created_by is just whoever had the
  // launcher open. created_by_label names the agent in that case. Set once at
  // create, never rewritten by saves. updated_by is trigger-maintained.
  created_by?: string | null;
  created_via?: 'user' | 'mcp';
  created_by_label?: string | null;
  updated_by?: string | null;
  // When this automation runs by itself -- null/undefined means it does not.
  // Shape and arithmetic in src/automations/schedule.ts.
  schedule?: AutomationSchedule | null;
  created_at?: string;
  updated_at?: string;
  // Who is on the hook for this automation. See MontiProfile.assigned_to.
  assigned_to?: string | null;
};

// An outside service automations can call, shared by the whole workspace: an
// AI endpoint an aiPrompt/aiCheck step asks, or a messaging target a notify
// step sends through. `category` is which of those it is; `kind` is which
// service; `config` is everything service-specific, shaped by the preset
// catalogue in src/data/connectors.ts.
//
// Workspace-wide rather than per-machine so a shared automation runs for
// everyone who opens it, which is also why `config` -- credentials included --
// is readable by every member. See the migration for the full reasoning,
// including why plaintext columns are the consistent choice in an app whose
// proxy and profile passwords are already stored the same way.
export type MontiConnector = {
  id: string;
  // What the workspace calls it. This is what a step's dropdown lists, so
  // renaming one changes how every workflow using it reads.
  name: string;
  // What the connector is for, which is what a step filters on. The default is
  // per category too: an AI step and a notify step each want their own.
  category: 'ai' | 'message';
  // A preset id from src/data/connectors.ts. Unknown values are shown as
  // unrecognised rather than treated as an error -- the catalogue can move
  // ahead of a row written by an older build.
  kind: string;
  // The service-specific fields, as strings under the keys the preset
  // declares. Which of them are secret is the preset's call too.
  config: Record<string, string>;
  // Used by a step that names no connector. At most one per (org, category),
  // enforced by a partial unique index rather than by the client.
  is_default?: boolean;
  created_at?: string;
  updated_at?: string;
};

// One "a run finished" record, org-wide -- the bell's second kind next to
// teammate handoffs, and what the OS notification mirrored. Composed by the
// main process off the run record and written by the renderer (the only side
// with Supabase); `status` is reported from that record, never recomputed.
export type MontiNotification = {
  id: string;
  // What produced this. 'automation_run' today; a column rather than an
  // assumption so a third bell kind is a row here, not another table.
  kind: string;
  title: string;
  body: string;
  status?: string | null;
  // What to open when the row is clicked. Null when there is nothing to open.
  automation_id?: string | null;
  run_id?: string | null;
  // Who set the run going -- what the bell renders, not an access rule.
  created_by?: string | null;
  created_at: string;
};

// One execution. Written when the run starts, not when it finishes, so a crash
// still leaves a record -- a run that vanishes without one is the worst
// outcome. The runner mirrors this to <userData>/AutomationRuns/<id>/run.json
// on every status change and flushes it here on next launch, which is what
// makes history honest when the window was closed mid-run.
export type AutomationRun = {
  id: string;
  automation_id?: string | null;
  // Denormalized at write time so a run still reads after its automation is
  // deleted.
  automation_name: string;
  profile_id?: string | null;
  profile_name: string;
  trigger: RunTrigger;
  status: RunStatus;
  started_at: string;
  finished_at?: string | null;
  duration_ms?: number | null;
  step_count: number;
  failed_step_id?: string | null;
  error?: string | null;
  vars: AutomationVars;
  log: RunLogEntry[];
};

// The tenant. One client firm is one org; its workers are org_members. Every
// row in every table below hangs off organizations.id, and RLS keys on it --
// see docs/data-model.md. profile_limit null means unlimited (Enterprise).
export type MontiOrg = {
  id: string;
  name: string;
  plan: string;
  profile_limit: number | null;
  seat_limit: number;
  billing_status: string;
  current_period_end?: string | null;
  built_in_extensions?: BuiltInExtensionToggles;
  // How many automations this org may save. null is unlimited, the same
  // convention profile_limit uses; the database default is 0, so an org on a
  // plan without automations cannot create one and every automation route
  // refuses it. A column rather than a lookup on `plan` on purpose -- the site
  // and the database disagree about plan keys (landing/LANDING.md:96-128), and
  // an integer means the launcher never has to know which spelling is live.
  automation_limit?: number | null;
  // Who the workspace belongs to, answered once at onboarding and editable in
  // Settings. Descriptive only -- nothing above this line is derived from it.
  //
  // `legal_name` is deliberately not `name`. `name` is what this workspace is
  // called and an owner may rename it to "Client accounts" whenever they like;
  // `legal_name` is the business behind it and stays put. Collapsing them would
  // make "which company is this" unanswerable the first time somebody tidies up
  // their workspace names.
  org_type?: OrgType | null;
  legal_name?: string | null;
  // ISO 3166-1 alpha-2, uppercase, constrained in the database.
  country?: string | null;
  website?: string | null;
  logo_url?: string | null;
  // The workspace's notification bot: the token members' launchers send
  // through, and the @username the link button opens. Owner-set on the
  // Automations tab's Notification bot view.
  telegram_bot_token?: string | null;
  telegram_bot_name?: string | null;
  // The gate the setup prompt reads. A timestamp rather than a boolean so
  // "never asked" and "asked, answered the first question, skipped the rest"
  // stay distinguishable -- a solo workspace legitimately has null in every
  // other column here.
  onboarded_at?: string | null;
};

// Solo or business. The only question onboarding asks that everyone answers.
export type OrgType = 'solo' | 'business';

// Two roles, not three. The owner is the account holder -- whoever ran
// bootstrap_org -- and is the only person who can invite, remove, or mint an API
// token. Everyone else is a member with full access to the work: every profile,
// proxy, cookie set and automation, plus the workspace's own name and branding.
//
// 'admin' was removed in 2026-08-10-owner-member-roles.sql. Nothing writes it and
// the check constraint on org_members now refuses it.
export type OrgRole = 'owner' | 'member';

// One row of org_members joined to its organization. `role` no longer decides
// whether the org-wide settings are writable -- the UPDATE policy on
// organizations is is_org_member, and the entitlement columns are held back by
// column grants rather than by any role. It decides who manages people.
export type OrgMembership = {
  org: MontiOrg;
  role: OrgRole;
};

// One person on the team, as the roster needs them.
//
// This is NOT a row of org_members: that table holds ids and nothing else, and
// Supabase does not expose auth.users to clients, so a member list built by a
// join from here would render a column of uuids. The identity fields come from
// the org_members_with_identity function, which reads auth.users on the
// server for orgs the caller already belongs to.
//
// `display_name` and `avatar_url` are empty strings rather than null when the
// person has set neither -- the callers fall back to the address and to an
// initials plate, and one shape means no call site has to handle both.
export type OrgMember = {
  user_id: string;
  email: string;
  display_name: string;
  avatar_url: string;
  role: OrgRole;
  // When they joined this org, not when the account was created.
  created_at: string;
  // Who invited them. Null for the founding owner, who invited nobody.
  invited_by: string | null;
};

// Who wrote a note. Two values, and the distinction is not cosmetic: the local
// API and the MCP server write through the renderer's Supabase session, so an
// agent's note and the signed-in human's note reach the database with the same
// created_by. This is the only field that tells them apart.
export type NoteAuthorKind = 'user' | 'agent';

// One entry in a profile's note thread -- what this profile is for, why it is
// set up the way it is, what was tried on it.
//
// Append-only in spirit: anyone in the org can add one and read all of them,
// but only the author can edit or delete their own, and agent-written notes are
// immutable to everyone. A backlog whose entries can be rewritten by whoever
// reads them last is not a record of anything.
export type ProfileNote = {
  id: string;
  profile_id: string;
  body: string;
  author_kind: NoteAuthorKind;
  // The auth user id the write went through. Resolved to a name against
  // CloudState.members by assigneeName(), the same way profiles.created_by is.
  // Null once that member has left the org.
  created_by: string | null;
  // The API key's name, on agent notes only. Null for anything a person wrote.
  author_label: string | null;
  created_at: string;
  updated_at: string;
};

// A profile's note thread reduced to what a table row needs: how many, and the
// newest one. Read from the profile_note_summaries view.
export type ProfileNoteSummary = {
  profile_id: string;
  note_count: number;
  last_id: string;
  last_body: string;
  last_author_kind: NoteAuthorKind;
  last_created_by: string | null;
  last_author_label: string | null;
  last_created_at: string;
};

export type OrgInviteStatus = 'pending' | 'accepted' | 'revoked';

// An offer of a seat that has not been taken yet.
//
// Only the owner can read these -- every policy on org_invites is is_org_owner,
// including select -- so this is Team-tab-local state rather than part of
// CloudState. A member reading the table gets an empty list, not an error, which
// is exactly the kind of silent nothing that does not belong in the shared
// workspace cache.
//
// `role` is a constant rather than an OrgRole: an invite can only ever offer
// membership. The column keeps its check constraint (`role = 'member'`) and
// create_org_invite refuses anything else, so this is the type saying what the
// database already enforces.
export type OrgInvite = {
  id: string;
  email: string;
  role: 'member';
  status: OrgInviteStatus;
  // The credential. Minted server-side by create_org_invite, emailed to the
  // invitee by the website, and shown once in the dialog so the owner can pass
  // it on by hand when the email does not arrive.
  token: string;
  expires_at: string;
  created_at: string;
  invited_by: string | null;
  // When the website last emailed this invitation, or null if it never has.
  // The Team tab shows a copy-the-link button only while this is null: once a
  // message is out, the owner delivering a second copy by hand is noise rather
  // than help.
  last_emailed_at: string | null;
};

// What one teammate can hand to another. Deliberately not every table: a folder
// is a filing decision that belongs to the workspace rather than to a person,
// and extensions/bookmarks are org-wide settings nobody owns individually.
export type HandoffKind = 'profile' | 'proxy' | 'cookie_set' | 'automation';

export type HandoffStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

// An offer to take something over.
//
// Read the word "share" carefully here, because it does NOT mean access.
// Profiles, proxies, cookie sets and automations are scoped by org_id and by
// nothing else, so every member of the workspace can already see all of them --
// there is no permission left to grant. What a hand-off moves is
// responsibility: accepting sets the item's `assigned_to` to you.
//
// So the approve step is not a gate on data. It is consent: work does not
// silently land on your plate because a colleague decided it should.
export type Handoff = {
  id: string;
  kind: HandoffKind;
  status: HandoffStatus;
  item_id: string;
  // The name the item had when it was offered, denormalised server-side. The
  // four tables share no shape to join to, so rendering an inbox from live rows
  // would mean a union per notification for one string.
  item_name: string;
  // Both are auth user ids. Names are resolved from CloudState.members, which
  // the launcher already holds -- unlike the cross-org design this replaced,
  // both parties are in one org, so no server-side identity join is needed.
  from_user: string | null;
  to_user: string;
  note: string;
  created_at: string;
};

export type CloudState = {
  profiles: MontiProfile[];
  // Profile folders only. The proxy ones are held apart rather than mixed in
  // behind a `kind` check because half a dozen call sites read this list and
  // every one of them means profile folders -- the folder row, the assign
  // dropdown, the move dialog, the tag suggestions, the API-key folder scope.
  // Splitting once, on load, is what makes a proxy folder unable to leak into
  // any of them.
  folders: MontiFolder[];
  proxy_folders: MontiFolder[];
  cookie_folders: MontiFolder[];
  automation_folders: MontiFolder[];
  proxies: MontiProxy[];
  // Every set in the library, trashed ones included -- the Cookies tab filters
  // on deleted_at the same way the Profiles tab does, so Trash is a view rather
  // than a second read.
  cookies: MontiCookie[];
  shared_extensions: SharedExtension[];
  shared_bookmarks: SharedBookmark[];
  custom_statuses: string[];
  // Saved workflows, trashed ones included -- the Automations tab filters on
  // deleted_at the way the Profiles and Cookies tabs do. Runs are deliberately
  // NOT here: they are unbounded and only the history view wants them, so they
  // are read on demand -- the same reason cookie_sets.list() leaves the
  // `cookies` column out.
  automations: MontiAutomation[];
  // The workspace's connectors -- AI endpoints and messaging targets. Loaded
  // with everything else rather than on demand because the automation editor
  // needs the names to render a step's connector dropdown, and the main
  // process needs the whole list -- credentials included -- before any run can
  // make a call.
  connectors: MontiConnector[];
  // Run-finished notifications, newest first, each carrying whether THIS user
  // has read it (joined from notification_reads at load). The bell renders
  // these next to handoffs.
  notifications: (MontiNotification & {read: boolean})[];
  // Everyone in this org. Here rather than local to the Team tab because the
  // Profiles table needs it too -- it is what turns profiles.created_by from a
  // uuid into a name -- and reading it twice for two surfaces would be two
  // round trips for one small list.
  //
  // Pending invites are deliberately NOT here; see OrgInvite.
  members: OrgMember[];
  // One row per profile that has any notes: the newest note and how many there
  // are. The SUMMARIES are here; the threads are not. A thread is unbounded and
  // only wanted when somebody opens one, so it is read on demand -- the same
  // split runs and cookie payloads already get. Without this the Notes column
  // would be a query per visible row.
  note_summaries: ProfileNoteSummary[];
  // The signed-in user's starred automation ids. Personal, not workspace data
  // -- RLS narrows the read to own rows -- so no other member's stars ever
  // appear here.
  automation_stars: string[];
  // This user's per-automation Telegram preferences, and their own linked
  // chat (null until they press Start in the bot). The chat id here is only
  // ever the signed-in user's own -- RLS narrows the read.
  telegram_prefs: {automation_id: string; notify_on: 'always' | 'failure'}[];
  telegram_link: {chat_id: string; telegram_username: string | null; linked_at: string} | null;
  built_in_extensions?: BuiltInExtensionToggles;
};
