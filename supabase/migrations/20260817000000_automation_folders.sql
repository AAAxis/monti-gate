-- Automation folders and Trash.
--
-- Additive, like 20260812 and 20260814. Nothing in the renderer selects either
-- new column until this is applied -- src/db/automations.ts names its columns
-- explicitly, so a column in code but not in the database fails the whole
-- table's select and the workspace degrades automations to []. Apply this,
-- regenerate src/db/database.types.ts, and only then widen COLUMNS.
--
-- Two features, one migration, because they land on the same table in the same
-- release and splitting them would leave a build where Delete means one thing
-- in the grid and another in Trash.

-- ---------------------------------------------------------------------------
-- automations.folder_id: the fourth library
-- ---------------------------------------------------------------------------

-- public.folders is already polymorphic. `kind` carries a default and NO CHECK
-- constraint, which 2026-08-04-proxy-folders.sql chose deliberately and
-- src/types.ts restates on ScoutFolder: a fourth library needs "only a wider
-- union here and a matching branch in the load-time split". So there is
-- nothing to alter on folders -- its RLS policies and grants are table-level
-- and 'automation' inherits them free.
--
-- text, not uuid, and not negotiable: folders.id is text because it doubles as
-- an on-disk directory name, and a uuid column cannot reference it (42804).
--
-- ON DELETE SET NULL is the same load-bearing choice profiles, proxies and
-- cookie_sets all make. Deleting a folder never deletes what is filed in it --
-- the rows fall back to "All automations" -- and the app relies on the FK for
-- that rather than issuing a second statement.
alter table public.automations
  add column if not exists folder_id text references public.folders(id) on delete set null;

create index if not exists idx_automations_folder
  on public.automations using btree (folder_id);

-- ---------------------------------------------------------------------------
-- automations.deleted_at: Trash
-- ---------------------------------------------------------------------------

-- src/db/automations.ts has said "Hard delete -- automations have no Trash"
-- since the table existed, on the grounds that an automation is a document
-- with nothing on disk to orphan. True, and beside the point: an automation is
-- also the only thing in this app a user can destroy in two clicks and never
-- get back, and the steps in one represent more work than a profile does.
--
-- Same shape as profiles.deleted_at and cookie_sets.deleted_at, so
-- TRASH_RETENTION_DAYS, daysUntilPurge() and the whole Trash rail in
-- src/lib/trash.ts apply unchanged.
alter table public.automations
  add column if not exists deleted_at timestamp with time zone;

-- Mirrors idx_profiles_org_active. Every grid read is "this org, not trashed",
-- and the partial index is what keeps that from scanning rows in Trash.
create index if not exists idx_automations_org_active
  on public.automations using btree (org_id) where (deleted_at is null);

-- ---------------------------------------------------------------------------
-- The plan cap has to learn about Trash
-- ---------------------------------------------------------------------------

-- Unchanged except for `and deleted_at is null`, which enforce_profile_limit
-- has always had and this one never needed.
--
-- Without it, Trash is a trap rather than a safety net: organizations
-- .automation_limit defaults to 2, so a free-tier org that trashes both of its
-- automations counts 2 used, refuses to create a third, and the only way out
-- is to permanently delete something -- which is the exact outcome Trash was
-- added to prevent.
create or replace function public.enforce_automation_limit() returns trigger
    language plpgsql
    security definer
    set search_path to 'public'
    as $$
declare
  cap integer;
  used integer;
begin
  select automation_limit into cap from public.organizations where id = new.org_id;
  if cap is null then
    return new;                       -- unlimited
  end if;
  select count(*) into used
    from public.automations
   where org_id = new.org_id and deleted_at is null;
  if used >= cap then
    raise exception 'automation_limit_reached' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

alter function public.enforce_automation_limit() owner to postgres;

revoke all on function public.enforce_automation_limit() from public;
grant all on function public.enforce_automation_limit() to service_role;

-- Restoring crosses the cap, so it has to be checked there too.
--
-- The exact mirror of trg_profile_limit_restore, and for the exact reason:
-- once a trashed automation stops counting, an org at its cap can restore one
-- and end up over. The WHEN clause narrows this to the one UPDATE that matters
-- -- deleted_at going from set to null -- so ordinary edits never pay for the
-- count. enforce_automation_limit reads new.org_id and nothing else about the
-- operation, so it works on UPDATE unmodified.
--
-- The renderer restores in one statement for a whole selection, which means
-- the refusal is all-or-nothing rather than a partial restore. That is
-- deliberate; src/db/profiles.ts:97 says the same thing about profiles.
create or replace trigger trg_automation_limit_restore
  before update on public.automations
  for each row
  when ((old.deleted_at is not null) and (new.deleted_at is null))
  execute function public.enforce_automation_limit();

-- ---------------------------------------------------------------------------
-- 30-day purge
-- ---------------------------------------------------------------------------

-- Rewritten whole rather than patched, because create or replace is the only
-- way to change a function body and a half-copy here would silently drop the
-- other five statements. Identical to 20260816 apart from the automations
-- block and its counter.
create or replace function public.purge_expired_data() returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  runs bigint;
  trashed_profiles bigint;
  trashed_cookies bigint;
  trashed_automations bigint;
  invites bigint;
  settled_handoffs bigint;
  notices bigint;
begin
  -- 14 days: the window app/privacy/page.tsx already states, and the same one
  -- RETENTION_DAYS in electron/automation/store.cjs applies to the screenshots.
  -- Invisible to every reader -- RunLogModal asks for 25 runs, the scheduler
  -- for 3, the MCP bridge caps at 50, and src/db/runs.ts always sends a limit
  -- and never a date filter, so no surface can reach past the newest handful.
  -- `running` rows go too: one that never reached a terminal status in a
  -- fortnight is a run that died, not a run in progress.
  delete from public.automation_runs where started_at < now() - interval '14 days';
  get diagnostics runs = row_count;

  -- 30 days: TRASH_RETENTION_DAYS in src/lib/trash.ts, and what ConfirmModals
  -- tells the user when they delete. The renderer still purges on workspace
  -- load; this is what covers the org whose workspace nobody opens.
  -- `deleted_at is not null` is redundant next to the comparison and kept
  -- anyway: this is a DELETE, and it should read as obviously right.
  delete from public.profiles
    where deleted_at is not null and deleted_at < now() - interval '30 days';
  get diagnostics trashed_profiles = row_count;

  delete from public.cookie_sets
    where deleted_at is not null and deleted_at < now() - interval '30 days';
  get diagnostics trashed_cookies = row_count;

  -- Same window, same reason. profiles.automation_id is ON DELETE SET NULL, so
  -- this detaches the profiles still pointing at a purged automation rather
  -- than taking them with it, and automation_runs keeps a denormalized
  -- automation_name so what history survives the 14-day sweep stays readable.
  delete from public.automations
    where deleted_at is not null and deleted_at < now() - interval '30 days';
  get diagnostics trashed_automations = row_count;

  -- Settled invitations. src/db/team.ts:47 keeps accepted and revoked rows "for
  -- the audit trail" and then no surface ever selects them -- listInvites
  -- filters to pending, and so does the website's seat meter.
  --
  -- Pending is untouched at any age, including expired. That is deliberate and
  -- listInvites says why: the owner needs to see that the link they sent last
  -- week went stale, and the UI marks it expired rather than hiding it.
  delete from public.org_invites
    where status in ('accepted', 'revoked')
      and coalesce(accepted_at, created_at) < now() - interval '30 days';
  get diagnostics invites = row_count;

  -- Same shape. src/db/shared.ts:49 reads pending only, because "a declined
  -- offer is a decision already made and an accepted one is visible as the
  -- assignment itself".
  delete from public.handoffs
    where status <> 'pending'
      and coalesce(resolved_at, created_at) < now() - interval '30 days';
  get diagnostics settled_handoffs = row_count;

  -- The bell is an inbox, not an archive: src/db/notifications.ts reads the
  -- newest hundred, so anything older is already unreachable. notification_reads
  -- is ON DELETE CASCADE and follows on its own.
  delete from public.notifications where created_at < now() - interval '30 days';
  get diagnostics notices = row_count;

  -- Lands in the Postgres log, which is how you check what a night actually
  -- took without waiting for the next one. cron.job_run_details records that
  -- the job succeeded; it does not record what it removed.
  raise log 'purge_expired_data: runs=% profiles=% cookie_sets=% automations=% invites=% handoffs=% notifications=%',
    runs, trashed_profiles, trashed_cookies, trashed_automations, invites, settled_handoffs, notices;
end $$;

revoke all on function public.purge_expired_data() from public;
revoke all on function public.purge_expired_data() from anon;
revoke all on function public.purge_expired_data() from authenticated;
