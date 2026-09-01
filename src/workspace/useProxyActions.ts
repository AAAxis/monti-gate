import * as db from '../db';
import {defaultProxyStatus} from '../data/statuses';
import {mapWithConcurrency} from '../lib/concurrency';
import {toCsv} from '../lib/csv';
import {defaultProxyName, matchedProxyForProfile} from '../lib/proxies';
import {native} from '../native';
import {newId} from './core';
import type {WorkspaceCore} from './core';
import type {ProxyCheckResult, ProxyConfig} from '../native';
import type {MontiProfile, MontiProxy} from '../types';

const NO_CHECKER = 'Native proxy checker is not available. Restart EasyDeck and try again.';

// How many checks run at once in a batch. Kept the same as the import dialog's
// limit, and for the same reason: each check is a curl with a 10s ceiling, so
// this is the difference between forty processes and five.
const CHECK_CONCURRENCY = 5;

export type ProxyActions = ReturnType<typeof useProxyActions>;

export function useProxyActions(
    {data, toast, beginProxyCheck, endProxyCheck}: WorkspaceCore) {
  const {state, withDb, withDbError, patch} = data;

  // Every proxy-check path (background loop, manual re-check, pre-launch check)
  // lands here. The write touches the six last_* columns only, so a check
  // completing while someone edits that proxy's credentials cannot undo the
  // edit. Explicit nulls matter: a proxy that just started working must clear
  // its stored error, and PostgREST drops undefined rather than nulling it.
  async function recordCheck(proxy: MontiProxy): Promise<boolean> {
    patch.proxies((list) => list.map((item) => item.id === proxy.id ? proxy : item));
    return withDb((activeOrgId) => db.proxies.recordCheck(activeOrgId, proxy.id, {
      country: proxy.country,
      country_code: proxy.country_code,
      timezone: proxy.timezone,
      city: proxy.city,
      region: proxy.region,
      latitude: proxy.latitude,
      longitude: proxy.longitude,
      egress_ip: proxy.egress_ip,
      ping_ms: proxy.ping_ms,
      checked_at: proxy.checked_at,
      check_error: proxy.check_error,
    }));
  }

  // Runs the native check and folds its result into the proxy row. Shared by
  // the background sweep, the pre-launch gate and the manual re-check, so all
  // three record failures the same way.
  async function runCheck(proxy: MontiProxy): Promise<MontiProxy> {
    const result = await native?.checkProxy?.(proxy);
    if (!result) {
      throw new Error(NO_CHECKER);
    }
    return {
      ...proxy,
      country: result.country,
      country_code: result.countryCode,
      timezone: result.timezone,
      city: result.city,
      region: result.region,
      latitude: result.latitude,
      longitude: result.longitude,
      egress_ip: result.ip,
      ping_ms: result.pingMs,
      checked_at: new Date().toISOString(),
      check_error: result.ok ? undefined : result.error || 'Proxy check failed',
    };
  }

  // A check against connection details that may not be saved yet -- the proxy
  // editor's "Test connection", which has to work before a row exists. The main
  // process check takes a bare host/port/credentials (the local HTTP API's
  // POST /v1/proxies/check already relies on that), so nothing here touches the
  // database: the caller decides whether the result is worth recording.
  //
  // Returns the failure rather than throwing so the dialog can render it inline
  // next to the fields that caused it, instead of in a toast that vanishes
  // while the user is still typing.
  async function testConnection(config: ProxyConfig): Promise<ProxyCheckResult> {
    if (!native?.checkProxy) {
      return {ok: false, error: NO_CHECKER};
    }
    try {
      return await native.checkProxy(config);
    } catch (error) {
      return {ok: false, error: error instanceof Error ? error.message : String(error)};
    }
  }

  // testConnection plus the "does this describe a saved row?" decision that
  // used to live in the proxy dialog. It moved here because the check now
  // outlives the dialog: closing the editor mid-test must still land the
  // country and ping on the card, and an unmounted component cannot do that.
  async function testConnectionAndRecord(
      config: ProxyConfig, proxyId?: string): Promise<ProxyCheckResult> {
    const result = await testConnection(config);
    const stored = proxyId ? state.proxies.find((item) => item.id === proxyId) : undefined;
    const describesStored = stored &&
      (stored.type || 'http') === config.type &&
      stored.host === config.host &&
      stored.port === config.port &&
      (stored.username || '') === (config.username || '') &&
      (stored.password || '') === (config.password || '');
    if (!stored || !describesStored) {
      return result;
    }
    // Failures are recorded too: a proxy that has stopped working should say so
    // on its card, which is exactly what the background sweep would write on
    // its next pass anyway.
    await recordCheck({
      ...stored,
      country: result.ok ? result.country : stored.country,
      country_code: result.ok ? result.countryCode : stored.country_code,
      egress_ip: result.ok ? result.ip : stored.egress_ip,
      ping_ms: result.pingMs,
      checked_at: new Date().toISOString(),
      check_error: result.ok ? undefined : result.error || 'Proxy check failed',
    });
    return result;
  }

  // Resolves the proxy a launch will actually use, checking it first if its
  // stored result is missing or stale. Returns null when the profile needs no
  // proxy, and 'blocked' when the launch must not happen -- the reason has
  // already been shown by then.
  //
  // spawnProfileUnchecked (main process) is the authoritative gate on every
  // launch regardless. This is the copy that runs where there is somewhere to
  // show a failure, and it skips re-checking a proxy already known-good.
  //
  // It lives here rather than in useProfileActions, where it was written,
  // because it is not only the Launch button's any more: an automation run
  // launches a profile too, and going straight to buildLaunchPayload is exactly
  // how that path ended up reporting a dead proxy as a dead run several seconds
  // later, in a sentence about a profile the user never picked.
  async function resolveForLaunch(
      profile: MontiProfile): Promise<MontiProxy | null | 'blocked'> {
    if ((profile.proxy_mode || 'assigned') !== 'assigned') {
      return null;
    }
    // matchedProxyForProfile, not a find on proxy_id: it carries the name-based
    // fallback that keeps an imported profile whose id never matched working,
    // and runReadiness resolves the proxy the same way so the Run dialog and
    // this gate cannot name two different rows.
    const assigned = matchedProxyForProfile(profile, state.proxies);
    if (!assigned?.host || !assigned.port) {
      toast.fail('Launch blocked',
          `Proxy for ${profile.name} is invalid. Fix host and port before launch.`);
      return 'blocked';
    }
    // The timezone is part of "checked", not a bonus: a row recorded before the
    // geolocation columns existed, or by a provider that answered without a
    // zone, looks perfectly healthy here and would launch with the profile
    // falling back to a country-wide guess. One extra round-trip the first time
    // such a row is launched is cheaper than a mismatched timezone, and once the
    // check lands the zone is stored and this short-circuits again.
    if (assigned.checked_at && !assigned.check_error && assigned.timezone) {
      return assigned;
    }
    if (!native?.checkProxy) {
      toast.fail('Launch blocked', NO_CHECKER);
      return 'blocked';
    }
    toast.setMessage(`Checking proxy for ${profile.name}`);
    beginProxyCheck(assigned.id);
    let checked: MontiProxy;
    try {
      checked = await runCheck(assigned);
      await recordCheck(checked);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.fail('Launch blocked', `Proxy for ${profile.name} failed its check: ${message}`);
      return 'blocked';
    } finally {
      endProxyCheck(assigned.id);
    }
    if (checked.check_error) {
      toast.fail('Launch blocked',
          `Proxy for ${profile.name} failed its check: ${checked.check_error}`);
      return 'blocked';
    }
    return checked;
  }

  // One proxy, checked because the user asked -- the per-row check button in the
  // Proxies and Profiles tables.
  //
  // Drives the shared checkingProxyIds set so the row it belongs to says
  // "Checking…" while it runs, and reports through a toast because the click that
  // started it may well have scrolled out of view by the time curl gives up ten
  // seconds later.
  async function checkOnce(proxy: MontiProxy) {
    if (!native?.checkProxy) {
      toast.setMessage(NO_CHECKER);
      return;
    }
    beginProxyCheck(proxy.id);
    try {
      const checked = await runCheck(proxy);
      if (!await recordCheck(checked)) {
        return;
      }
      const label = proxy.name || proxy.host;
      // The error goes in `detail` as well as the message: it is what the user
      // takes to their provider, and a banner that clears itself is no place to
      // leave the only copy of it.
      if (checked.check_error) {
        toast.notify(`${label} check failed · ${checked.check_error}`,
            {tone: 'fail', detail: checked.check_error});
      } else {
        toast.notify(
            `${label} checked · ${checked.country || checked.country_code || checked.egress_ip || 'OK'} · ${checked.ping_ms}ms`,
            {tone: 'ok'});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.notify(message, {tone: 'fail', detail: message});
    } finally {
      endProxyCheck(proxy.id);
    }
  }

  // A batch of proxies, checked concurrently so spotting the bad ones in a
  // library of forty is one action rather than forty.
  //
  // CHECK_CONCURRENCY rather than all-at-once for the reason the import dialog
  // uses the same number: each check is a curl with a 10s ceiling, and a hundred
  // of them at once is a hundred processes. Failures are counted rather than
  // toasted one by one -- the per-row chips carry which ones, and forty toasts
  // would bury the summary.
  //
  // `quiet` suppresses the summary for a sweep the user did not ask for -- the
  // one the Run dialog fires on open to freshen what it is about to show. The
  // per-row chips report it there, and a toast about work nobody requested,
  // arriving while they are still reading the list, is noise.
  async function checkMany(list: MontiProxy[], {quiet = false} = {}) {
    const targets = list.filter((proxy) => proxy.host && proxy.port);
    if (!targets.length) {
      if (!quiet) {
        toast.setMessage('No proxies to check.');
      }
      return;
    }
    if (!native?.checkProxy) {
      if (!quiet) {
        toast.setMessage(NO_CHECKER);
      }
      return;
    }
    targets.forEach((proxy) => beginProxyCheck(proxy.id));
    let failed = 0;
    await mapWithConcurrency(targets, CHECK_CONCURRENCY, async (proxy) => {
      try {
        const checked = await runCheck(proxy);
        await recordCheck(checked);
        if (checked.check_error) {
          failed++;
        }
      } catch (error) {
        failed++;
        // Recorded, not swallowed: a check that threw is a check that failed,
        // and the row has to say so rather than staying on its old result.
        await recordCheck({
          ...proxy,
          checked_at: new Date().toISOString(),
          check_error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        endProxyCheck(proxy.id);
      }
    });
    if (quiet) {
      return;
    }
    const passed = targets.length - failed;
    const noun = targets.length === 1 ? 'proxy' : 'proxies';
    // No `detail` on the batch: there are `failed` different errors and the
    // per-row chips are where each one is. Copying a summary line would hand
    // over the one text that names no proxy at all.
    toast.notify(failed ?
      `Checked ${targets.length} ${noun} · ${passed} passed, ${failed} failed` :
      `Checked ${targets.length} ${noun} · all passed`,
    {tone: failed ? 'fail' : 'ok'});
  }

  // Gives a batch of saved proxies one username and password.
  //
  // The fix for a library imported from a file that carried no credentials: the
  // proxies are already saved and already assigned to profiles, so updating them
  // in place fixes those profiles too -- where re-importing with credentials
  // would mint a second proxy per host and leave the profiles on the dead one.
  async function setCredentials(
      list: MontiProxy[], username: string, password: string): Promise<number> {
    let updated = 0;
    for (const proxy of list) {
      // Every check column cleared, not just the error: the stored result
      // describes the proxy as it was without a login, and a country left behind
      // with no timestamp reads as a check that passed.
      const next: MontiProxy = {
        ...proxy,
        username: username || undefined,
        password: password || undefined,
        country: undefined,
        country_code: undefined,
        timezone: undefined,
        city: undefined,
        region: undefined,
        latitude: undefined,
        longitude: undefined,
        egress_ip: undefined,
        ping_ms: undefined,
        checked_at: undefined,
        check_error: undefined,
      };
      if (await update(next)) {
        updated++;
      }
    }
    toast.setMessage(updated ?
      `Set credentials on ${updated} ${updated === 1 ? 'proxy' : 'proxies'} · check them to confirm` :
      'No proxies were updated');
    return updated;
  }

  // Renames one proxy from its table cell. A narrow write, never an upsert of
  // the row: a check completing mid-edit must survive the rename. An emptied
  // name falls back to host:port, the same fallback save() uses -- a proxy
  // with no name at all has no line to render in the pickers that offer it.
  async function rename(proxy: MontiProxy, name: string): Promise<boolean> {
    const next = name.trim() || defaultProxyName(proxy.host, proxy.port);
    if (next === proxy.name) {
      return true;
    }
    if (!await withDb((activeOrgId) => db.proxies.rename(activeOrgId, proxy.id, next))) {
      return false;
    }
    patch.proxies((list) => list.map((item) =>
      item.id === proxy.id ? {...item, name: next} : item));
    return true;
  }

  // Marks one proxy from its table cell. Narrow, for the reason rename above is
  // narrow. This is the user's own judgement about the proxy and is deliberately
  // never written by the checker: a proxy that fails a check says so in its
  // check cell, and having the sweep also flip the label to "Dead" would erase
  // whatever the user had put there.
  async function setStatus(proxy: MontiProxy, status: string): Promise<boolean> {
    if (status === (proxy.status || defaultProxyStatus)) {
      return true;
    }
    if (!await withDb((activeOrgId) => db.proxies.setStatus(activeOrgId, proxy.id, status))) {
      return false;
    }
    patch.proxies((list) => list.map((item) =>
      item.id === proxy.id ? {...item, status} : item));
    return true;
  }

  // Patches connection fields from a table cell -- type, host, port,
  // credentials. The db write clears the six last_* columns in the same
  // statement (a changed connection invalidates the stored check), so the
  // local patch clears them too and the row reads "Not checked" until the
  // background sweep gets to it.
  async function setConnection(
      proxy: MontiProxy, connectionPatch: db.proxies.ProxyConnectionPatch): Promise<boolean> {
    const next = {
      type: connectionPatch.type ?? proxy.type ?? 'http',
      host: connectionPatch.host ?? proxy.host,
      port: connectionPatch.port ?? proxy.port,
      username: connectionPatch.username === undefined ?
        proxy.username : connectionPatch.username || undefined,
      password: connectionPatch.password === undefined ?
        proxy.password : connectionPatch.password || undefined,
    };
    // The same predicate save() uses, credentials compared through ||'' so
    // "absent" and "empty" are one value. An unchanged connection writes
    // nothing -- clearing a valid check over a no-op edit would send the
    // sweep after a proxy nothing happened to.
    const unchanged =
      (proxy.type || 'http') === next.type &&
      proxy.host === next.host &&
      proxy.port === next.port &&
      (proxy.username || '') === (next.username || '') &&
      (proxy.password || '') === (next.password || '');
    if (unchanged) {
      return true;
    }
    if (!await withDb((activeOrgId) =>
      db.proxies.updateConnection(activeOrgId, proxy.id, connectionPatch))) {
      return false;
    }
    patch.proxies((list) => list.map((item) => item.id === proxy.id ? {
      ...item,
      ...next,
      country: undefined,
      country_code: undefined,
      timezone: undefined,
      city: undefined,
      region: undefined,
      latitude: undefined,
      longitude: undefined,
      egress_ip: undefined,
      ping_ms: undefined,
      checked_at: undefined,
      check_error: undefined,
    } : item));
    return true;
  }

  // Returns the failure text rather than toasting it: the only caller is the
  // proxy dialog, which renders it inline next to the fields. A toast for this
  // was worse than useless -- it rendered underneath the dialog's own scrim,
  // so a rejected save looked like a dead button.
  async function save(draft: {
    id?: string;
    name: string;
    type: 'http' | 'socks5';
    host: string;
    port: number;
    username?: string;
    password?: string;
  }): Promise<{proxy: MontiProxy; error?: undefined} | {proxy?: undefined; error: string}> {
    const existing = state.proxies.find((item) => item.id === draft.id);
    const connectionUnchanged = existing &&
      existing.type === draft.type &&
      existing.host === draft.host &&
      existing.port === draft.port &&
      (existing.username || '') === (draft.username || '') &&
      (existing.password || '') === (draft.password || '');
    const proxy: MontiProxy = {
      // When the connection details changed, the six last_* columns are written
      // as explicit nulls by proxyToRow -- the stored check result no longer
      // describes this proxy, and the background loop will re-check it.
      ...(connectionUnchanged ? {
        country: existing.country,
        country_code: existing.country_code,
        egress_ip: existing.egress_ip,
        ping_ms: existing.ping_ms,
        checked_at: existing.checked_at,
        check_error: existing.check_error,
      } : {}),
      id: draft.id || newId(),
      name: draft.name || defaultProxyName(draft.host, draft.port),
      // Carried through explicitly. The draft has no folder field -- filing is
      // done from the table, not from the editor -- and this builds a whole
      // fresh row, so without this line saving a password change would quietly
      // drop the proxy back into "All proxies".
      folder_id: existing?.folder_id ?? null,
      type: draft.type,
      host: draft.host,
      port: draft.port,
      username: draft.username || undefined,
      password: draft.password || undefined,
    };
    const isExisting = Boolean(draft.id) && state.proxies.some((item) => item.id === proxy.id);
    const error = await withDbError((activeOrgId) => db.proxies.upsert(activeOrgId, proxy));
    if (error) {
      return {error};
    }
    patch.proxies((list) => isExisting ?
      list.map((item) => item.id === proxy.id ? proxy : item) :
      [...list, proxy]);
    return {proxy};
  }

  // Bulk-adds parsed list rows in one pass. Rows are written one at a time
  // rather than as a single upsert so that one bad row -- a host the database
  // rejects -- costs that row instead of the whole file.
  //
  // Nothing is checked here: importing 200 proxies would mean 200 concurrent
  // curl runs. The rows land unchecked, and useBackgroundProxyChecks already
  // sweeps exactly those, filling in country and ping a few at a time.
  async function importList(entries: Array<Omit<MontiProxy, 'id'>>): Promise<{
    created: number;
    failed: Array<{name: string; error: string}>;
  }> {
    const created: MontiProxy[] = [];
    const failed: Array<{name: string; error: string}> = [];
    for (const entry of entries) {
      const proxy: MontiProxy = {...entry, id: newId()};
      const error = await withDbError((activeOrgId) => db.proxies.upsert(activeOrgId, proxy));
      if (error) {
        failed.push({name: proxy.name || proxy.host, error});
        continue;
      }
      created.push(proxy);
    }
    if (created.length) {
      patch.proxies((list) => [...list, ...created]);
    }
    return {created: created.length, failed};
  }

  // Files proxies under a folder, or back under "All proxies" with null. One
  // narrow update per proxy rather than a bulk upsert, so a proxy check landing
  // mid-loop cannot be undone by a row that was rewritten wholesale.
  async function assignToFolder(proxyIds: string[], folderId: string | null): Promise<boolean> {
    const ok = await withDb(async (activeOrgId) => {
      for (const id of proxyIds) {
        await db.proxies.assignFolder(activeOrgId, id, folderId);
      }
    });
    if (!ok) {
      return false;
    }
    patch.proxies((list) => list.map((proxy) =>
      proxyIds.includes(proxy.id) ? {...proxy, folder_id: folderId} : proxy));
    return true;
  }

  async function create(proxy: MontiProxy): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.proxies.upsert(activeOrgId, proxy))) {
      return false;
    }
    patch.proxies((list) => [...list, proxy]);
    return true;
  }

  async function update(proxy: MontiProxy): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.proxies.upsert(activeOrgId, proxy))) {
      return false;
    }
    patch.proxies((list) => list.map((item) => item.id === proxy.id ? proxy : item));
    return true;
  }

  // The FK on profiles.proxy_id is ON DELETE SET NULL, so the assigned profiles
  // are cleared by the same statement; the local patch only mirrors it.
  async function remove(proxyIds: string[]): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.proxies.remove(activeOrgId, proxyIds))) {
      return false;
    }
    patch.proxies((list) => list.filter((item) => !proxyIds.includes(item.id)));
    patch.profiles((list) => list.map((profile) =>
      profile.proxy_id && proxyIds.includes(profile.proxy_id) ?
        {...profile, proxy_id: null} :
        profile));
    return true;
  }

  async function exportToCsv(list: MontiProxy[]) {
    if (!list.length) {
      return;
    }
    if (!native?.saveTextFile) {
      toast.setMessage('Native file export is not available. Restart EasyDeck and try again.');
      return;
    }
    const header = [
      'name', 'status', 'type', 'host', 'port', 'username', 'password', 'country', 'country_code',
      'folder',
    ];
    const csv = toCsv(header, list, (proxy) => {
      const row = proxy as unknown as Record<string, unknown>;
      // `folder` is not a field on the proxy -- the row holds a folder id, and
      // an id in an exported spreadsheet is noise. `status` is a field, but an
      // unset one has to export as the label the table draws rather than as a
      // blank, or a sheet sorted by status would file every unmarked proxy
      // under nothing while the app files it under Ready.
      const folderName = state.proxy_folders.find((folder) =>
        folder.id === proxy.folder_id)?.name || '';
      return Object.fromEntries(header.map((key) => {
        if (key === 'folder') {
          return [key, folderName];
        }
        if (key === 'status') {
          return [key, proxy.status || defaultProxyStatus];
        }
        return [key, String(row[key] ?? '')];
      }));
    });
    const savedPath = await native.saveTextFile(`monti-proxies-${Date.now()}.csv`, csv);
    if (savedPath) {
      toast.setMessage(`Exported ${list.length} ${list.length === 1 ? 'proxy' : 'proxies'} to ${savedPath.split('/').pop()}`);
    }
  }

  return {
    recordCheck, runCheck, checkOnce, checkMany, setCredentials, resolveForLaunch,
    testConnection, testConnectionAndRecord,
    save, create, update, remove, rename, setStatus, setConnection, assignToFolder, importList,
    exportToCsv,
  };
}
