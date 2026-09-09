-- Why a profile exists, in the profile's own words.
--
-- Nothing on a profile row answers "what is this account for". The name is a
-- handle, the tags are a taxonomy, and the status says whether it is usable --
-- none of them hold "client X, do not warm up, proxy rotates nightly". People
-- were keeping that in the name, which is why names like `fb-main-DONT-TOUCH`
-- exist. Agents reading a profile over MCP had even less: id, name, and a
-- fingerprint.
--
-- A thread rather than a column. The single `profiles.notes` column that this
-- migration removes was exactly the "one text blob" version and it is instructive
-- that nobody ever wired it up: a shared workspace writing into one blob means
-- the second person to edit silently replaces the first, and there is no way to
-- ask who said a thing or when. Notes are appended, attributed and timestamped,
-- so the column reads as a small backlog per profile.

create table if not exists public.profile_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- text, not uuid. A profile id is also its on-disk directory name under
  -- E:\ScoutProfiles\<id> -- see the note on ProfileRow in src/db/rows.ts.
  profile_id text not null references public.profiles(id) on delete cascade,
  body text not null,

  -- Who wrote it, in two parts, because auth.uid() cannot answer this alone.
  --
  -- The local HTTP API and the MCP server do not hold a Supabase session of
  -- their own: they hand work to the renderer, which writes through the session
  -- of whichever human has the launcher open. So an agent's note and that
  -- human's note arrive with an identical auth.uid(), and a backlog that
  -- credits a person for what a script said is worse than one with no
  -- attribution at all.
  --
  -- created_by therefore means "the session this was written through" and stays
  -- the join back to org_members for a person's name. author_kind is what the
  -- UI reads, and author_label carries the API key's own name for agent rows.
  author_kind text not null default 'user' check (author_kind in ('user', 'agent')),
  created_by uuid default auth.uid(),
  author_label text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Long enough for a paragraph of context, short enough that this stays a note
  -- and does not become the place someone pastes a cookie jar.
  constraint profile_notes_body_len check (char_length(body) between 1 and 2000)
);

-- The one access pattern: a profile's thread, newest first. Also serves the
-- summary view, which reads the whole org in the same order.
create index if not exists profile_notes_profile_idx
  on public.profile_notes (org_id, profile_id, created_at desc);

alter table public.profile_notes enable row level security;

-- Reading and writing are org-wide, exactly as profiles are. AGENTS.md is
-- explicit that org_id is the only scope on any of these tables and that
-- attribution is a label rather than a permission -- every member already sees,
-- launches and edits every profile, so hiding a note from them would be a new
-- and inconsistent rule.
drop policy if exists "profile_notes_select" on public.profile_notes;
create policy "profile_notes_select" on public.profile_notes
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "profile_notes_insert" on public.profile_notes;
create policy "profile_notes_insert" on public.profile_notes
  for insert to authenticated
  with check (public.is_org_member(org_id));

-- Editing is the one place authorship IS a permission, and deliberately so: the
-- value of a backlog is that an entry still says what its author wrote. Anyone
-- can add a correcting note; nobody can rewrite someone else's.
--
-- The author_kind clause is not redundant. An agent note carries the created_by
-- of whoever had the launcher open when the key was used, so without it that
-- person could edit a note they did not write and the row would keep claiming
-- an agent said it.
drop policy if exists "profile_notes_update" on public.profile_notes;
create policy "profile_notes_update" on public.profile_notes
  for update to authenticated
  using (
    public.is_org_member(org_id)
    and created_by = auth.uid()
    and author_kind = 'user'
  )
  with check (
    public.is_org_member(org_id)
    and created_by = auth.uid()
    and author_kind = 'user'
  );

drop policy if exists "profile_notes_delete" on public.profile_notes;
create policy "profile_notes_delete" on public.profile_notes
  for delete to authenticated
  using (
    public.is_org_member(org_id)
    and created_by = auth.uid()
    and author_kind = 'user'
  );

-- What the Notes column in the Profiles table reads: one row per profile that
-- has any notes, carrying the latest one and how many there are.
--
-- A view rather than a second read per row. The table paginates at 25 and the
-- column would otherwise be 25 round trips per page, all of them for a preview
-- line; this is one query bounded by the profile count, which the plan limits
-- already cap. The full thread is still fetched on demand when a note is
-- actually opened -- the automation_runs treatment, for the same reason.
--
-- security_invoker is load-bearing. A view runs as its owner by default, which
-- would read straight past the RLS policies above and hand every org's notes to
-- every caller.
drop view if exists public.profile_note_summaries;
create view public.profile_note_summaries
  with (security_invoker = on) as
select distinct on (profile_id)
  profile_id,
  org_id,
  count(*) over (partition by profile_id) as note_count,
  id as last_id,
  body as last_body,
  author_kind as last_author_kind,
  created_by as last_created_by,
  author_label as last_author_label,
  created_at as last_created_at
from public.profile_notes
order by profile_id, created_at desc;

grant select, insert, update, delete on table public.profile_notes to authenticated;

-- Column-level grants for the UPDATE path. Without them RLS filters the update
-- rather than erroring, so a missing privilege comes back as
-- success-with-no-rows -- the trap 20260806160000_org_industry.sql documents.
-- Only these two: a note's author, kind and profile are not editable after the
-- fact, which is what the update policy above is protecting.
grant update("body") on table public.profile_notes to authenticated;
grant update("updated_at") on table public.profile_notes to authenticated;

grant select on table public.profile_note_summaries to authenticated;

-- The dead column this feature replaces.
--
-- It has been in the schema since the baseline and has never held a value:
-- rowToProfile does not map it, ScoutProfile has no such field, and the API's
-- update whitelist rejects it. Both electron/mcp/tools.cjs and
-- electron/api/routes.json carry comments explaining that `notes` was pulled
-- from the MCP tool because an agent could report success on a write that never
-- happened. Verified empty across every row before writing this.
--
-- Left in place it would be worse than dead: a second thing called "notes" next
-- to the real one, which is precisely how the silent-write bug happened twice.
alter table public.profiles drop column if exists notes;
