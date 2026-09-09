-- public.connectors: one table for every outside service an automation talks
-- to, replacing public.ai_providers.
--
-- WHY GENERALISE RATHER THAN ADD A TABLE PER SERVICE. ai_providers was the
-- first of these and it was shaped for exactly one job: model, base_url,
-- api_key. The moment a Telegram bot token, a Slack webhook and an SMTP host
-- need to live somewhere, that shape is either five more tables with five more
-- RLS policy sets to keep in step, or a column per field on one table and a
-- migration every time a service is added. Neither is worth it for what is, in
-- every case, "a name, a kind, and a bag of settings".
--
-- So the service-specific half lives in `config` jsonb and its SHAPE lives in
-- src/data/connectors.ts -- the same call electron/automation/step-schema.json
-- makes for steps. Adding a connector kind is an entry in that catalogue and an
-- adapter in the main process; it is not a schema change.
--
-- ON THE SECRETS BEING PLAINTEXT. They are, inside `config`, exactly as
-- ai_providers.api_key was and as proxies.password and profiles.password
-- already are. This app has no secrets store -- no keychain, no safeStorage,
-- nothing encrypted at rest -- and inventing one for this table alone would
-- mean the decryption key becomes the new secret with nowhere better to live.
-- What protects the column is RLS plus the fact that only the main process ever
-- sends it anywhere: a step stores a connector id, so no token reaches an
-- automation's steps, its vars, its log or run.json.
--
-- WHO CAN READ IT. Every member of the org, deliberately: the whole point of
-- putting this in the workspace instead of on one machine is that a teammate
-- opening a shared automation can run it. The UI masks a secret to its last four
-- characters for non-owners, which is a courtesy and NOT a boundary -- a member
-- can read the column. Only owners may write, so nobody can quietly repoint the
-- workspace's spend, or its outbound messages, at their own endpoint.
--
-- NOTE ON GRANTS. Default privileges in this database grant everything on a new
-- public table to anon, authenticated and service_role (see pg_default_acl), so
-- `create table` alone would hand anon full DML on a table of API tokens and bot
-- credentials. The revoke below is load-bearing. RLS filters rows for a role
-- that already holds the grant; it does not supply the grant.

create table if not exists public.connectors (
  id         text primary key default (gen_random_uuid())::text,
  org_id     uuid not null references public.organizations (id) on delete cascade,
  -- What the user calls it: "Prod OpenAI", "Ops Telegram". This is what a step's
  -- dropdown lists, so it is the name a workflow is read against.
  name       text not null,
  -- What this connector is FOR, which is what a step filters on: an AI step
  -- offers the 'ai' ones and a notify step offers the 'message' ones. Kept
  -- separate from `kind` because the default is per category -- see the index
  -- below -- and because a step should not have to know the full list of kinds
  -- that happen to be able to send a message.
  category   text not null,
  -- Which service, as a preset id from src/data/connectors.ts. Deliberately
  -- text and not an enum: adding a connector must not need a migration, and an
  -- enum would make a value written by a newer build a hard error on read rather
  -- than a card saying this version does not recognise it.
  kind       text not null,
  -- Everything service-specific: model/base_url/api_key for an AI provider,
  -- botToken/chatId for Telegram, host/port/user/password for SMTP. The shapes
  -- live in the preset catalogue, not here -- a column per field would need a
  -- migration for every connector added, which is the whole reason this table
  -- exists instead of five.
  config     jsonb not null default '{}'::jsonb,
  -- Used by a step that names no connector. Per (org_id, category), not per org:
  -- an AI step and a notify step each want their own default, and one default
  -- across both would mean picking a Telegram bot as the workspace's model.
  is_default boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connectors_name_not_blank check (length(btrim(name)) > 0),
  constraint connectors_category_known check (category in ('ai', 'message')),
  -- An object, not an array or a scalar. Everything reading this indexes it by
  -- field key, and a `config` of `[]` would deserialize into a connector whose
  -- every field is undefined rather than failing where it was written.
  constraint connectors_config_is_object check (jsonb_typeof(config) = 'object')
);

alter table public.connectors enable row level security;

revoke all on public.connectors from anon, authenticated;
grant select, insert, update, delete on public.connectors to authenticated;
grant all on public.connectors to service_role;

-- One default per category per org, enforced here rather than in the client.
-- Two rows claiming to be the default is not a state the app can resolve -- a
-- step naming no connector would run against whichever the query happened to
-- return first, which is a workflow whose behaviour changes with row order.
--
-- src/db/connectors.ts setDefault demotes before it promotes for this reason:
-- promoting first collides with the incumbent and the whole change fails.
create unique index if not exists connectors_one_default_per_category
  on public.connectors (org_id, category)
  where is_default;

create index if not exists connectors_org_id_idx
  on public.connectors (org_id);

-- Read: any member, so a shared automation runs for the whole team.
create policy "org members read connectors"
  on public.connectors for select to authenticated
  using (public.is_org_member(org_id));

-- Write: owners only. These credentials are billable and workspace-wide, and
-- repointing one silently redirects every step every member runs through it.
create policy "org owners insert connectors"
  on public.connectors for insert to authenticated
  with check (public.is_org_owner(org_id));

create policy "org owners update connectors"
  on public.connectors for update to authenticated
  using (public.is_org_owner(org_id))
  with check (public.is_org_owner(org_id));

create policy "org owners delete connectors"
  on public.connectors for delete to authenticated
  using (public.is_org_owner(org_id));

-- ---------------------------------------------------------------------------
-- ai_providers -> connectors
-- ---------------------------------------------------------------------------
--
-- Every AI provider becomes a connector in the 'ai' category, with the three
-- columns that were specific to it folded into `config` under the same keys the
-- preset catalogue now declares.
--
-- strip_nulls matters: base_url and api_key are nullable, and jsonb_build_object
-- would write `"api_key": null` for a local runtime that authenticates nobody.
-- The catalogue reads a missing key as "not set"; it should not have to also
-- read an explicit null as the same thing.
--
-- This is a no-op on a database where nobody had configured a provider -- which
-- is every one of them today; production has zero rows. It is written anyway
-- because a migration that only works on an empty table is a migration nobody
-- can trust the second time.
insert into public.connectors
  (id, org_id, name, category, kind, config, is_default, created_by, created_at, updated_at)
select
  id,
  org_id,
  name,
  'ai',
  kind,
  jsonb_strip_nulls(jsonb_build_object(
    'model', model,
    'base_url', base_url,
    'api_key', api_key
  )),
  is_default,
  created_by,
  created_at,
  updated_at
from public.ai_providers;

drop table if exists public.ai_providers;

-- ---------------------------------------------------------------------------
-- automations: tell me when this finishes
-- ---------------------------------------------------------------------------
--
-- The automation-level counterpart to the notify step. The step sends something
-- the workflow computed; these two send the run's own outcome, from the runner's
-- finally, whether or not the workflow reached a notify step at all -- which is
-- exactly the case that matters, because a run that died on step two never
-- reaches anything.
--
-- No foreign key to connectors, deliberately, and for the same reason a step
-- referencing a deleted provider was left alone rather than repointed: ON DELETE
-- SET NULL would silently turn "notify me on failure" into "notify nobody", and
-- CASCADE would delete the automation. A dangling id fails the send with a
-- sentence naming the missing connector, which is the only one of the three a
-- user can act on.
alter table public.automations
  add column if not exists notify_connector_id text,
  -- 'always' | 'failure'. Null means the automation does not notify, which is
  -- the default and why the column is nullable rather than defaulted: an
  -- automation written before this existed must not start sending messages
  -- because a migration ran.
  add column if not exists notify_on text;

alter table public.automations
  drop constraint if exists automations_notify_on_known;

alter table public.automations
  add constraint automations_notify_on_known
  check (notify_on is null or notify_on in ('always', 'failure'));

-- ---------------------------------------------------------------------------
-- public.notifications: the topbar bell's second kind
-- ---------------------------------------------------------------------------
--
-- "Straight to Scout" as a delivery target. A run that finishes writes one row
-- here and the main process raises an OS notification alongside it; the bell
-- reads this table next to the handoffs it already shows.
--
-- ORG-SCOPED, NOT USER-SCOPED. A run belongs to the workspace -- anyone can open
-- the automation and read the run record -- so addressing the notification to
-- one person would hide from the rest of the team the thing they can already
-- see on the Automations tab. `created_by` records who set it running, which is
-- what the bell renders; it is not an access rule.
create table if not exists public.notifications (
  id         text primary key default (gen_random_uuid())::text,
  org_id     uuid not null references public.organizations (id) on delete cascade,
  -- What produced this. One value today; it is a column and not an assumption
  -- because the bell already renders two kinds side by side and a third is a
  -- row here rather than another table.
  kind       text not null,
  title      text not null,
  body       text not null,
  -- 'ok' | 'partial' | 'failed' | 'cancelled', copied off the run record. The
  -- bell tones the row from it. It is REPORTED, never recomputed: the run record
  -- decided this, and a notification that works the verdict out a second time is
  -- a second place for the two to disagree.
  status     text,
  -- What to open. Null when there is nothing to open.
  automation_id text,
  run_id     text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint notifications_title_not_blank check (length(btrim(title)) > 0)
);

alter table public.notifications enable row level security;

revoke all on public.notifications from anon, authenticated;
grant select, insert, delete on public.notifications to authenticated;
grant all on public.notifications to service_role;

create index if not exists notifications_org_created_idx
  on public.notifications (org_id, created_at desc);

create policy "org members read notifications"
  on public.notifications for select to authenticated
  using (public.is_org_member(org_id));

create policy "org members insert notifications"
  on public.notifications for insert to authenticated
  with check (public.is_org_member(org_id));

-- Any member may clear one. There is no per-row ownership to enforce: the row
-- is the workspace's, and a member who can read it can already act on what it
-- says.
create policy "org members delete notifications"
  on public.notifications for delete to authenticated
  using (public.is_org_member(org_id));

-- Read state, per user, as INSERT-ONLY rows rather than a `read_by uuid[]` on
-- the table above.
--
-- An array column would make "mark as read" a read-modify-write of a value two
-- people can be editing at once, which is the one thing src/db/ does not do
-- anywhere (see the rules at the top of src/db/index.ts). A row per (person,
-- notification) makes it an insert that cannot lose a concurrent one.
create table if not exists public.notification_reads (
  notification_id text not null
    references public.notifications (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);

alter table public.notification_reads enable row level security;

revoke all on public.notification_reads from anon, authenticated;
grant select, insert, delete on public.notification_reads to authenticated;
grant all on public.notification_reads to service_role;

-- Only ever about yourself, in all three directions. Nobody needs to know what
-- a colleague has read, and nobody may mark something read on their behalf.
create policy "own notification reads"
  on public.notification_reads for select to authenticated
  using (user_id = auth.uid());

create policy "mark own notifications read"
  on public.notification_reads for insert to authenticated
  with check (user_id = auth.uid());

create policy "unmark own notifications read"
  on public.notification_reads for delete to authenticated
  using (user_id = auth.uid());
