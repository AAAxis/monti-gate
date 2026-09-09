-- A status for a proxy and for a cookie-set, and a colour for a cookie-set.
--
-- `profiles.status` has existed since the baseline: a free-text label drawn as a
-- coloured chip, pickable in the row, filterable from the toolbar, and
-- extensible through the org-scoped custom_statuses table. Proxies and
-- cookie-sets had no equivalent, so the only way to mark "this proxy is dying"
-- or "these cookies are stale" was to write it into the name or spend a tag on
-- it.
--
-- Free text here for the same reason profiles.status is free text: the built-in
-- labels differ per table (a proxy has no use for Warmup, a set has no use for
-- Ban) but the custom labels a team invents are shared across all three, so no
-- enum and no check constraint could hold the set of legal values without
-- turning every new custom status into a migration. custom_statuses gains no
-- `kind` column for the same reason -- one org-wide vocabulary, three built-in
-- lists that live in the client (src/data/statuses.ts).
--
-- Nullable with no default, and no backfill. An unset status renders as the
-- table's first built-in label -- Ready for a proxy, Fresh for a set -- exactly
-- as an unset profiles.status renders as Ready, so no existing row changes
-- meaning and nothing has to be written to make the column true.
alter table "public"."proxies"
  add column if not exists "status" "text";

-- cookie_sets.color holds the same string ScoutProfile.color holds: one of the
-- six PROFILE_COLORS keys, or a #rrggbb the user picked by hand, read only
-- through profileColorStyle(). It tints the set's icon in the Name cell, which
-- until now took the colour of the *folder* the set sits in -- so two sets in
-- one folder could not be told apart at a glance. Null keeps that folder tint,
-- which is why there is no default: an unmarked set looks exactly as it did.
alter table "public"."cookie_sets"
  add column if not exists "status" "text",
  add column if not exists "color" "text";

-- No RLS or grant changes. These are columns on existing tables whose policies
-- are row-scoped by org_id, so they inherit those policies unchanged, and both
-- tables carry table-level (not column-level) grants -- see the note in
-- 20260807000000_profile_notes.sql for when column grants are actually needed.
