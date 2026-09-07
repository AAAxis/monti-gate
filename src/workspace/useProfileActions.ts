import * as db from '../db';
import {toCsv} from '../lib/csv';
import {buildLaunchPayload} from '../lib/launch';
import {cloudCookieFromSelection} from '../lib/cookieUpload';
import {matchedProxyForProfile} from '../lib/proxies';
import {resolveCallTree} from '../automations/callGraph';
import {
  describeMissingParams, resolveRunVars, secretVarNames,
} from '../automations/parameters';
import {buildRunTile} from '../lib/runTile';
import {startPageAutomations} from '../lib/startPageAutomations';
import {native} from '../native';
import {fingerprintFromDraftPatch} from '../drafts';
import {randomFingerprintPatch} from '../lib/fingerprintPresets';
import {importColumns} from '../data/importTemplate';
import {planCsvImport, previewCsvImport, profileExportRow} from './csvImport';
import type {
  FolderDecision, ImportLibrary, ImportResult, ImportRow,
} from './csvImport';
import type {ParsedCsvRow} from '../lib/csv';
import type {ProxyActions} from './useProxyActions';
import type {WorkspaceCore} from './core';
import type {CookieImportFields} from '../lib/cookieUpload';
import type {MontiFolder, MontiProfile, MontiProxy} from '../types';

export type ProfileActions = ReturnType<typeof useProfileActions>;

export function useProfileActions(
    {data, toast, selectedProfileId, setSelectedProfileId, beginProxyCheck, endProxyCheck}: WorkspaceCore,
    proxies: ProxyActions) {
  const {state, setState, withDb, withDbError, patch} = data;

  function proxyFor(profile: MontiProfile) {
    return matchedProxyForProfile(profile, state.proxies);
  }

  function folderFor(profile: MontiProfile) {
    return state.folders.find((folder) => folder.id === profile.folder_id) || null;
  }

  // withDb surfaces the real error via the toast on failure; this used to give
  // no feedback either way, so a failed save (e.g. a status change) looked
  // identical to a successful one -- the change would show locally but silently
  // never reach the cloud, then vanish on another machine's next fresh load.
  async function update(profile: MontiProfile, fields: Partial<MontiProfile>): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.profiles.update(activeOrgId, profile.id, fields))) {
      return false;
    }
    patch.profiles((list) => list.map((item) =>
      item.id === profile.id ? {...item, ...fields} : item));
    return true;
  }

  // One row, keyed on the profile's own id -- which stays exactly what it was,
  // because it is also the E:\MontiProfiles\<id> directory name. Create and
  // edit are separate statements on purpose (see db/profiles.ts): only the
  // create path should be able to raise profile_limit_reached.
  async function save(profile: MontiProfile): Promise<boolean> {
    const isExisting = state.profiles.some((item) => item.id === profile.id);
    if (!await withDb((activeOrgId) => db.profiles.save(activeOrgId, profile, isExisting))) {
      return false;
    }
    patch.profiles((list) => isExisting ?
      list.map((item) => item.id === profile.id ? profile : item) :
      [...list, profile]);
    setSelectedProfileId(profile.id);
    return true;
  }

  // The API's create path. Hands the failure text back instead of toasting it,
  // because the caller turns it into a 400 the agent can read. A plain INSERT
  // with no exists probe -- this is the only path that should be able to raise
  // profile_limit_reached, and it must never fall back to save()'s upsertish
  // behaviour (see db/profiles.ts).
  async function create(profile: MontiProfile): Promise<string | null> {
    const error = await withDbError((activeOrgId) => db.profiles.create(activeOrgId, profile));
    if (error) {
      return error;
    }
    patch.profiles((list) => [...list, profile]);
    return null;
  }

  // Puts a picture in Storage and hands back its URL. Deliberately not withDb:
  // this writes no row, it only produces the value the editor's draft carries
  // until the user presses Save, so a picture uploaded and then cancelled
  // leaves the profile exactly as it was. It throws rather than toasting,
  // because the caller has to know not to set the draft.
  async function uploadAvatar(profileId: string, file: File): Promise<string> {
    if (!data.orgId) {
      throw new Error('Sign in before uploading a picture.');
    }
    return db.profiles.uploadAvatar(data.orgId, profileId, file);
  }

  // A proxy is offered for "also delete" only when every profile assigned to
  // it is in the set being deleted -- otherwise removing it would silently
  // break a surviving profile's launch.
  function exclusiveProxyIdsFor(profileIds: string[]): string[] {
    const deletingIds = new Set(profileIds);
    const assigned = new Set(
      state.profiles
          .filter((profile) => deletingIds.has(profile.id) && profile.proxy_id)
          .map((profile) => profile.proxy_id as string));
    return [...assigned].filter((proxyId) =>
      !state.profiles.some((profile) =>
        !deletingIds.has(profile.id) && profile.proxy_id === proxyId));
  }

  // One UPDATE stamping deleted_at on these ids, and nothing else. The old path
  // re-read the whole profiles array from the server first, because it was
  // about to rewrite all of it; there is nothing left to be stale about.
  async function softDelete(profileIds: string[], alsoDeleteProxyIds: string[] = []): Promise<boolean> {
    const deletedAt = new Date().toISOString();
    const ok = await withDb(async (activeOrgId) => {
      await db.profiles.softDelete(activeOrgId, profileIds);
      if (alsoDeleteProxyIds.length) {
        await db.proxies.remove(activeOrgId, alsoDeleteProxyIds);
      }
    });
    if (!ok) {
      return false;
    }
    const profiles = state.profiles.map((item) =>
      profileIds.includes(item.id) ? {...item, deleted_at: deletedAt} : item);
    patch.profiles(() => profiles);
    if (alsoDeleteProxyIds.length) {
      // The proxies FK is ON DELETE SET NULL, so the affected profiles lose
      // their proxy_id server-side; mirror that locally.
      patch.proxies((list) => list.filter((proxy) => !alsoDeleteProxyIds.includes(proxy.id)));
      patch.profiles((list) => list.map((item) =>
        item.proxy_id && alsoDeleteProxyIds.includes(item.proxy_id) ?
          {...item, proxy_id: null} :
          item));
    }
    if (selectedProfileId && profileIds.includes(selectedProfileId)) {
      setSelectedProfileId(profiles.find((item) => !item.deleted_at)?.id || null);
    }
    return true;
  }

  // Restoring crosses the profile limit as much as creating does, so
  // trg_profile_limit_restore fires on exactly this update and can refuse it.
  // A bulk restore is one statement, so it either all lands or none of it does.
  async function restore(profileIds: string[]): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.profiles.restore(activeOrgId, profileIds))) {
      return false;
    }
    patch.profiles((list) => list.map((item) =>
      profileIds.includes(item.id) ? {...item, deleted_at: null} : item));
    return true;
  }

  async function purge(profileIds: string[]): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.profiles.purge(activeOrgId, profileIds))) {
      return false;
    }
    patch.profiles((list) => list.filter((item) => !profileIds.includes(item.id)));
    return true;
  }

  // Empty Trash. The local patch drops every trashed row rather than the ids the
  // statement returned: those are the same set, and filtering on deleted_at keeps
  // the two sides describing Trash the same way.
  async function purgeAll(): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.profiles.purgeAll(activeOrgId))) {
      return false;
    }
    patch.profiles((list) => list.filter((item) => !item.deleted_at));
    return true;
  }

  async function assignToFolder(profileIds: string[], folderId: string | null): Promise<boolean> {
    const ok = await withDb(async (activeOrgId) => {
      for (const id of profileIds) {
        await db.profiles.update(activeOrgId, id, {folder_id: folderId});
      }
    });
    if (!ok) {
      return false;
    }
    patch.profiles((list) => list.map((profile) =>
      profileIds.includes(profile.id) ? {...profile, folder_id: folderId} : profile));
    return true;
  }

  // The pre-launch proxy gate now lives in useProxyActions as
  // `resolveForLaunch`. It moved because an automation run launches a profile
  // too and needs the same gate, and a second copy over there is how the two
  // would drift.

  // Rotate-on-launch profiles get a fresh identity persisted before the browser
  // starts, so the fingerprint the browser applies is the one that was saved.
  async function withRotatedFingerprint(profile: MontiProfile): Promise<MontiProfile> {
    if (!profile.fingerprint?.rotate_on_launch) {
      return profile;
    }
    const rotated = fingerprintFromDraftPatch(randomFingerprintPatch(profile.fingerprint?.os || ''));
    const next: MontiProfile = {
      ...profile,
      fingerprint: {...profile.fingerprint, ...rotated, rotate_on_launch: true},
    };
    await withDb((activeOrgId) =>
      db.profiles.update(activeOrgId, profile.id, {fingerprint: next.fingerprint}));
    patch.profiles((list) => list.map((item) => item.id === profile.id ? next : item));
    return next;
  }

  async function launch(profile: MontiProfile) {
    if (!native) {
      toast.setMessage('Native launcher bridge is not available');
      return;
    }
    try {
      const target = await withRotatedFingerprint(profile);
      const proxy = await proxies.resolveForLaunch(target);
      if (proxy === 'blocked') {
        return;
      }
      // Without this message the main process's own re-check is invisible:
      // several seconds of silence between clicking Launch and either the
      // window opening or an error dialog.
      toast.setMessage(`Launching ${target.name}`);

      // A profile keeps its automation_id while the automation is in Trash, so
      // that restoring is lossless -- which means the launch path is where
      // "trashed" has to mean "does not run".
      const attached = target.automation_id ?
        state.automations.find(
            (item) => item.id === target.automation_id && !item.deleted_at) :
        null;
      // What this launch's start page will offer as tiles: the attached
      // automation plus every pinned one. Computed before the port decision
      // because it is what makes the decision -- buildLaunchPayload derives the
      // same list from the same function, so the tiles and the port behind them
      // cannot disagree.
      // Each tile carries its resolved call tree into the run token: a
      // start-page run starts in the main process (runFromPage), which has no
      // catalogue to resolve callAutomation references against. A tile whose
      // tree has problems ships without one and the run refuses with a
      // sentence naming the missing callee.
      // Each tile also carries this profile's answers to the automation's
      // parameters, resolved here for the same reason the call tree is: the run
      // starts in the main process, which can see neither the declarations nor
      // the profile's stored values. A tile the profile cannot satisfy ships
      // with the sentence saying so, and the run route refuses with it rather
      // than opening a browser that fails on an unresolved {{vars.x}}.
      // buildRunTile does both resolutions, and is shared with the side panel's
      // run-any route so a workflow run from inside the browser resolves
      // exactly the way one run from here does.
      const tiles = startPageAutomations(state.automations, target)
          .map((tile) => buildRunTile(tile, target, state.automations));

      // The Scout Web Helper panel offers EVERY automation in the workspace, not
      // just this profile's pinned tiles -- that is what
      // /v1/automations/run-any-from-page is for, and the panel resolves the
      // chosen one through the launcher window on demand.
      //
      // So the panel is a run button too, and it needs the same port. Without
      // this the panel listed the whole catalogue on a profile that had pinned
      // nothing, and pressing any of it got "This session has no debugging
      // port" from startTileForEntry -- the phantom control the note below is
      // about, just reached by a different door.
      const panelCanRun = state.automations.some((item) => !item.deleted_at);

      // The debugging port is opened ONLY when something might drive this
      // session. An always-on --remote-debugging-port would be a real
      // anti-detect regression: the port is connectable by any local process,
      // and CDP attachment is observable from the page. Having an automation
      // the browser can offer to run is the opt-in -- pinned to the start page,
      // or listed in the panel. A workspace with no automations at all, and
      // nothing attached, still launches exactly as it did before, with no
      // extra switches.
      //
      // No --remote-allow-origins either. It used to be '*' here, which let any
      // web page in any browser on this machine drive an open profile if it
      // found the port. Our clients all connect from Node through
      // electron/cdp-core.cjs and send no Origin, which Chromium accepts.
      const cdpPort = attached || tiles.length > 0 || panelCanRun ?
        await native.reserveCdpPort?.() :
        undefined;
      const extraArgs = cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [];

      // Minted on every launch, not only when there are tiles: the page needs a
      // credential to re-check its own proxy, which is the one thing it can do
      // with no automations at all. A token whose automation list is empty
      // authorizes exactly that and nothing else -- authorize() looks every
      // requested id up in the list, and an empty list matches none.
      const runToken = await native.mintRunToken?.(
          target.id, target.name, data.orgId || '', cdpPort ?? null, tiles) || '';
      // The port comes from the running server rather than a second copy of the
      // constant: AUTOMATION_API_PORT lives in main.cjs, and a hardcoded 39219
      // here would be one more place to get wrong if it ever moves.
      const apiPort = runToken ? (await native.getApiStatus?.())?.port : 0;
      const startPage = runToken && apiPort ? {port: apiPort, token: runToken} : null;

      const result = await native.launchProfile(
          buildLaunchPayload(target, proxy, state, startPage), extraArgs);
      if (result.ok) {
        toast.setMessage(`Launched ${target.name}`);
        if (attached && cdpPort) {
          // Deliberately not awaited: a run is minutes long and the Launch
          // button must not sit spinning for it. Failures surface as a toast
          // and as a `failed` row in the history, never as a stuck button.
          //
          // The run is started here rather than through automations.run()
          // because the profile is already open -- run() would resolve the
          // session first and, finding the port still binding, report a window
          // that is opening as "not open". Persistence is unaffected: the
          // record is written by whoever is listening to run events, which is
          // useAutomationRuns regardless of who started it.
          void (async () => {
            const ready = await native.waitForCdp?.(cdpPort, 20000);
            if (!ready?.ok || !ready.cdpUrl) {
              toast.fail(`Couldn't run ${attached.name}`,
                  ready?.error || 'The browser never answered on its debugging port.');
              return;
            }
            // callAutomation references resolved here, like every other path
            // that hands an automation to the runner -- main has no catalogue.
            const tree = resolveCallTree(attached, state.automations);
            if (tree.problems.length > 0) {
              toast.fail(`Couldn't run ${attached.name}`, tree.problems.join(' '));
              return;
            }
            const calleeParameters = Object.keys(tree.resolved).map((id) =>
              state.automations.find((entry) => entry.id === id)?.parameters || []);
            const vars = resolveRunVars({
              parameters: attached.parameters,
              calleeParameters,
              profileValues: target.automation_vars?.[attached.id],
            });
            // The browser is already open and stays open -- the profile is
            // fine, the automation is not. Only the run is abandoned, and it is
            // abandoned before a record exists rather than after a step fails
            // on an unresolved {{vars.x}} inside a window nobody is watching.
            const missing = describeMissingParams(attached.parameters, vars);
            if (missing) {
              toast.fail(`Couldn't run ${attached.name}`,
                  `${target.name} ${missing}. Set it in the profile's Launch section.`);
              return;
            }
            const started = await native.startAutomationRun?.({
              automation: attached,
              profile: target,
              trigger: 'launch',
              cdpUrl: ready.cdpUrl,
              vars,
              resolvedAutomations:
                Object.keys(tree.resolved).length > 0 ? tree.resolved : undefined,
              secretVarNames: secretVarNames(attached.parameters, ...calleeParameters),
            });
            if (started && !started.ok) {
              toast.fail(`Couldn't run ${attached.name}`, started.error || 'The run did not start.');
            }
          })();
        }
      } else {
        toast.fail(`Couldn't launch ${target.name}`,
            result.error || 'Launch failed for an unknown reason.');
      }
    } catch (error) {
      toast.fail(`Couldn't launch ${profile.name}`,
          error instanceof Error ? error.message : String(error));
    }
  }

  async function exportToCsv(list: MontiProfile[]) {
    if (!list.length) {
      return;
    }
    if (!native?.saveTextFile) {
      toast.setMessage('Native file export is not available. Restart Scout Web and try again.');
      return;
    }
    // The importer's own column names, in the importer's own value formats, so
    // an exported file can be fed straight back in -- see profileExportRow.
    const header = importColumns.map((column) => column.name);
    const csv = toCsv(header, list, (profile) =>
      profileExportRow(profile, proxyFor(profile), folderFor(profile)));
    const savedPath = await native.saveTextFile(`monti-profiles-${Date.now()}.csv`, csv);
    if (savedPath) {
      toast.setMessage(`Exported ${list.length} ${list.length === 1 ? 'profile' : 'profiles'} to ${savedPath.split('/').pop()}`);
    }
  }

  // Shared by the "Import cookies" button (folder picked via native dialog,
  // targetProfileIds = the checked selection) and the local automation API
  // (POST /v1/cookies/bulk-match, targetProfileIds = null meaning "every
  // profile"). Matches by name against files in `folderPath`, same as the
  // Dolphin-export naming convention (dolphin-anty-cookies-<Name>-<id>.txt).
  async function matchCookies(
      folderPath: string,
      targetProfileIds: string[] | null): Promise<{matched: number; total: number}> {
    if (!native?.matchCookieFiles) {
      throw new Error('Native cookie import is not available. Restart Scout Web and try again.');
    }
    const targetIds = targetProfileIds ? new Set(targetProfileIds) : null;
    const isTarget = (profile: MontiProfile) =>
      !profile.deleted_at && (!targetIds || targetIds.has(profile.id));
    const selected = state.profiles.filter(isTarget);
    const matches = await native.matchCookieFiles(folderPath, selected.map((profile) => profile.name));
    const cookiePatches = new Map<string, CookieImportFields>();
    for (const profile of selected) {
      const match = matches[profile.name];
      if (!match) {
        continue;
      }
      cookiePatches.set(profile.id,
          await cloudCookieFromSelection(profile.id, match, profile.cookie_import_url));
    }
    // One update per profile that actually matched a cookie file; the ones that
    // did not match are never rewritten.
    const ok = await withDb(async (activeOrgId) => {
      for (const [profileId, fields] of cookiePatches) {
        await db.profiles.update(activeOrgId, profileId, fields);
      }
    });
    if (!ok) {
      throw new Error('Failed to save matched cookies to cloud state.');
    }
    patch.profiles((list) => list.map((profile) => {
      const fields = isTarget(profile) ? cookiePatches.get(profile.id) : undefined;
      return fields ? {...profile, ...fields} : profile;
    }));
    return {matched: cookiePatches.size, total: selected.length};
  }

  function importLibrary(): ImportLibrary {
    return {profiles: state.profiles, proxies: state.proxies, folders: state.folders};
  }

  // Reads the file without writing anything, so the dialog can show it as a
  // table and let the user fix it first.
  function previewImport(parsed: ParsedCsvRow[]) {
    return previewCsvImport(parsed, importLibrary());
  }

  async function importFromCsv(
      rows: ImportRow[], folderDecision: FolderDecision): Promise<ImportResult> {
    const plan = planCsvImport(rows, folderDecision, importLibrary());
    // FK order: a profile cannot reference a folder or proxy that is not there
    // yet. Unlike the single blob write this replaces, these are separate
    // statements -- if the org hits its profile limit partway through, the rows
    // written before that point stay written.
    const writtenFolders: string[] = [];
    const writtenProxies: string[] = [];
    const writtenProfiles: string[] = [];
    // Separate from writtenProfiles, which also holds the rows this import
    // merely updated. The caller assigns what it created and leaves the rest
    // with whoever already holds them.
    const createdProfiles: string[] = [];
    const ok = await withDb(async (activeOrgId) => {
      for (const folder of plan.newFolders) {
        await db.folders.create(activeOrgId, folder);
        writtenFolders.push(folder.id);
      }
      for (const proxy of plan.upsertProxies) {
        await db.proxies.upsert(activeOrgId, proxy);
        writtenProxies.push(proxy.id);
      }
      for (const {profile, exists} of plan.touchedProfiles) {
        await db.profiles.save(activeOrgId, profile, exists);
        writtenProfiles.push(profile.id);
        if (!exists) {
          createdProfiles.push(profile.id);
        }
      }
    });
    // Only what actually reached the database goes into local state. Folders
    // and proxies used to be set unconditionally, so a failed write still left
    // them on screen until the next reload.
    const landed = (id: string, written: string[], current: {id: string}[]) =>
      written.includes(id) || current.some((item) => item.id === id);
    setState((current) => ({
      ...current,
      folders: plan.folders.filter((folder) => landed(folder.id, writtenFolders, current.folders)),
      proxies: plan.proxies.filter((proxy) => landed(proxy.id, writtenProxies, current.proxies)),
      profiles: plan.profiles.filter((profile) =>
        landed(profile.id, writtenProfiles, current.profiles)),
    }));
    // Returned even when the write failed partway. Returning null meant the
    // dialog showed no summary at all for an import that had already created
    // rows, which is the one case the summary is most needed.
    // createdIds carries what actually landed, not what was planned -- so a
    // write that stopped partway hands back only the ids that really exist.
    return ok ?
      {...plan.result, createdIds: createdProfiles} :
      {...plan.result, createdIds: createdProfiles, partial: true};
  }

  return {
    proxyFor,
    folderFor,
    update,
    save,
    create,
    uploadAvatar,
    exclusiveProxyIdsFor,
    softDelete,
    restore,
    purge,
    purgeAll,
    assignToFolder,
    launch,
    exportToCsv,
    matchCookies,
    previewImport,
    importFromCsv,
  };
}

// Re-exported so the import dialog keeps one place to import these from.
export type {FolderDecision, ImportPreview, ImportResult, ImportRow} from './csvImport';
