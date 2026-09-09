-- Where a proxy actually exits, at city granularity rather than country.
--
-- A profile's timezone is what every anti-fraud system compares against the IP
-- address it sees, and Scout was resolving it from the proxy's *country*:
-- electron/main.cjs's COUNTRY_DEFAULTS maps a country code to one timezone, so
-- `us` meant America/New_York for every US proxy in existence. A Denver or Los
-- Angeles egress therefore reported an Eastern timezone, and the mismatch is
-- exactly what iphey.com flags as an unreliable digital identity. The United
-- States alone spans six zones, so the country tier could not have been right
-- more than a fraction of the time.
--
-- The data was already being fetched and thrown away. checkProxyEndpoint queries
-- ipapi.co, ipinfo.io and ip-api.com through the proxy; all three return the
-- IANA timezone, the city, the region and the coordinates, and the parser kept
-- only the country. These five columns are that discarded answer, persisted.
--
-- Nullable on purpose, and there is no backfill. A row written before this
-- migration, or one whose last check failed, simply has no stored location and
-- the launcher falls back to the per-country default exactly as it does today.
-- The values arrive on the next proxy check.
--
-- Named last_* to match last_ip / last_country / last_country_code / last_error
-- above them: every one of these columns means "what the most recent check saw",
-- not "what this proxy is", and they are cleared together whenever the
-- connection or credentials change, since a new egress invalidates all of them.
alter table "public"."proxies"
  add column if not exists "last_timezone" "text",
  add column if not exists "last_city" "text",
  add column if not exists "last_region" "text",
  add column if not exists "last_latitude" double precision,
  add column if not exists "last_longitude" double precision;

-- No RLS or grant changes. These are columns on an existing table whose policies
-- are row-scoped by org_id, so they inherit the proxies policies unchanged, and
-- the table carries table-level (not column-level) grants -- see the note in
-- 20260807000000_profile_notes.sql for when column grants are actually needed.
