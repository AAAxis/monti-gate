import type {ScoutProxy} from '../types';
import {optionalClient, raise, requireClient} from './client';
import {proxyToRow, rowToProxy} from './mappers';
import type {ProxyRow} from './rows';

const COLUMNS =
  'id,org_id,name,status,type,host,port,username,password,folder_id,last_checked_at,last_ip,' +
  'last_country,last_latency_ms,created_at,last_country_code,last_error,assigned_to,' +
  'last_timezone,last_city,last_region,last_latitude,last_longitude,created_by';

export async function list(orgId: string): Promise<ScoutProxy[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('proxies')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('created_at', {ascending: true});
  raise(error, 'proxies.list');
  return ((data || []) as unknown as ProxyRow[]).map(rowToProxy);
}

export async function upsert(orgId: string, proxy: ScoutProxy): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('proxies')
      .upsert(proxyToRow(orgId, proxy), {onConflict: 'id'});
  raise(error, 'proxies.upsert');
}

// Profiles referencing this proxy are set to proxy_id = null by the FK's
// ON DELETE SET NULL, so the caller only has to mirror that locally.
export async function remove(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const {error} = await client
      .from('proxies')
      .delete()
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'proxies.remove');
}

// Files one proxy under a folder, or back under "All proxies" with null.
//
// A narrow update rather than an upsert of the whole row, for the same reason
// recordCheck below is one: filing a proxy while someone else edits its
// credentials -- or while the background sweep records a check -- must touch
// the one column it means to.
export async function assignFolder(
    orgId: string, id: string, folderId: string | null): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('proxies')
      .update({folder_id: folderId})
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'proxies.assignFolder');
}

// Renames one proxy. Narrow for the same reason assignFolder is: the name is
// edited inline in the table, and a rename must not carry a stale copy of the
// row over a check that landed meanwhile.
export async function rename(orgId: string, id: string, name: string): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('proxies')
      .update({name})
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'proxies.rename');
}

// Marks one proxy with a status. Narrow for the same reason rename is -- this
// is edited inline in the table, and marking a proxy "Dead" must not carry a
// stale copy of the row over a check the background sweep just recorded.
export async function setStatus(orgId: string, id: string, status: string): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('proxies')
      .update({status})
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'proxies.setStatus');
}

// The connection fields a table cell can edit. Credentials take null to mean
// "remove" -- PostgREST drops undefined rather than nulling it.
export type ProxyConnectionPatch = {
  type?: 'http' | 'socks5';
  host?: string;
  port?: number;
  username?: string | null;
  password?: string | null;
};

// Patches connection details and, in the same statement, clears every last_*
// column: the stored check result describes the proxy as it was before the
// edit, and a country left behind with no timestamp reads as a check that
// passed. The background sweep re-checks the row exactly because these are
// null. The geolocation columns clear with the rest -- a new host or credential
// set can mean a new exit country, and a stale timezone is worse than none,
// since it is what every launched profile would report to the sites it visits.
export async function updateConnection(
    orgId: string, id: string, patch: ProxyConnectionPatch): Promise<void> {
  const client = requireClient();
  const fields: Record<string, unknown> = {
    last_country: null,
    last_country_code: null,
    last_ip: null,
    last_latency_ms: null,
    last_checked_at: null,
    last_error: null,
    last_timezone: null,
    last_city: null,
    last_region: null,
    last_latitude: null,
    last_longitude: null,
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  const {error} = await client
      .from('proxies')
      .update(fields)
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'proxies.updateConnection');
}

// The result of a proxy check -- the background loop's only write. Kept
// separate from upsert() so a check landing while someone edits the proxy's
// credentials touches only the five check columns.
export type ProxyCheckResult = {
  country?: string;
  country_code?: string;
  timezone?: string;
  city?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  egress_ip?: string;
  ping_ms?: number;
  checked_at?: string;
  check_error?: string;
};

export async function recordCheck(
    orgId: string, id: string, result: ProxyCheckResult): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('proxies')
      .update({
        last_country: result.country ?? null,
        last_country_code: result.country_code ?? null,
        last_timezone: result.timezone ?? null,
        last_city: result.city ?? null,
        last_region: result.region ?? null,
        last_latitude: result.latitude ?? null,
        last_longitude: result.longitude ?? null,
        last_ip: result.egress_ip ?? null,
        last_latency_ms: result.ping_ms ?? null,
        last_checked_at: result.checked_at ?? null,
        last_error: result.check_error ?? null,
      })
      .eq('org_id', orgId)
      .eq('id', id);
  raise(error, 'proxies.recordCheck');
}
