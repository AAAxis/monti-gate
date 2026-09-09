# supabase/

The database this product runs on. It lives in the launcher because the launcher
is what owns the schema — every table here is read and written by the renderer.
`landing/` talks to the same project but only reads it, plus service-role
billing writes.

## Layout

| Path | What |
|---|---|
| `config.toml` | CLI configuration. Also documents which schemas PostgREST exposes and why. |
| `migrations/20260805000000_baseline.sql` | `pg_dump` of the live database, 2026-08-05. 33 tables, 23 functions, 77 policies, 46 indexes, 5 triggers. |
| `migrations/20260805000001_storage.sql` | The `global` bucket and its policies. Separate because `db dump` does not emit them. |
| `migrations/20260805000002_payment_events_deny_by_default.sql` | Makes "service role only" explicit on `payment_events`. |
| `seed.sql` | `plans` and `plan_terms` — reference data the product does not work without. |

## Why there is a baseline instead of a chain

Until 2026-08-05 the schema was managed by pasting SQL into the hosted
dashboard's editor. The migration history table listed seven CLI-era versions
whose files existed nowhere, and seventeen later changes were applied by hand
and never recorded at all. The database was the only copy of its own schema —
`0001_multitenant_core.sql` was referenced by seven files and present in none of
them, so nothing in the repo could recreate `organizations`, `profiles`,
`proxies`, `cookie_sets`, `folders`, `subscriptions`, or any RPC body.

The baseline is that missing copy, taken from production. The seven phantom
versions were removed from `supabase_migrations.schema_migrations` and replaced
with the three above, so `supabase migration list` now agrees end to end.

The prose behind those seventeen changes is kept in
[`../docs/schema-changes/archive/`](../docs/schema-changes/archive) — worth
reading, never worth running.

## Making a change

```sh
supabase migration new <name>
# edit supabase/migrations/<ts>_<name>.sql
supabase db push
supabase gen types typescript --linked --schema public > ../src/db/database.types.ts
npm run typecheck
```

That last pair matters. `src/db/rows.ts` is hand-written and carries refinements
the generator cannot infer, so it can drift; `src/db/rows.schema-check.ts` fails
the typecheck when it names a column the database no longer has. Without it the
symptom reaches users instead: PostgREST rejects a select naming an unknown
column *in its entirety*, and `useCloudData` reads tables with
`Promise.allSettled`, so one stale column name renders as "my proxies and
folders are gone" with no error anywhere.

## Connecting

The direct host (`db.<ref>.supabase.co`) is **IPv6-only** and will not resolve
on an IPv4-only network — `supabase db pull` and `db dump` fail there with
"could not translate host name". Use the session pooler instead:

```
postgresql://postgres.<ref>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
```

Port 5432 is session mode, which `pg_dump` needs; 6543 is transaction mode and
will not work for it. The project ref and dashboard links are in the umbrella
repo's `secrets/README.md`.

## Two things that are not in here

**`prelaunch`** is in the baseline but excluded from `config.toml`'s exposed
schemas. It is the parked pre-launch schema — 15 tables kept for reference by
migration `0000a_prelaunch_schema_aside` — and must not be reachable over
PostgREST.

**Browser session state is local-only, by design.** Each profile's Chromium
`--user-data-dir` — its cookie jar, logins, LocalStorage, IndexedDB — lives
under `ScoutProfiles/<profileId>/` in Electron's userData and is never uploaded.
`cookie_sets` is a seed/import mechanism, not a sync: cookies are written to
`seed-cookies.json` at launch and an extension imports them once. A profile
signed into a site on one machine is not signed in on another.
