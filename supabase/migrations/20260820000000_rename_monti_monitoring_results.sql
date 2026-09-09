-- Rename `monti_monitoring_results` to `scout_monitoring_results`, and its
-- index, to match the Monti -> Scout rebrand.
--
-- Why a new migration rather than editing the old one: this table is live --
-- electron/automation/store.cjs / src/hooks/useAutomationBridge.ts write to it
-- on every automation run today -- and the migration that created it
-- (docs/schema-changes/archive/2026-07-legacy-cloud-state.sql) has already run
-- against the hosted project. Editing that file's SQL in place would not
-- rename anything in the live database; it would just misdescribe what was
-- actually applied. An ALTER on the live table is the only thing that
-- actually renames it, so that is what ships here, and the client code moves
-- to the new name in the same commit.
--
-- `monti_cloud_state` (also in that archive file) is not touched: per
-- docs/schema-changes/archive/README.md it was already dropped and no longer
-- exists, so there is nothing left to rename.
--
-- The `monti_*` keys `raw_user_meta_data` carries for display name / avatar /
-- table-column layout (src/db/account.ts, baseline.sql, active_workspace.sql)
-- are also left alone on purpose: those are JSON keys inside Supabase Auth's
-- own per-user metadata, already set for every existing signed-in user, not
-- table/column identifiers this migration owns. Renaming the key here
-- wouldn't touch that JSON at all -- the actual producer of those values is
-- the sign-in flow on the launcher's website, outside this repo's scope for
-- this pass.

alter table if exists public.monti_monitoring_results
  rename to scout_monitoring_results;

alter index if exists monti_monitoring_results_user_run_idx
  rename to scout_monitoring_results_user_run_idx;
