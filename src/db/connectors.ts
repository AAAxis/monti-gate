// The workspace's connectors: AI endpoints and messaging targets in one table.
//
// Ordinary org-scoped CRUD, with one wrinkle: `is_default` is backed by a
// partial unique index (one true per org PER CATEGORY), so promoting a
// connector is two statements and they have to run in the right order -- see
// setDefault.
import type {ScoutConnector} from '../types';
import {optionalClient, raise, requireClient} from './client';
import {connectorToRow, rowToConnector} from './mappers';
import type {ConnectorRow} from './rows';

// config is selected, secrets and all. It has to be: the renderer is what
// hands connectors to the main process, which is the only place that can make
// an outbound call, and a credential nobody can read is a connector nothing
// can run against. See the migration for why every member may read it and
// only owners may write.
const COLUMNS =
  'id,org_id,name,category,kind,config,is_default,created_by,created_at,updated_at';

export async function list(orgId: string): Promise<ScoutConnector[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('connectors')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('created_at', {ascending: true});
  raise(error, 'connectors.list');
  return ((data || []) as unknown as ConnectorRow[]).map(rowToConnector);
}

// Split rather than upserted, like automations and profiles. There is no
// BEFORE INSERT trigger on this table today, but the split costs nothing and
// the two callers already know which one they are.
export async function create(orgId: string, connector: ScoutConnector): Promise<void> {
  const client = requireClient();
  const {error} = await client.from('connectors').insert(connectorToRow(orgId, connector));
  raise(error, 'connectors.create');
}

export async function replace(orgId: string, connector: ScoutConnector): Promise<void> {
  const client = requireClient();
  const {id: _id, org_id: _orgId, ...row} = connectorToRow(orgId, connector);
  const {error} = await client
      .from('connectors')
      .update(row)
      .eq('org_id', orgId)
      .eq('id', connector.id);
  raise(error, 'connectors.replace');
}

export async function save(
    orgId: string, connector: ScoutConnector, exists: boolean): Promise<void> {
  return exists ? replace(orgId, connector) : create(orgId, connector);
}

// Demote everything in the category, then promote one. This order is not
// interchangeable: connectors_one_default_per_category is a unique index over
// the rows where is_default is true, so promoting first collides with the
// incumbent and the whole change fails. Demoting first leaves a brief window
// with no default, which is a state the app already handles -- a step naming
// no connector says so rather than guessing.
//
// Both statements filter on `category`: the index is per (org_id, category),
// and demoting across categories would silently un-default the other one --
// promoting a Telegram bot must not cost the workspace its default model.
export async function setDefault(orgId: string, category: string, id: string): Promise<void> {
  const client = requireClient();
  const cleared = await client
      .from('connectors')
      .update({is_default: false, updated_at: new Date().toISOString()})
      .eq('org_id', orgId)
      .eq('category', category)
      .eq('is_default', true);
  raise(cleared.error, 'connectors.setDefault');
  const {error} = await client
      .from('connectors')
      .update({is_default: true, updated_at: new Date().toISOString()})
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'connectors.setDefault');
}

// Hard delete. A connector is configuration, not an asset -- nothing on disk
// belongs to one.
//
// Steps referencing it by id are deliberately left alone rather than
// rewritten: there is no foreign key to follow (a step lives inside an
// automation's jsonb), and silently repointing every workflow at whatever
// connector remains would be a bigger surprise than a step that says the
// connector it names is gone.
export async function remove(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const {error} = await client
      .from('connectors')
      .delete()
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'connectors.remove');
}
