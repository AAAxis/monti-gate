-- public.ai_providers: which model an automation's AI steps talk to, and with
-- what key.
--
-- Until now the relationship ran one way -- an agent drove Scout over MCP, and
-- Scout never called a model. The `aiPrompt` and `aiCheck` steps reverse it, and
-- they need somewhere to look up an endpoint and a credential.
--
-- ON THE KEY BEING PLAINTEXT. It is, in a text column, like proxies.password and
-- profiles.password already are. This app has no secrets store -- no keychain,
-- no safeStorage, nothing encrypted at rest -- and inventing one for this table
-- alone would mean the decryption key becomes the new secret with nowhere
-- better to live. What protects the column is RLS plus the fact that only the
-- main process ever sends it anywhere: a step references a provider by id, so
-- the key never reaches an automation's steps, its vars, its log or run.json.
--
-- WHO CAN READ IT. Every member of the org, and that is deliberate rather than
-- an oversight: the whole point of putting this in the workspace instead of on
-- one machine is that a teammate opening a shared automation can run it. The
-- editor masks the key to its last four characters for non-owners, which is a
-- courtesy in the UI and NOT a boundary -- a member can read the column. Only
-- owners may write, so nobody can quietly repoint the workspace's spend at
-- their own endpoint.
--
-- NOTE ON GRANTS. Default privileges in this database grant everything on a new
-- public table to anon, authenticated and service_role (see pg_default_acl), so
-- `create table` alone would hand anon full DML on a table of API keys. The
-- revoke below is load-bearing. RLS filters rows for a role that already holds
-- the grant; it does not supply the grant.

create table if not exists public.ai_providers (
  id         text primary key default (gen_random_uuid())::text,
  org_id     uuid not null references public.organizations (id) on delete cascade,
  -- What the user calls it: "Prod OpenAI", "Laptop LM Studio". This is what the
  -- step's dropdown lists, so it is the name a workflow is read against.
  name       text not null,
  -- A preset id from src/data/aiProviders.ts, or 'custom'. Deliberately text
  -- and not an enum: adding a provider must not need a migration, and an enum
  -- would make an unknown value a hard error on read rather than a card in the
  -- settings list saying it no longer recognises this one.
  kind       text not null,
  -- Overrides the preset's endpoint. Required for 'custom', null everywhere
  -- else unless the user is pointing at a proxy or a self-hosted gateway.
  base_url   text,
  model      text not null,
  -- Null for the local runtimes (LM Studio, Ollama), which authenticate nobody.
  api_key    text,
  is_default boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_providers_name_not_blank check (length(btrim(name)) > 0),
  constraint ai_providers_model_not_blank check (length(btrim(model)) > 0)
);

alter table public.ai_providers enable row level security;

revoke all on public.ai_providers from anon, authenticated;
grant select, insert, update, delete on public.ai_providers to authenticated;
grant all on public.ai_providers to service_role;

-- One default per org, enforced here rather than in the client. Two rows
-- claiming to be the default is not a state the app can resolve -- an AI step
-- with no provider named would run against whichever the query happened to
-- return first, which is a workflow whose behaviour changes with row order.
create unique index if not exists ai_providers_one_default_per_org
  on public.ai_providers (org_id)
  where is_default;

create index if not exists ai_providers_org_id_idx
  on public.ai_providers (org_id);

-- Read: any member, so a shared automation runs for the whole team.
create policy "org members read ai providers"
  on public.ai_providers for select to authenticated
  using (public.is_org_member(org_id));

-- Write: owners only. The key is billable and workspace-wide, and repointing it
-- silently redirects every AI step every member runs.
create policy "org owners insert ai providers"
  on public.ai_providers for insert to authenticated
  with check (public.is_org_owner(org_id));

create policy "org owners update ai providers"
  on public.ai_providers for update to authenticated
  using (public.is_org_owner(org_id))
  with check (public.is_org_owner(org_id));

create policy "org owners delete ai providers"
  on public.ai_providers for delete to authenticated
  using (public.is_org_owner(org_id));
