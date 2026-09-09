import type {ScoutAutomation} from '../types';
import {optionalClient, raise, requireClient} from './client';
import {automationPatchToRow, automationToRow, rowToAutomation} from './mappers';
import type {AutomationRow} from './rows';

// folder_id and deleted_at arrive with 20260817. Both are named here, which
// means this build REQUIRES that migration: PostgREST fails the whole select
// on an unknown column, and useCloudData's allSettled turns that into an empty
// automations list rather than an error anyone sees.
const COLUMNS =
  'id,org_id,name,description,steps,variables,parameters,tags,pinned,timeout_ms,close_on_finish,' +
  'notify_connector_id,notify_on,icon,color,folder_id,deleted_at,last_run_at,last_run_status,' +
  'created_by,created_via,created_by_label,updated_by,schedule,' +
  'created_at,updated_at,assigned_to';

export async function list(orgId: string): Promise<ScoutAutomation[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('automations')
      .select(COLUMNS)
      .eq('org_id', orgId)
      // Newest first -- the grid's base order (stars re-sort locally on top of
      // it). The optimistic insert in useAutomationActions prepends to match.
      .order('created_at', {ascending: false});
  raise(error, 'automations.list');
  return ((data || []) as unknown as AutomationRow[]).map(rowToAutomation);
}

// Deliberately NOT an upsert -- the same trap profiles.ts documents.
//
// trg_automation_limit is BEFORE INSERT, and Postgres fires BEFORE INSERT
// triggers for `insert ... on conflict do update` even when the conflict path
// is taken. So an upsert used to EDIT an automation raises
// automation_limit_reached whenever the org is at its cap, which would mean an
// org on a 10-flow plan with 10 flows could not edit any of them. Callers know
// whether it is new; they pick.
//
// The id is never regenerated either: it is the directory name for that
// automation's run artifacts under <userData>/AutomationRuns/, and a new id
// orphans the history.
export async function create(orgId: string, automation: ScoutAutomation): Promise<void> {
  const client = requireClient();
  const {error} = await client.from('automations').insert(automationToRow(orgId, automation));
  raise(error, 'automations.create');
}

// Writes every editable column of an existing row. `id` and `org_id` are
// stripped: they are the lookup keys, not fields to rewrite.
export async function replace(orgId: string, automation: ScoutAutomation): Promise<void> {
  const client = requireClient();
  const {id: _id, org_id: _orgId, ...row} = automationToRow(orgId, automation);
  const {error} = await client
      .from('automations')
      .update(row)
      .eq('org_id', orgId)
      .eq('id', automation.id);
  raise(error, 'automations.replace');
}

export async function save(
    orgId: string, automation: ScoutAutomation, exists: boolean): Promise<void> {
  return exists ? replace(orgId, automation) : create(orgId, automation);
}

// Only the keys present in `patch` are written, so toggling `pinned` from the
// list view cannot clobber a step edit someone else is saving.
export async function update(
    orgId: string, id: string, patch: Partial<ScoutAutomation>): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('automations')
      .update(automationPatchToRow(patch))
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'automations.update');
}

// Stamp the verdict of a finished run onto the automation row, so the card can
// show a status without reading the runs table. The guard makes this
// last-writer-safe against out-of-order arrivals: a disk-buffered run flushed
// after a restart, or two runs finishing seconds apart on two machines, only
// ever move last_run_at forward. RunStatus by construction -- callers pass
// run.status off a sealed record.
export async function recordRunOutcome(
    orgId: string, id: string, finishedAt: string, status: string): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('automations')
      .update({last_run_at: finishedAt, last_run_status: status})
      .eq('org_id', orgId)
      .eq('id', id)
      .or(`last_run_at.is.null,last_run_at.lt.${finishedAt}`);
  raise(error, 'automations.recordRunOutcome');
}

// Permanent delete. Reachable only from Trash -- Delete in the editor and over
// MCP both call softDelete now.
//
// profiles.automation_id is ON DELETE SET NULL, so this detaches the profiles
// pointing at it rather than cascading, and automation_runs keeps a
// denormalized automation_name so history stays readable afterwards.
export async function remove(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const {error} = await client
      .from('automations')
      .delete()
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'automations.remove');
}

// Trash. The same five statements profiles.ts has, against the same column, so
// TRASH_RETENTION_DAYS and the rest of src/lib/trash.ts apply unchanged.
//
// An automation used to be deleted outright, on the grounds that it is a
// document with nothing on disk to orphan. True, and beside the point: the
// steps in one are more work than a profile is, and this was the only thing in
// the app a user could destroy in two clicks and never get back.
export async function softDelete(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const now = new Date().toISOString();
  const {error} = await client
      .from('automations')
      .update({deleted_at: now, updated_at: now})
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'automations.softDelete');
}

// Restoring crosses the plan cap -- trg_automation_limit_restore fires on
// exactly this update, so it can raise automation_limit_reached. One statement
// for the whole set, so a bulk restore either all lands or none of it does.
export async function restore(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const {error} = await client
      .from('automations')
      .update({deleted_at: null, updated_at: new Date().toISOString()})
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'automations.restore');
}

// Empty Trash: everything with a deleted_at, whatever its age.
//
// Scoped by deleted_at rather than by an id list, which is what makes it safe
// to offer without selecting anything first -- there is no way for the
// statement to reach an automation that is not in Trash. Returns the ids
// removed so the caller can patch local state and report a count.
export async function purgeAll(orgId: string): Promise<string[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('automations')
      .delete()
      .eq('org_id', orgId)
      .not('deleted_at', 'is', null)
      .select('id');
  raise(error, 'automations.purgeAll');
  return ((data || []) as Array<{id: string}>).map((row) => row.id);
}

// The 30-day Trash expiry, as one statement instead of a filter-and-rewrite of
// the whole array. purge_expired_data does the same nightly for the org whose
// workspace nobody opens.
export async function purgeExpired(orgId: string, cutoffIso: string): Promise<string[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('automations')
      .delete()
      .eq('org_id', orgId)
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoffIso)
      .select('id');
  raise(error, 'automations.purgeExpired');
  return ((data || []) as Array<{id: string}>).map((row) => row.id);
}
