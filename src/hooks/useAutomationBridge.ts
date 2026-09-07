// The renderer half of the local automation API. electron/main.cjs serves
// http://127.0.0.1:39219 but owns no data, so every /v1/* request is forwarded
// here, answered against the signed-in cloud state, and reported back for the
// HTTP response.
//
// Each handler re-subscribes whenever cloud state changes, because it answers
// from the render cache rather than re-reading the database on every call.
import {useEffect} from 'react';
import type {DependencyList} from 'react';
import * as db from '../db';
import {buildLaunchPayload} from '../lib/launch';
import {cookieFileToBase64, cookiesFromJsonValue, toCookieJson} from '../lib/cookieFile';
import {assignedSet, resolveLiveSetAction, sanitizeSetName} from '../lib/cookieSync';
import {cloudCookieFromSelection} from '../lib/cookieUpload';
import {assigneeName} from '../lib/assignees';
import {canRecheckProxy, homeProxyStatus} from '../lib/homePage';
import {normalizeTags, tagPresetFor} from '../lib/tags';
import {newProfileDraft, profileFromDraft, withFingerprintOs} from '../drafts';
import {
  CONNECTOR_PRESETS, connectorKindsForApi, presetFor, runtimeConnector,
  validateConnectorConfig,
} from '../data/connectors';
import {
  baseCookieStatuses, baseProfileStatuses, baseProxyStatuses,
} from '../data/statuses';
import {useOrg} from '../org';
import {osPresets, randomFingerprintPatch} from '../lib/fingerprintPresets';
import {comparable} from '../lib/text';
import {matchedProxyForProfile, repairProxyAssignments} from '../lib/proxies';
import {buildRunTile} from '../lib/runTile';
import {startPageAutomations} from '../lib/startPageAutomations';
import {native} from '../native';
import {supabase} from '../supabase';
import {newId} from '../workspace/core';
import {useColumnLayouts} from '../tables/ColumnLayouts';
import {
  applyColumnChange, columnChangeProblem, describeAllTables, describeTable,
} from '../tables/apiColumns';
import {isTableId, TABLE_IDS} from '../tables/columns';
import type {ColumnChange} from '../tables/apiColumns';
import type {CookieFileSelection} from '../native';
import type {WorkspaceValue} from '../workspace/WorkspaceProvider';
import {resolveCallTree} from '../automations/callGraph';
import {validateParams} from '../automations/parameters';
import {describeSchedule, validateSchedule} from '../automations/schedule';
import {isCustomHex, resolveProfileColor} from '../lib/profileColors';
import type {AutomationParam} from '../automations/parameters';
import type {AutomationSchedule} from '../automations/schedule';
import type {AutomationStep, AutomationVars} from '../automations/types';
import type {MontiAutomation, MontiConnector, MontiProxy} from '../types';

// One subscribe/respond pair, with the try/catch every handler needs. Fifteen
// copies of that boilerplate is where the two handlers that forgot to answer on
// failure came from -- an unanswered request hangs the HTTP caller until it
// times out.
function useChannel<Req extends {requestId: string}, Res>(
    subscribe: ((callback: (payload: Req) => void) => () => void) | undefined,
    respond: ((requestId: string, result?: Res, error?: string) => void) | undefined,
    handler: (payload: Req) => Res | Promise<Res>,
    deps: DependencyList) {
  useEffect(() => {
    if (!subscribe || !respond) {
      return;
    }
    return subscribe((payload) => {
      void (async () => {
        try {
          respond(payload.requestId, await handler(payload));
        } catch (error) {
          respond(payload.requestId, undefined,
              error instanceof Error ? error.message : String(error));
        }
      })();
    });
    // The handler closes over the deps the caller declares; `subscribe` and
    // `respond` are stable module-level bridge functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// An error that names its own HTTP code. Everything thrown by a handler is a
// 500 by default, which is the wrong answer for "no automation by that id" --
// an agent that reads 500 retries, and an agent that reads 404 stops.
class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// useChannel for the page routes, which need the status to survive.
//
// The plain useChannel above answers with `respond(requestId, undefined, msg)`
// and no code, so every failure on those routes arrived as a 500 -- including
// the 409 the cookie-sync push handler has thrown for a cross-workspace profile
// since that case was fixed. The panel showed "the launcher broke" for a
// profile that was fine and a fix that was one argument wide.
//
// Reads `.status` off the thrown value rather than requiring ApiError, because
// the handlers here already use `Object.assign(new Error(...), {status})` and
// rewriting them to a class would be a bigger diff than the bug.
function statusOf(error: unknown): number {
  const status = (error as {status?: unknown} | null)?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : 500;
}

function useStatusChannel<Req extends {requestId: string}, Res>(
    subscribe: ((callback: (payload: Req) => void) => () => void) | undefined,
    respond: ((requestId: string, result?: Res, error?: string,
        status?: number) => void) | undefined,
    handler: (payload: Req) => Res | Promise<Res>,
    deps: DependencyList) {
  useEffect(() => {
    if (!subscribe || !respond) {
      return;
    }
    return subscribe((payload) => {
      void (async () => {
        try {
          respond(payload.requestId, await handler(payload));
        } catch (error) {
          respond(payload.requestId, undefined,
              error instanceof Error ? error.message : String(error),
              statusOf(error));
        }
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// A connector's config as the table stores it: a flat object of strings.
//
// Coerced rather than rejected because JSON has types and this column does not:
// an agent sending `{"port": 587}` for an SMTP port means the same thing the
// form's number input produces, and refusing it would be a 400 about a
// distinction the app itself does not draw. Nested objects and arrays ARE
// refused -- there is no field kind they could belong to, so one is a mistake
// worth naming rather than a shape to flatten into "[object Object]".
function stringConfig(config: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'object') {
      throw new ApiError(`config.${key} must be a string, number or boolean`, 400);
    }
    out[key] = String(value);
  }
  return out;
}

// The table-driven equivalent of useChannel: one shared channel pair for every
// route declared in electron/api/routes.json, rather than a named on*/send*
// pair per route.
function useApiChannel<Req extends {requestId: string}, Res>(
    channel: string,
    handler: (payload: Req) => Res | Promise<Res>,
    deps: DependencyList) {
  useEffect(() => {
    const subscribe = native?.onApiRequest;
    const respond = native?.sendApiResult;
    if (!subscribe || !respond) {
      return;
    }
    return subscribe(channel, (payload: Req) => {
      void (async () => {
        try {
          respond(payload.requestId, await handler(payload));
        } catch (error) {
          respond(
              payload.requestId, undefined,
              error instanceof Error ? error.message : String(error),
              error instanceof ApiError ? error.status : 500);
        }
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useAutomationBridge(workspace: WorkspaceValue) {
  const {
    data, toast, automations: automationActions, profiles: profileActions,
    profileNotes: profileNoteActions,
    proxies: proxyActions, cookies: cookieActions,
    // Every connector write goes through these rather than db.connectors
    // directly, and that is load-bearing: they patch cloud state, and
    // useConnectorActions' effect pushes the new list to the main process on
    // every such patch. Writing straight to the database would leave the
    // runner's in-memory map stale, so a connector created over this API would
    // not be usable by a run until the app restarted.
    connectors: connectorActions,
  } = workspace;
  // The workspace's notification bot rides the org row rather than CloudState,
  // and `isOwner` is what the connector writes gate on.
  const org = useOrg();
  const state = data.state;
  const {withDb, patch, setState} = data;
  const cloud = [state] as const;
  // Column layouts, for the two /v1/tables routes at the end of this file.
  // App mounts this bridge inside ColumnLayoutsProvider, so an agent and the
  // picker in the toolbar are writing the same value.
  const columnLayouts = useColumnLayouts();
  // The same flag the three tabs pass: on a one-person workspace the team-only
  // columns are not offered, so the API must not accept them either.
  const isTeam = state.members.length > 1;

  // POST /v1/cookies/bulk-match -- runs against the signed-in cloud state via
  // the same matching logic the "Import cookies" button uses.
  useChannel(
      native?.onBulkMatchCookiesRequest,
      native?.sendBulkMatchCookiesResult,
      ({folderPath, profileIds}) => profileActions.matchCookies(folderPath, profileIds),
      cloud);

  // Scout Web Cookie Manager extensions can push decrypted local browser cookies
  // over the loopback automation API. Store that snapshot as the profile's
  // cloud cookie-import source so other machines and later launches seed it.
  useChannel(
      native?.onPushLocalCookiesRequest,
      native?.sendPushLocalCookiesResult,
      async ({profileId, profileName, cookies}) => {
        const profile = state.profiles.find((item) => item.id === profileId) ||
          state.profiles.find((item) => comparable(item.name) === comparable(profileName));
        if (!profile) {
          return {matched: false, count: 0};
        }
        const safeName = (profile.name || profileId)
            .replace(/[^a-z0-9._-]+/gi, '-')
            .replace(/^-+|-+$/g, '') || profileId;
        const raw = JSON.stringify({
          exportedAt: new Date().toISOString(),
          scope: 'all',
          source: 'local-profile',
          profileId,
          cookies,
        }, null, 2);
        const selection: CookieFileSelection = {
          path: `local-profile:${profileId}`,
          name: `monti-local-cookies-${safeName}.json`,
          count: cookies.length,
          base64: btoa(unescape(encodeURIComponent(raw))),
        };
        const fields = await cloudCookieFromSelection(
            profile.id, selection, profile.cookie_import_url);
        if (!await withDb((orgId) => db.profiles.update(orgId, profile.id, fields))) {
          throw new Error('Failed to save to cloud state.');
        }
        patch.profiles((list) => list.map((item) =>
          item.id === profile.id ? {...item, ...fields} : item));
        toast.setMessage(`Migrated ${cookies.length} local cookies for ${profile.name}`);
        return {matched: true, count: cookies.length};
      },
      cloud);

  // Resolves the profile a run token was minted for, against the workspace it
  // was minted UNDER rather than whichever one happens to be active now.
  //
  // The bug this fixes: `state` is useCloudData(activeOrgId), so a user who
  // switched workspace while a profile window was still open broke that
  // window's cookie sync -- the profile was simply not in `state.profiles` any
  // more, the handler threw "This launch's profile no longer exists", and the
  // panel reported a launcher error for a profile that was fine. Now that
  // orgId rides on the token entry, a cross-workspace launch reads its own org
  // directly. RLS permits it: the cookie_sets and profiles policies are
  // is_org_member(org_id), so the signed-in user is authorized for that org or
  // gets nothing back.
  //
  // Nothing read here is written into `state`. That is the whole discipline of
  // this function: rendering another workspace's rows under the current
  // workspace's name is the failure useCloudData's `generation` guard already
  // exists to prevent, and profile ids are real directory names, so a mixed
  // cache has consequences on disk and not only on screen.
  async function resolveLaunchProfile(profileId: string, tokenOrgId?: string) {
    const activeOrgId = data.orgId || '';
    const sameWorkspace = !tokenOrgId || tokenOrgId === activeOrgId;
    const profile = sameWorkspace ?
      state.profiles.find((item) => item.id === profileId && !item.deleted_at) :
      (await db.profiles.list(tokenOrgId))
          .find((item) => item.id === profileId && !item.deleted_at);
    if (!profile) {
      throw new Error('This launch\'s profile no longer exists.');
    }
    return {
      profile,
      // Only fetched when we are off the active workspace; the common path
      // stays exactly as cheap as it was.
      cookies: sameWorkspace ? state.cookies : await db.cookieSets.list(tokenOrgId),
      orgId: sameWorkspace ? activeOrgId : tokenOrgId,
      sameWorkspace,
    };
  }

  // The cookie-manager extension's live sync (run-token routes, not the keyed
  // API). Pushes land as a VISIBLE library set named "«profile» (live)",
  // assigned to the profile -- inspectable, exportable, re-assignable --
  // unlike the legacy push-local above, which writes hidden per-profile
  // fields and stays for external API callers.
  useStatusChannel(
      native?.onCookieSyncPushRequest,
      native?.sendCookieSyncPushResult,
      async ({profileId, cookies: pushed, saveAs, saveToSetId, orgId}) => {
        const {profile, cookies, sameWorkspace} =
          await resolveLaunchProfile(profileId, orgId);
        // Reads can cross workspaces; writes deliberately cannot.
        //
        // Every write below goes through cookieActions, which is bound to the
        // ACTIVE workspace by withDb. Letting a push from another workspace's
        // profile through would create the set in the wrong org and assign it
        // to a profile id that does not exist there -- silent corruption, in a
        // workspace the user is not even looking at. Parameterizing the whole
        // cookie-action layer by org is the real fix and is not a change to
        // make in passing.
        //
        // So: refuse, with its own status so the panel can say which of the
        // two situations this is. 409 rather than 403, because nothing is
        // wrong with the token -- it is the workspace that moved.
        if (!sameWorkspace) {
          throw Object.assign(
              new Error('This profile belongs to another workspace. Switch back to it ' +
                  'in Scout Web to resume syncing, or relaunch the profile here.'),
              {status: 409});
        }
        const entries = cookiesFromJsonValue(pushed);

        // "Overwrite «set»" from the panel: the user picked an existing set by
        // id and confirmed a dialog naming it and both cookie counts.
        //
        // This is the only path that writes over a set the user did not create
        // from this window, so it is deliberately hard to reach by accident.
        // The panel never routes its automatic push here -- schedulePush has no
        // saveToSetId to send -- and there is no undo: saveEntries uploads a new
        // Storage object and savePayload deletes the superseded one, so the
        // previous contents are gone the moment this succeeds.
        //
        // The id is resolved against this launch's own workspace, never trusted
        // from the body, for the reason the pull route sets out at length.
        if (saveToSetId !== undefined) {
          const target = cookies.find((item) =>
            item.id === saveToSetId && !item.deleted_at);
          if (!target) {
            throw Object.assign(
                new Error('That cookie set is not in this profile\'s workspace.'),
                {status: 403});
          }
          // The same empty-jar guard the two paths below carry, and it matters
          // most here: this is an overwrite of something that already exists.
          if (entries.length === 0) {
            throw new Error('There are no cookies to save.');
          }
          if (!await cookieActions.saveEntries(target, entries)) {
            throw new Error('Could not save these cookies.');
          }
          toast.setMessage(`Saved ${entries.length} cookies to "${target.name}"`);
          return {saved: entries.length, set: target.name};
        }

        // A library save (popup's "Save to Cookies tab…" / editor's dialog),
        // not a sync: `saveAs` diverts the whole request to a NEW named set
        // and returns before any of the live-set logic below ever runs --
        // the live set is neither read nor written, and the set created here
        // is never assigned to the profile. That is what makes it safe for
        // the user to save a curated snapshot without it being silently
        // overwritten by the next automatic push, and without it silently
        // becoming what the profile launches with.
        //
        // Duplicate names are allowed alongside each other rather than
        // merged or overwritten: cookie_sets.name has no uniqueness
        // constraint, and overwriting a same-named set on a bare string
        // match is exactly the failure mode ("(live)" clobbering a curated
        // set) resolveLiveSetAction above exists to avoid. A second
        // "amazon-login" is a nuisance the user can rename or delete from
        // the Cookies tab; a silently overwritten snapshot is unrecoverable.
        if (saveAs !== undefined) {
          const sanitized = sanitizeSetName(saveAs);
          if (!sanitized.ok) {
            throw new Error(sanitized.error);
          }
          // Same empty-push guard as the live sync below, and for the same
          // reason: an empty jar is far more likely to be a session that has
          // not restored yet than a genuine "save nothing", and there is no
          // undo through the UI for a set created with zero cookies in it.
          if (entries.length === 0) {
            throw new Error('There are no cookies to save.');
          }
          let created;
          try {
            created = await cookieActions.addCookieSet({
              path: `saved-set:${profile.id}:${Date.now()}`,
              name: `${sanitized.name}.json`,
              count: entries.length,
              base64: cookieFileToBase64(toCookieJson(entries)),
            });
          } catch (error) {
            console.error('cookie-sync push: could not create the named set', error);
            throw new Error('Could not save these cookies to the Cookies tab.');
          }
          if (!created) {
            throw new Error('Could not save these cookies to the Cookies tab.');
          }
          toast.setMessage(`Saved ${entries.length} cookies to "${created.name}"`);
          return {saved: entries.length, set: created.name};
        }

        // `cookies` rather than state.cookies: same list on the only path that
        // reaches here (the cross-workspace push was refused above), but taking
        // it from the resolver keeps the two readers of this profile's sets
        // from drifting if that ever changes.
        const action = resolveLiveSetAction(profile, cookies);
        // A non-array payload.cookies coerces to [] before this handler ever
        // sees it (run-token.cjs), and cookiesFromJsonValue drops every entry
        // it cannot normalize -- so an empty `entries` is far more likely to
        // be a jar read before the profile's session restored, or a field
        // spelling this build does not recognize, than the user genuinely
        // clearing every cookie. Saving it would overwrite source_url and the
        // cache with nothing, with no undo through the UI, and the profile's
        // next launch would sign in with nothing. Treat it as a no-op on both
        // paths: an update leaves the existing set untouched, and a create is
        // skipped outright rather than clutter the library with an empty set
        // (or, worse, swap an already-assigned curated set out for one).
        if (entries.length === 0) {
          return {saved: 0, set: action.kind === 'update' ? action.set.name : undefined};
        }
        if (action.kind === 'update') {
          if (!await cookieActions.saveEntries(action.set, entries)) {
            throw new Error('Could not save the pushed cookies.');
          }
          return {saved: entries.length, set: action.set.name};
        }
        let created;
        try {
          created = await cookieActions.addCookieSet({
            path: `live-sync:${profile.id}`,
            name: `${action.name}.json`,
            count: entries.length,
            base64: cookieFileToBase64(toCookieJson(entries)),
          });
        } catch (error) {
          // addCookieSet's upload step can throw a raw Storage/Postgres
          // message (see cloudCookieFromSelection); a signed-in user can see
          // the real reason in the console, but the extension over the
          // loopback API gets the same generic wording as every other
          // failure on this route.
          console.error('cookie-sync push: could not create the live set', error);
          throw new Error('Could not create the live cookie set.');
        }
        if (!created) {
          throw new Error('Could not create the live cookie set.');
        }
        if (!await cookieActions.assignToProfiles(created.id, [profile.id])) {
          throw new Error('Could not assign the live cookie set.');
        }
        toast.setMessage(`Synced ${entries.length} cookies from ${profile.name}`);
        return {saved: entries.length, set: created.name};
      },
      cloud);

  // The reverse direction: "Load from Launcher" in the extension popup. Reads
  // whatever set the profile is assigned right now, through the same
  // cache-then-file path the inspector uses.
  useStatusChannel(
      native?.onCookieSyncPullRequest,
      native?.sendCookieSyncPullResult,
      async ({profileId, orgId, setId}) => {
        const {profile, cookies} = await resolveLaunchProfile(profileId, orgId);
        // `setId` is the panel's picker choosing a set this profile is not
        // assigned to. It is the first thing a from-page route has ever read
        // out of a request body to decide WHAT to read, so the compensating
        // control is here rather than at the token layer: resolve it against
        // this launch's own workspace and refuse anything else.
        //
        // Deliberately not left to RLS. RLS would also refuse a set from
        // another org, but only because the signed-in user is not a member of
        // it -- which turns a bug in orgId plumbing into a cross-org read the
        // moment the user happens to belong to both. This list is the token's
        // workspace, resolved from the entry, and nothing else is reachable.
        const wanted = typeof setId === 'string' && setId ?
          cookies.find((item) => item.id === setId && !item.deleted_at) :
          assignedSet(profile, cookies);
        if (typeof setId === 'string' && setId && !wanted) {
          throw Object.assign(
              new Error('That cookie set is not in this profile\'s workspace.'),
              {status: 403});
        }
        if (!wanted) {
          return {cookies: [], set: null, setId: null, assigned: true};
        }
        let rows;
        try {
          rows = await cookieActions.loadEntries(wanted);
        } catch (error) {
          // loadEntries throws the raw Postgres/Storage message so the
          // inspector can show *why* a set would not open; over the loopback
          // API that detail is not for the extension, only the console.
          console.error('cookie-sync pull: could not read the cookie set', error);
          throw new Error('Could not read that cookie set.');
        }
        return {
          cookies: rows.map(({id: _rowId, ...entry}) => entry),
          set: wanted.name,
          setId: wanted.id,
          // What the panel needs to decide whether to suppress its push loop:
          // loading the assigned set leaves the jar and the launcher agreeing,
          // loading any other one does not.
          assigned: wanted.id === (assignedSet(profile, cookies)?.id || ''),
        };
      },
      cloud);

  // Every cookie set in this launch's workspace, so the panel can offer a
  // picker instead of the single "Load from Launcher" button.
  //
  // Metadata only, on exactly the same reasoning as the cookie-list route
  // below: names, counts and filing are what a cookie table shows, and none of
  // it is a credential. No payload is read here at all -- db.cookieSets.list
  // omits the `cookies` column by design, so listing two hundred sets costs one
  // small select.
  //
  // Read through db rather than off `state.cookies`, unlike every handler
  // above. state refreshes on window focus, throttled to once per ten seconds
  // (WorkspaceProvider), and the launcher window is by definition not focused
  // while the user is looking at a browser side panel -- so a teammate's set
  // from five minutes ago would simply not be in the list.
  useStatusChannel(
      native?.onCookieSetsRequest,
      native?.sendCookieSetsResult,
      async ({profileId, orgId}) => {
        const resolved = await resolveLaunchProfile(profileId, orgId);
        let sets;
        try {
          sets = await db.cookieSets.list(resolved.orgId);
        } catch (error) {
          console.error('cookie sets: could not list the workspace library', error);
          throw new Error('Could not read this workspace\'s cookie sets.');
        }
        const assigned = assignedSet(resolved.profile, sets);
        return {
          assignedId: assigned?.id || null,
          sets: sets.filter((item) => !item.deleted_at).map((item) => ({
            id: item.id,
            name: item.name,
            count: Number(item.count) || 0,
            folder_id: item.folder_id || null,
            tags: item.tags || [],
            updated_at: item.updated_at || '',
          })),
        };
      },
      cloud);

  // "What does the Launcher actually have for this profile?" -- answered
  // without applying anything.
  //
  // The pull handler above answers the same question but the only way to ask it
  // was to accept the answer: it imports the set into the live jar. So the one
  // button that says it replaces this browser's cookies was also the only way
  // to find out what it would replace them with.
  //
  // Metadata only, deliberately. Every field here is something you would read
  // off a cookie table -- which sites, how many, when they expire -- and none
  // of it is a credential. `value` is left out: these are live session cookies,
  // this route is reachable by anything on loopback holding the run token, and
  // "show me the list" does not require handing over the sessions themselves.
  // The full-tab editor already shows values, behind the app's own auth.
  useStatusChannel(
      native?.onCookieListRequest,
      native?.sendCookieListResult,
      async ({profileId, orgId, setId}) => {
        const {profile, cookies: sets} = await resolveLaunchProfile(profileId, orgId);
        // Same optional `setId` as the pull route, validated the same way and
        // for the same reason: the picker has to be able to answer "what am I
        // about to load" about a set that is not the assigned one.
        const wanted = typeof setId === 'string' && setId ?
          sets.find((item) => item.id === setId && !item.deleted_at) :
          assignedSet(profile, sets);
        if (typeof setId === 'string' && setId && !wanted) {
          throw Object.assign(
              new Error('That cookie set is not in this profile\'s workspace.'),
              {status: 403});
        }
        if (!wanted) {
          // Not an error: a profile with no assigned set is an ordinary state,
          // and the panel says so rather than painting a failure.
          return {set: null, setId: null, count: 0, cookies: []};
        }
        let rows;
        try {
          rows = await cookieActions.loadEntries(wanted);
        } catch (error) {
          console.error('cookie list: could not read the cookie set', error);
          throw new Error('Could not read that cookie set.');
        }
        return {
          set: wanted.name,
          setId: wanted.id,
          count: rows.length,
          cookies: rows.map((entry) => ({
            domain: String(entry.domain || ''),
            name: String(entry.name || ''),
            path: String(entry.path || '/'),
            secure: Boolean(entry.secure),
            httpOnly: Boolean(entry.httpOnly),
            sameSite: String(entry.sameSite || ''),
            // Null means a session cookie, which is a real and different thing
            // from one expiring at the epoch.
            expires: Number.isFinite(Number(entry.expirationDate)) ?
              Number(entry.expirationDate) :
              null,
          })),
        };
      },
      cloud);

  // Every automation in this launch's workspace, for the side panel's list.
  //
  // The panel used to show the launch snapshot -- pinned workflows plus the
  // profile's own -- frozen into a JSON file before the browser process
  // existed. A team whose workflows nobody had thought to pin was invisible
  // from inside the browser, which is the whole point of this route.
  //
  // Read through db rather than off state.automations, for the reason the
  // cookie-sets handler above gives: the launcher window is not focused while
  // someone is looking at a side panel, and state only refreshes on focus.
  //
  // What travels is metadata. `steps` never does -- launch.ts sets out why at
  // length, and it applies with more force here: the panel is a document
  // living in a browser that goes on to visit arbitrary sites, and a step tree
  // carries selectors, urls and typed values. `variables` and `parameters`
  // never travel either; parameters can hold resolved secret values.
  useStatusChannel(
      native?.onPanelAutomationsRequest,
      native?.sendPanelAutomationsResult,
      async ({profileId, orgId}) => {
        const resolved = await resolveLaunchProfile(profileId, orgId);
        let rows;
        try {
          rows = await db.automations.list(resolved.orgId);
        } catch (error) {
          console.error('panel automations: could not list the workspace', error);
          throw new Error('Could not read this workspace\'s automations.');
        }
        const attachedId = resolved.profile.automation_id || '';
        return {
          automations: rows.filter((item) => !item.deleted_at).map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description || '',
            pinned: Boolean(item.pinned),
            assigned: item.id === attachedId,
            icon: item.icon || '',
            color: item.color || '',
          })),
        };
      },
      cloud);

  // Resolves one workspace automation into a runnable tile, for a panel run of
  // a workflow this launch was not handed.
  //
  // The answer goes to the main process and straight into the runner. It is the
  // one payload on any of these routes that DOES carry steps and resolved
  // parameter values, including secret ones -- which is exactly why it is
  // resolved on demand and never written into the run token store, and why the
  // panel never sees it. main.cjs holds it for the length of one request.
  //
  // The id is validated here, against the workspace the token was minted under,
  // and nowhere else. Not at the token layer, which type-checks it and no more,
  // and deliberately not by leaning on RLS: RLS refuses another org's rows only
  // because the signed-in user is not a member, so a bug in orgId plumbing
  // would turn into a cross-org run the moment they happened to be in both.
  useStatusChannel(
      native?.onPanelResolveAutomationRequest,
      native?.sendPanelResolveAutomationResult,
      async ({profileId, orgId, automationId}) => {
        const resolved = await resolveLaunchProfile(profileId, orgId);
        // The catalogue, not just the one row: resolveCallTree needs every
        // automation this one might call, and a workflow whose callee is
        // missing must refuse by name rather than half-run.
        let rows;
        try {
          rows = await db.automations.list(resolved.orgId);
        } catch (error) {
          console.error('panel run: could not read the workspace catalogue', error);
          throw new Error('Could not read this workspace\'s automations.');
        }
        const wanted = rows.find((item) => item.id === automationId && !item.deleted_at);
        if (!wanted) {
          // A trashed automation is refused rather than run: a profile keeps
          // its automation_id through a soft delete so restoring is lossless,
          // which is precisely what makes "trashed means does not run" a rule
          // this path has to enforce too.
          throw Object.assign(
              new Error('That automation is not in this profile\'s workspace.'),
              {status: 403});
        }
        const tile = buildRunTile(wanted, resolved.profile, rows);
        return {
          automation: tile,
          resolvedAutomations: tile.resolvedAutomations,
          vars: tile.vars,
          secretVarNames: tile.secretVarNames,
          paramsBlocked: tile.paramsBlocked,
        };
      },
      cloud);

  useChannel(
      native?.onReimportProxiesRequest,
      native?.sendReimportProxiesResult,
      async ({proxies: rows}) => {
        let updated = 0;
        let created = 0;
        const proxies = [...state.proxies];
        // The rows this run actually created or changed, so untouched proxies
        // are not rewritten.
        const touched: MontiProxy[] = [];
        const keyFor = (type: string, host: string, port: number) =>
          `${type.toLowerCase()}|${host.toLowerCase()}|${port}`;
        const indexByKey = new Map<string, number>();
        proxies.forEach((proxy, index) => {
          indexByKey.set(keyFor(proxy.type || 'http', proxy.host, proxy.port), index);
        });
        for (const row of rows) {
          const host = String(row.ip || row.host || '').trim();
          const socksPort = Number(row.port_socks5 || row.socks_port || 0);
          const httpPort = Number(row.port_http || row.http_port || row.port || 0);
          const type: MontiProxy['type'] = socksPort ? 'socks5' : 'http';
          const port = type === 'socks5' ? socksPort : httpPort;
          if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
            continue;
          }
          const username = String(row.username || '').trim();
          const password = String(row.password || '');
          const country = String(row.country || '').trim();
          const key = keyFor(type, host, port);
          const existingIndex = indexByKey.get(key);
          const existing = existingIndex == null ? null : proxies[existingIndex];
          const nextProxy: MontiProxy = {
            ...(existing || {}),
            id: existing ? existing.id : String(row.id || newId(created)),
            name: existing ?
              existing.name :
              (country ? `${country.toUpperCase()} proxy ${host}` : `${host}:${port}`),
            type,
            host,
            port,
            username: username || undefined,
            password: password || undefined,
            country: country || existing?.country,
            country_code: country || existing?.country_code,
            checked_at: undefined,
            check_error: undefined,
            egress_ip: undefined,
            ping_ms: undefined,
          };
          if (existingIndex == null) {
            indexByKey.set(key, proxies.length);
            proxies.push(nextProxy);
            created++;
          } else {
            proxies[existingIndex] = nextProxy;
            updated++;
          }
          touched.push(nextProxy);
        }
        // repairProxyAssignments only ever rewrites proxy_id/proxy_mode, and it
        // returns the same object for a profile it did not change -- so an
        // identity comparison is enough to find the profiles that need writing.
        const repairedProfiles = repairProxyAssignments({...state, proxies}).state.profiles;
        const ok = await withDb(async (orgId) => {
          for (const proxy of touched) {
            await db.proxies.upsert(orgId, proxy);
          }
          for (let index = 0; index < repairedProfiles.length; index++) {
            const profile = repairedProfiles[index];
            if (profile === state.profiles[index]) {
              continue;
            }
            await db.profiles.update(orgId, profile.id,
                {proxy_id: profile.proxy_id, proxy_mode: profile.proxy_mode});
          }
        });
        if (!ok) {
          throw new Error('Failed to save to cloud state.');
        }
        setState((current) => ({...current, proxies, profiles: repairedProfiles}));
        toast.setMessage(`Reimported proxies: ${updated} updated, ${created} created`);
        return {updated, created, total: rows.length};
      },
      cloud);

  // POST /v1/proxies/recheck-from-page -- a launch's own start page asking for
  // its proxy line to be brought up to date.
  //
  // The page shows a country and a latency measured once, at launch, and a
  // session outlives that by hours. This is the only surface that can ask for a
  // fresh one: you cannot reach the launcher from inside an anonymous window.
  //
  // It answers here rather than in main.cjs because both halves of the answer
  // live in the renderer -- recordCheck writes the result to the proxy row, so
  // the Proxies tab and every other profile on that proxy agree with what the
  // page now says, and homeProxyStatus is the one place the panel's wording is
  // decided. main.cjs has already verified the run token; the profile id on the
  // request came off that token's entry, not off the request body, so there is
  // nothing here for a caller to choose.
  useChannel(
      native?.onRecheckProxyRequest,
      native?.sendRecheckProxyResult,
      async ({profileId}) => {
        const profile = state.profiles.find((item) => item.id === profileId);
        if (!profile) {
          throw new Error('That profile is no longer in this workspace');
        }
        const proxy = matchedProxyForProfile(profile, state.proxies);
        if (!canRecheckProxy(profile, proxy) || !proxy) {
          // The page only draws the button when there is something to re-check,
          // so this is a workspace that changed under an open session. Answer
          // with the current status rather than an error: "no proxy assigned"
          // is exactly what the panel should now say.
          const status = homeProxyStatus(profile, proxy);
          return {proxyOk: status.ok, title: status.title, detail: status.detail, fields: status.fields};
        }
        // Failures are recorded too, the same way the background sweep records
        // them -- a proxy that has stopped working should say so on its card as
        // well as on the page that just found out.
        const checked = await proxyActions.runCheck(proxy);
        await proxyActions.recordCheck(checked);
        const status = homeProxyStatus(profile, checked);
        return {proxyOk: status.ok, title: status.title, detail: status.detail, fields: status.fields};
      },
      cloud);

  useChannel(
      native?.onAssignProfileProxyRequest,
      native?.sendAssignProfileProxyResult,
      async ({profileId, proxyId, proxyHost, proxyPort, allowedFolders}) => {
        if (!await resolveInScope(profileId, allowedFolders)) {
          return {matched: false, profileId};
        }
        const proxy = state.proxies.find((item) => proxyId && item.id === proxyId) ||
          state.proxies.find((item) =>
            proxyHost && item.host === proxyHost && (!proxyPort || item.port === proxyPort));
        if (!proxy) {
          return {matched: false, profileId};
        }
        const ok = await withDb((orgId) =>
          db.profiles.update(orgId, profileId, {proxy_id: proxy.id, proxy_mode: 'assigned'}));
        if (!ok) {
          throw new Error('Failed to save to cloud state.');
        }
        patch.profiles((list) => list.map((profile) =>
          profile.id === profileId ?
            {...profile, proxy_id: proxy.id, proxy_mode: 'assigned' as const} :
            profile));
        toast.setMessage(`Assigned ${proxy.host}:${proxy.port} to ${profileId}`);
        return {matched: true, profileId, proxyId: proxy.id};
      },
      cloud);

  useChannel(
      native?.onGetProfileRequest,
      native?.sendGetProfileResult,
      ({profileId, allowedFolders}) => {
        requireSignedIn();
        const profile = state.profiles.find((item) => item.id === profileId && !item.deleted_at);
        if (!profile || (allowedFolders && !allowedFolders.includes(profile.folder_id || ''))) {
          return {profile: null};
        }
        // The note summary rides along, and the whole thread does not.
        //
        // A profile read that says nothing about its notes leaves an agent no
        // reason to suspect they exist, which defeats the point of writing them
        // -- "do not warm this one up" is precisely the instruction that has to
        // arrive unasked-for. But the thread is unbounded and this reply is
        // already the largest object on this bridge, so what travels is the
        // newest note and a count, with the tool that returns the rest named in
        // the reply itself.
        const summary = state.note_summaries.find((item) => item.profile_id === profile.id);
        return {
          profile,
          notes: summary ? {
            count: summary.note_count,
            latest: {
              body: summary.last_body,
              author: summary.last_author_kind === 'agent' ?
                summary.last_author_label || 'Agent' :
                assigneeName(summary.last_created_by, state.members) || 'Unknown',
              authorKind: summary.last_author_kind,
              createdAt: summary.last_created_at,
            },
            more: summary.note_count > 1 ?
              'Read the rest with monti_profile_notes.' :
              undefined,
          } : {count: 0},
        };
      },
      cloud);

  useChannel(
      native?.onListProxiesRequest,
      native?.sendListProxiesResult,
      () => {
        requireSignedIn();
        return {
          // Credentials are deliberately not returned. This used to spread the
          // whole row, so a single list call put every proxy username and
          // password the account owns into the caller's context in clear text --
          // and for an MCP client that context is an LLM's transcript, which is
          // logged, and which the user cannot unsend. Nothing a caller does with
          // this list needs them: proxies are assigned to profiles by id, and
          // monti_check_proxy takes credentials as explicit arguments for
          // testing a proxy that has not been saved yet. `hasCredentials` keeps
          // the one fact that was actually useful.
          proxies: state.proxies.map(({username, password, ...proxy}) => ({
            ...proxy,
            hasCredentials: Boolean(username || password),
            assignedProfileIds: state.profiles
                .filter((profile) => !profile.deleted_at && profile.proxy_id === proxy.id)
                .map((profile) => profile.id),
          })),
        };
      },
      cloud);

  useChannel(
      native?.onCreateProxyRequest,
      native?.sendCreateProxyResult,
      async ({name, type, host, port, username, password}) => {
        const proxy: MontiProxy = {
          id: newId(),
          name: name || `${host}:${port}`,
          type,
          host,
          port,
          username,
          password,
        };
        if (!await workspace.proxies.create(proxy)) {
          throw new Error('Failed to save to cloud state.');
        }
        toast.setMessage(`Created proxy ${proxy.name}`);
        return {proxyId: proxy.id};
      },
      cloud);

  useChannel(
      native?.onUpdateProxyRequest,
      native?.sendUpdateProxyResult,
      async ({proxyId, fields}) => {
        const existing = state.proxies.find((item) => item.id === proxyId);
        if (!existing) {
          return {matched: false};
        }
        if (!await workspace.proxies.update({...existing, ...fields})) {
          throw new Error('Failed to save to cloud state.');
        }
        toast.setMessage(`Updated proxy ${proxyId}`);
        return {matched: true};
      },
      cloud);

  useChannel(
      native?.onDeleteProxyRequest,
      native?.sendDeleteProxyResult,
      async ({proxyId}) => {
        if (!state.proxies.some((item) => item.id === proxyId)) {
          return {deleted: false, unassignedProfileIds: []};
        }
        const unassignedProfileIds = state.profiles
            .filter((profile) => profile.proxy_id === proxyId)
            .map((profile) => profile.id);
        if (!await workspace.proxies.remove([proxyId])) {
          throw new Error('Failed to save to cloud state.');
        }
        toast.setMessage(`Deleted proxy ${proxyId}${unassignedProfileIds.length ? ` (unassigned from ${unassignedProfileIds.length} profile(s))` : ''}`);
        return {deleted: true, unassignedProfileIds};
      },
      cloud);

  // Signed out is not the same as "this account has no profiles", and from the
  // outside the two used to be indistinguishable: this bridge is mounted above
  // the sign-in gate in App.tsx, so with no session every list answered 200
  // with an empty array and a caller would reasonably conclude the account was
  // empty and stop. Failing loudly is the only honest answer.
  function requireSignedIn() {
    if (!data.orgId) {
      throw new Error('Scout Web is signed out. Sign in to use the automation API.');
    }
  }

  // allowedFolders is an authorization gate, not a display filter, so every
  // path it guards has to re-read where the profile lives *now* rather than
  // trusting this window's render cache -- the same reasoning the delete path
  // below already documents.
  //
  // Three write paths took no scope at all until this existed: update,
  // assign-proxy and update-fingerprint. Since folder_id is one of the settable
  // fields, a key scoped to one folder could move any profile in the account
  // into that folder and then read and launch it entirely legitimately. The
  // scope was a read filter, not a boundary.
  async function resolveInScope(profileId: string, allowedFolders?: string[] | null) {
    if (!data.orgId) {
      throw new Error('No organization is selected yet.');
    }
    const latest = await db.profiles.list(data.orgId);
    const target = latest.find((item) => item.id === profileId && !item.deleted_at);
    if (!target || (allowedFolders && !allowedFolders.includes(target.folder_id || ''))) {
      return null;
    }
    return target;
  }

  // POST /v1/profiles/create. Builds the row through the very pipeline the New
  // Profile dialog uses -- newProfileDraft for every default, then profileFromDraft
  // -- so an API-made profile and a hand-made one are the same shape, and the id
  // is minted by the draft (never taken from the caller: it is also the on-disk
  // directory name, with a filesystem-safety check on the column).
  useApiChannel(
      'monti:create-profile-request',
      async (payload: {
        requestId: string;
        name: string;
        folderId?: string;
        status?: string;
        tags?: string[];
        color?: string;
        avatar?: string;
        proxyMode?: string;
        proxyId?: string;
        startUrl?: string;
        fingerprintOs?: string;
        randomizeFingerprint?: boolean;
        allowedFolders?: string[] | null;
      }) => {
        requireSignedIn();
        const {allowedFolders} = payload;
        const folderId = payload.folderId?.trim() || '';
        // A scoped key may only create into a folder it holds, and only into a
        // real one: the root ('') is allowed, but a named folder that does not
        // exist is a 400 rather than a row filed nowhere.
        if (allowedFolders && !allowedFolders.includes(folderId)) {
          throw new ApiError('This key is not scoped to that folder', 403);
        }
        if (folderId && !state.folders.some((folder) => folder.id === folderId)) {
          throw new ApiError(`No folder with id ${folderId}`, 400);
        }
        // assigned means "on a specific proxy from the library", so it needs one
        // that resolves -- otherwise the row is exactly what ProfileModal refuses
        // to save. Default to assigned only when a proxyId was given; a bare
        // create is a direct-connection profile.
        const proxyMode = payload.proxyMode || (payload.proxyId ? 'assigned' : 'direct');
        if (proxyMode !== 'assigned' && proxyMode !== 'direct' && proxyMode !== 'free_proxy') {
          throw new ApiError('proxyMode must be assigned, direct or free_proxy', 400);
        }
        if (proxyMode === 'assigned' &&
            (!payload.proxyId || !state.proxies.some((proxy) => proxy.id === payload.proxyId))) {
          throw new ApiError('Proxy is required, or pick direct / free_proxy instead.', 400);
        }
        // The route only type-checks avatar; the brand:/'' rule that the HTTP
        // update handler enforces has to be re-applied here, since a create with
        // an https:// avatar would otherwise reach the row.
        const avatar = payload.avatar?.trim() || '';
        if (avatar && !avatar.startsWith('brand:')) {
          throw new ApiError('avatar must be "brand:<slug>" or omitted', 400);
        }
        if (payload.fingerprintOs && !osPresets.includes(payload.fingerprintOs)) {
          throw new ApiError(`fingerprintOs must be one of: ${osPresets.join(', ')}`, 400);
        }

        let draft = newProfileDraft();
        draft = {
          ...draft,
          name: payload.name,
          status: payload.status?.trim() || draft.status,
          color: payload.color?.trim() || draft.color,
          avatar,
          folder_id: folderId,
          proxy_mode: proxyMode,
          proxy_id: proxyMode === 'assigned' ? (payload.proxyId || '') : '',
          start_url: payload.startUrl?.trim() || '',
          tags: (payload.tags || []).join(', '),
        };
        const os = payload.fingerprintOs;
        if (os && os !== draft.fingerprint_os) {
          draft = withFingerprintOs(draft, os);
        }
        if (payload.randomizeFingerprint) {
          draft = {...draft, ...randomFingerprintPatch(os || draft.fingerprint_os)};
        }
        const profile = profileFromDraft(draft, new Date().toISOString());

        // The org's profile limit is enforced by trg_profile_limit on the INSERT
        // and comes back here as a plain sentence -- surfaced as a 400 the agent
        // can read, the same way create-automation handles its own limit.
        const error = await profileActions.create(profile);
        if (error) {
          throw new ApiError(error, 400);
        }
        toast.setMessage(`Created ${profile.name}`);
        return {profile};
      },
      cloud);

  useChannel(
      native?.onUpdateProfileRequest,
      native?.sendUpdateProfileResult,
      async ({profileId, fields, allowedFolders}) => {
        const existing = await resolveInScope(profileId, allowedFolders);
        if (!existing) {
          return {matched: false, profileId};
        }
        // Both ends of a move have to be in scope. Checking only the source
        // would let a scoped key relocate its own profiles into a folder it has
        // no rights to, which is the same escape in the other direction.
        if (allowedFolders && 'folder_id' in fields &&
            !allowedFolders.includes(fields.folder_id || '')) {
          return {matched: false, profileId};
        }
        // 'assigned' is only meaningful with a proxy behind it. An agent flipping
        // a proxyless profile to assigned would write the row ProfileModal
        // refuses to save; point it at monti_assign_proxy, which sets both at
        // once. The proxy may be one this same patch is not touching, so check
        // the effective value: the incoming proxy_id, else the stored one.
        if (fields.proxy_mode === 'assigned') {
          const effectiveProxyId = 'proxy_id' in fields ? fields.proxy_id : existing.proxy_id;
          if (!effectiveProxyId || !state.proxies.some((proxy) => proxy.id === effectiveProxyId)) {
            throw new ApiError(
                'This profile has no proxy assigned. Use monti_assign_proxy first, ' +
                'or set proxyMode to direct or free_proxy.', 400);
          }
        }
        // direct and free_proxy carry no proxy, so clear the id when moving to
        // one -- the same rule profileFromDraft applies on save.
        const cleared = (fields.proxy_mode === 'direct' || fields.proxy_mode === 'free_proxy') ?
          {...fields, proxy_id: null} : fields;
        // '' detaches the launch automation; anything else must name a real one.
        if (cleared.automation_id) {
          if (!state.automations.some((item) => item.id === cleared.automation_id)) {
            throw new ApiError(`No automation with id ${cleared.automation_id}`, 400);
          }
        } else if ('automation_id' in cleared) {
          cleared.automation_id = null;
        }
        // An agent posting eight tags gets five, on the same terms as the
        // editor and the CSV importer -- this is the third and last write path
        // into profiles.tags, and none of them may leave a row the dialog
        // would then refuse to save.
        const patch = 'tags' in cleared ?
          {...cleared, tags: normalizeTags(cleared.tags || [])} : cleared;
        if (!await profileActions.update(existing, patch)) {
          throw new Error('Failed to save to cloud state.');
        }
        toast.setMessage(`Updated ${profileId}`);
        return {matched: true, profileId};
      },
      cloud);

  useChannel(
      native?.onDeleteProfileRequest,
      native?.sendDeleteProfileResult,
      async ({profileId, permanent, allowedFolders}) => {
        if (!data.orgId) {
          throw new Error('No organization is selected yet.');
        }
        // Still re-read before the folder check: allowedFolders is an
        // authorization gate, so it has to see where the profile lives now
        // rather than trusting this window's render cache. The delete itself
        // is one statement against one id and needs nothing fresh.
        const latestProfiles = await db.profiles.list(data.orgId);
        const target = latestProfiles.find((item) => item.id === profileId);
        if (!target || (allowedFolders && !allowedFolders.includes(target.folder_id || ''))) {
          return {deleted: false, permanent};
        }
        const ok = await withDb((orgId) => permanent ?
          db.profiles.purge(orgId, [profileId]) :
          db.profiles.softDelete(orgId, [profileId]));
        if (!ok) {
          throw new Error('Failed to save to cloud state.');
        }
        // Patched from the list we just read rather than from the render
        // cache, so profiles another worker added since the last load are
        // picked up by the same round trip the authorization check needed.
        const remaining = permanent ?
          latestProfiles.filter((item) => item.id !== profileId) :
          latestProfiles.map((item) =>
            item.id === profileId ? {...item, deleted_at: new Date().toISOString()} : item);
        patch.profiles(() => remaining);
        if (workspace.selectedProfileId === profileId) {
          workspace.setSelectedProfileId(remaining.find((item) => !item.deleted_at)?.id || null);
        }
        toast.setMessage(permanent ?
          `${profileId} permanently deleted` :
          `${profileId} moved to Trash`);
        return {deleted: true, permanent};
      },
      cloud);

  useChannel(
      native?.onUpdateFingerprintRequest,
      native?.sendUpdateFingerprintResult,
      async ({profileId, fingerprint, allowedFolders}) => {
        const target = await resolveInScope(profileId, allowedFolders);
        if (!target) {
          return {matched: false, profileId};
        }
        const merged = {...target.fingerprint, ...fingerprint};
        if (!await profileActions.update(target, {fingerprint: merged})) {
          throw new Error('Failed to save to cloud state.');
        }
        toast.setMessage(`Updated fingerprint for ${profileId}`);
        return {matched: true, profileId};
      },
      cloud);

  useChannel(
      native?.onListProfilesRequest,
      native?.sendListProfilesResult,
      ({folder, allowedFolders}) => {
        requireSignedIn();
        return {
          profiles: state.profiles
              .filter((profile) => !profile.deleted_at)
              .filter((profile) => !folder || profile.folder_id === folder)
              .filter((profile) => !allowedFolders || allowedFolders.includes(profile.folder_id || ''))
              .map((profile) => ({id: profile.id, name: profile.name})),
        };
      },
      cloud);

  // Unlike the manual Launch button this skips the interactive pre-check/retry
  // UI (there is nothing to show it to) and skips fingerprint rotate-on-launch,
  // since automated QA/monitoring runs want a stable, comparable fingerprint
  // across repeated sweeps rather than a fresh one each time.
  // spawnProfileUnchecked (main process) remains the authoritative proxy gate.
  useChannel(
      native?.onLaunchAutomationRequest,
      native?.sendLaunchAutomationResult,
      async ({profileId, cdpPort, allowedFolders}) => {
        const launchProfile = native?.launchProfile;
        const profile = state.profiles.find((item) => item.id === profileId && !item.deleted_at);
        if (!profile || !launchProfile) {
          return {ok: false, error: 'Profile not found'};
        }
        if (allowedFolders && !allowedFolders.includes(profile.folder_id || '')) {
          return {ok: false, error: 'This key is not scoped to that profile\'s folder'};
        }
        let proxy = null;
        if ((profile.proxy_mode || 'assigned') === 'assigned') {
          proxy = profileActions.proxyFor(profile);
          if (!proxy?.host || !proxy.port) {
            return {ok: false, error: `Proxy for ${profile.name} is invalid`};
          }
        }
        // The same start page a hand-launched profile gets. This window is a
        // real browser someone may well look at, and it already has a debugging
        // port, so there is no reason for it to be the one launch whose page
        // cannot run its tiles or re-check its proxy. Minted with the port the
        // caller reserved, so a tile drives this session rather than a stale one.
        const runToken = await native?.mintRunToken?.(
            profile.id, profile.name, data.orgId || '', cdpPort,
            startPageAutomations(state.automations, profile)) || '';
        const apiPort = runToken ? (await native?.getApiStatus?.())?.port : 0;
        const result = await launchProfile(
            buildLaunchPayload(profile, proxy, state,
                runToken && apiPort ? {port: apiPort, token: runToken} : null),
            [`--remote-debugging-port=${cdpPort}`]);
        return {ok: result.ok, pid: result.pid, error: result.error};
      },
      cloud);

  // Monitoring results go straight to Supabase rather than through cloud state,
  // so this one does not care when the render cache changes.
  useChannel(
      native?.onMonitoringReportRequest,
      native?.sendMonitoringReportResult,
      async ({runId, profileId, ok, detail, screenshotBase64}) => {
        if (!supabase) {
          throw new Error('Supabase env is missing in .env');
        }
        const {data: userData, error: userError} = await supabase.auth.getUser();
        const userId = userData.user?.id;
        if (userError || !userId) {
          throw new Error('Not signed in');
        }
        const {error} = await supabase.from('monti_monitoring_results').insert({
          user_id: userId,
          run_id: runId,
          profile_id: profileId,
          ok,
          detail: detail || null,
          screenshot_base64: screenshotBase64,
        });
        if (error) {
          throw new Error(error.message);
        }
        return {ok: true} as const;
      },
      []);

  // ── Automations ────────────────────────────────────────────────────────────
  // The five routes an agent authors workflows through. main.cjs has already
  // validated the declared fields and the step tree, and has already refused a
  // folder-scoped key on create/update/delete -- automations are org-wide and
  // have no folder to scope against.

  // The optional presentation/wiring fields create and update share, each
  // validated to the same rule the editor enforces, each throwing the sentence
  // the agent needs. Only keys present in the payload appear in the result --
  // the update handler's only-what-was-sent contract depends on that.
  function automationExtras(payload: {
    icon?: string;
    color?: string;
    folderId?: string;
    notifyOn?: string;
    notifyConnectorId?: string;
    variables?: Record<string, unknown>;
    parameters?: unknown;
    schedule?: unknown;
  }): Partial<MontiAutomation> {
    const extras: Partial<MontiAutomation> = {};
    if (payload.icon !== undefined) {
      const icon = payload.icon.trim();
      if (icon && (!icon.startsWith('brand:') || !tagPresetFor(icon.slice('brand:'.length)))) {
        throw new ApiError(
            'icon must be "brand:<slug>" naming a catalog brand ' +
            '(brand:facebook, brand:instagram, ...) or empty to clear it', 400);
      }
      extras.icon = icon || null;
    }
    if (payload.color !== undefined) {
      const color = payload.color.trim();
      if (color && !resolveProfileColor(color) && !isCustomHex(color)) {
        throw new ApiError(
            'color must be slate, blue, green, violet, red, amber, or a #rrggbb hex', 400);
      }
      extras.color = color || null;
    }
    if (payload.folderId !== undefined) {
      const folderId = payload.folderId.trim();
      // Checked against the AUTOMATION folders specifically. All four
      // libraries share one table, so a profile folder's id is a real id that
      // would insert cleanly and then file the automation somewhere no view
      // in the app can reach -- the error names the group to look in.
      if (folderId && !state.automation_folders.some((folder) => folder.id === folderId)) {
        throw new ApiError(
            `No automation folder with id ${folderId}. Use an id from the ` +
            '"automations" group of monti_list_folders — profile, proxy and ' +
            'cookie folders are separate namespaces.', 400);
      }
      extras.folder_id = folderId || null;
    }
    if (payload.notifyOn !== undefined) {
      const notifyOn = payload.notifyOn.trim();
      if (notifyOn && notifyOn !== 'always' && notifyOn !== 'failure') {
        throw new ApiError('notifyOn must be always, failure, or empty to clear it', 400);
      }
      extras.notify_on = (notifyOn || null) as MontiAutomation['notify_on'];
      // Clearing notifyOn clears the target too -- the editor's rule: a
      // connector id behind a null notify_on is dead state.
      if (!notifyOn) {
        extras.notify_connector_id = null;
      }
    }
    if (payload.notifyConnectorId !== undefined) {
      const connectorId = payload.notifyConnectorId.trim();
      if (connectorId && !state.connectors.some((connector) =>
        connector.id === connectorId && connector.category === 'message')) {
        throw new ApiError(
            `No message connector with id ${connectorId}. ` +
            'Connectors are managed in the launcher, on the Automations tab.', 400);
      }
      extras.notify_connector_id = connectorId || null;
    }
    if (payload.variables !== undefined) {
      if (typeof payload.variables !== 'object' || payload.variables === null ||
          Array.isArray(payload.variables)) {
        throw new ApiError('variables must be an object of seed values', 400);
      }
      extras.variables = payload.variables as AutomationVars;
    }
    if (payload.parameters !== undefined) {
      // The same validator the editor runs, returning the same sentences. What
      // the dialog refuses the API refuses identically -- the contract
      // validateSchedule above already keeps, and the reason both live in
      // src/automations/ rather than in either caller.
      const problems = validateParams(payload.parameters);
      if (problems.length > 0) {
        throw new ApiError(problems.join('; '), 400);
      }
      extras.parameters = payload.parameters as AutomationParam[];
    }
    if (payload.schedule !== undefined) {
      if (payload.schedule === null) {
        extras.schedule = null;
      } else {
        const problems = validateSchedule(payload.schedule);
        if (problems.length > 0) {
          throw new ApiError(problems.join(' '), 400);
        }
        extras.schedule = payload.schedule as AutomationSchedule;
      }
    }
    return extras;
  }

  // What resolveCallTree's problems become on this surface. Checked against
  // the workspace WITH the incoming edit applied, so a save that would create
  // a cycle is a 400 here rather than a failed run later.
  function requireSoundCallTree(automation: MontiAutomation, all: MontiAutomation[]) {
    const {problems} = resolveCallTree(automation, all);
    if (problems.length > 0) {
      throw new ApiError(problems.join(' '), 400);
    }
  }

  // One automation, by id, and never one in Trash.
  //
  // Trashed rows stay in state so the tab can show Trash as a view of the same
  // list, which means every channel that resolves an id has to exclude them or
  // an agent gets to read, edit, run and subscribe to workflows the app is
  // treating as deleted. 404 rather than a distinct code: an agent has no way
  // to restore one, so "gone" is the whole of the useful answer.
  function requireAutomation(automationId: string): MontiAutomation {
    const found = state.automations.find(
        (item) => item.id === automationId && !item.deleted_at);
    if (!found) {
      throw new ApiError(`No automation with id ${automationId}`, 404);
    }
    return found;
  }

  // Deliberately not the whole step tree: a workspace with thirty automations
  // would put every step of every one of them into an agent's context on a
  // request that only asked what exists. monti_get_automation is one call away.
  useApiChannel(
      'monti:list-automations-request',
      () => ({
        // Trash is not listed. An agent cannot restore one, so offering it
        // would only produce calls that fail -- and the run and get channels
        // refuse a trashed id for the same reason.
        automations: state.automations.filter((item) => !item.deleted_at).map((automation) => ({
          id: automation.id,
          name: automation.name,
          description: automation.description || null,
          stepCount: automation.steps.length,
          // The declarations themselves, not a count: an agent that knows an
          // automation exists needs to know what to pass it, and making that a
          // second monti_get_automation call (which returns the whole step
          // tree) is a lot of context for a list of names and kinds.
          parameters: automation.parameters || [],
          pinned: Boolean(automation.pinned),
          icon: automation.icon || null,
          color: automation.color || null,
          // The agent-facing half of attribution: who made it (a member's
          // name, or the creating agent's label) and through what.
          createdVia: automation.created_via || 'user',
          createdBy: automation.created_via === 'mcp' ?
            (automation.created_by_label || 'Agent') :
            (assigneeName(automation.created_by, state.members) || null),
          lastRunAt: automation.last_run_at || null,
          lastRunStatus: automation.last_run_status || null,
          schedule: automation.schedule?.enabled ?
            describeSchedule(automation.schedule) : null,
          // The SIGNED-IN USER'S star, since MCP writes ride their session --
          // an agent sees the stars of whoever runs the launcher.
          starred: state.automation_stars.includes(automation.id),
          runsOnLaunchFor: state.profiles
              .filter((profile) => !profile.deleted_at &&
                profile.automation_id === automation.id)
              .map((profile) => profile.id),
        })),
      }),
      cloud);

  useApiChannel(
      'monti:get-automation-request',
      ({automationId}: {requestId: string; automationId: string}) => ({
        automation: requireAutomation(automationId),
      }),
      cloud);

  useApiChannel(
      'monti:create-automation-request',
      async (payload: {
        requestId: string;
        name: string;
        description?: string;
        steps: AutomationStep[];
        tags?: string[];
        pinned?: boolean;
        timeoutMs?: number;
        closeOnFinish?: boolean;
        icon?: string;
        color?: string;
        folderId?: string;
        notifyOn?: string;
        notifyConnectorId?: string;
        variables?: Record<string, unknown>;
        parameters?: unknown;
        schedule?: unknown;
        // Forwarded by main on every table-driven channel: the API key's id
        // and display name. Not the author's identity -- the Supabase write
        // below still rides whoever is signed in -- which is exactly why the
        // label is recorded.
        agent?: {id: string; name: string};
      }) => {
        requireSignedIn();
        const extras = automationExtras(payload);
        const automation: MontiAutomation = {
          // Minted here, never taken from the caller: the id doubles as a
          // directory name under <userData>/AutomationRuns and the column has
          // a filesystem-safety check constraint on it.
          id: newId(),
          name: payload.name.trim(),
          description: payload.description?.trim() || null,
          steps: payload.steps,
          variables: {},
          // Overwritten by `extras` below when the caller sent any -- seeded
          // here so a row always has the column, the way variables does.
          parameters: [],
          // automationToRow runs these through normalizeTags, which is the one
          // enforcement point for the 5-tag cap -- an agent posting eight gets
          // five, on the same terms as the editor and the CSV importer.
          tags: payload.tags || [],
          pinned: Boolean(payload.pinned),
          timeout_ms: Math.min(payload.timeoutMs ?? 300000, 600000),
          close_on_finish: Boolean(payload.closeOnFinish),
          ...extras,
          // What the card's "who made this" reads. created_by (the uuid) still
          // defaults to the signed-in user -- that is the session the write
          // rides -- so created_via is what tells an agent's work apart.
          created_via: 'mcp',
          created_by_label: payload.agent?.name || 'Agent',
          // The grid sorts newest-first on this the moment it lands.
          created_at: new Date().toISOString(),
        };
        if (automation.notify_connector_id && !automation.notify_on) {
          throw new ApiError('notifyConnectorId requires notifyOn (always or failure)', 400);
        }
        // callAutomation references resolved now, not at run time: an id that
        // names nothing or a circle is this call's error, with the sentence.
        requireSoundCallTree(automation, [automation, ...state.automations]);
        // exists: false, so this is an INSERT and never an upsert. The org's
        // automation_limit is enforced by trg_automation_limit on the way in
        // and comes back through here as a plain sentence.
        const error = await automationActions.save(automation, false);
        if (error) {
          throw new ApiError(error, 400);
        }
        toast.setMessage(`Created ${automation.name}`);
        return {automation};
      },
      cloud);

  useApiChannel(
      'monti:update-automation-request',
      async (payload: {
        requestId: string;
        automationId: string;
        name?: string;
        description?: string;
        steps?: AutomationStep[];
        tags?: string[];
        pinned?: boolean;
        timeoutMs?: number;
        closeOnFinish?: boolean;
        icon?: string;
        color?: string;
        folderId?: string;
        notifyOn?: string;
        notifyConnectorId?: string;
        variables?: Record<string, unknown>;
        // routes.json has always declared this and automationExtras has always
        // read it; only this type left it out, so it worked structurally while
        // saying the field did not exist.
        parameters?: unknown;
        schedule?: unknown;
      }) => {
        requireSignedIn();
        const existing = requireAutomation(payload.automationId);
        // Only what was sent. Spreading the payload wholesale would write
        // `undefined` over every field the caller left out, which is how a
        // rename would silently empty the step list. automationExtras keeps
        // the same contract: absent keys stay absent. created_via and
        // created_by_label are deliberately not editable -- attribution is
        // set once at create.
        const next: MontiAutomation = {
          ...existing,
          ...(payload.name !== undefined ? {name: payload.name.trim()} : {}),
          ...(payload.description !== undefined ?
            {description: payload.description.trim() || null} :
            {}),
          ...(payload.steps !== undefined ? {steps: payload.steps} : {}),
          ...(payload.tags !== undefined ? {tags: payload.tags} : {}),
          ...(payload.pinned !== undefined ? {pinned: payload.pinned} : {}),
          ...(payload.timeoutMs !== undefined ?
            {timeout_ms: Math.min(payload.timeoutMs, 600000)} :
            {}),
          ...(payload.closeOnFinish !== undefined ?
            {close_on_finish: payload.closeOnFinish} :
            {}),
          ...automationExtras(payload),
        };
        if (next.notify_connector_id && !next.notify_on) {
          throw new ApiError('notifyConnectorId requires notifyOn (always or failure)', 400);
        }
        // Checked against the workspace with this edit applied: an update
        // that would introduce a cycle is refused here, by name, instead of
        // surfacing as a failed run later.
        requireSoundCallTree(
            next, state.automations.map((item) => item.id === next.id ? next : item));
        const error = await automationActions.save(next, true);
        if (error) {
          throw new ApiError(error, 400);
        }
        toast.setMessage(`Updated ${next.name}`);
        return {automation: next};
      },
      cloud);

  // Run outcomes for an agent: how a run started with monti_run_automation
  // ended. Without `log` and `vars` -- they are the bulk of a run row, and an
  // agent that wants the play-by-play can ask for a narrower tool when one
  // exists. Reads the runs table, not session state, so a run finished by a
  // teammate's launcher answers too.
  useApiChannel(
      'monti:list-automation-runs-request',
      async (payload: {requestId: string; automationId: string; limit?: number}) => {
        requireSignedIn();
        requireAutomation(payload.automationId);
        const runs = await db.runs.list(data.orgId || '', {
          automationId: payload.automationId,
          limit: Math.min(Math.max(1, payload.limit ?? 20), 50),
        });
        return {
          runs: runs.map((run) => ({
            id: run.id,
            profileId: run.profile_id,
            profileName: run.profile_name || null,
            trigger: run.trigger,
            status: run.status,
            startedAt: run.started_at,
            finishedAt: run.finished_at || null,
            durationMs: run.duration_ms ?? null,
            stepCount: run.step_count ?? null,
            failedStepId: run.failed_step_id || null,
            error: run.error || null,
          })),
        };
      },
      cloud);

  // ── Profile notes ─────────────────────────────────────────────────────────
  //
  // Read and append, and deliberately nothing else. There is no edit or delete
  // over this bridge, for a reason that is not squeamishness: every write here
  // runs through the signed-in user's Supabase session, so RLS sees
  // created_by = auth.uid() on that person's own notes and would happily let an
  // agent rewrite them. The database can refuse an agent editing an agent note
  // -- author_kind = 'user' is in the update policy -- but it cannot tell that
  // a write claiming to be the user is not. So agents append to the backlog and
  // never rewrite it, and the missing tools are the enforcement.
  useApiChannel(
      'monti:list-profile-notes-request',
      async (payload: {
        requestId: string;
        profileId: string;
        limit?: number;
        allowedFolders?: string[] | null;
      }) => {
        requireSignedIn();
        const profile = await resolveInScope(payload.profileId, payload.allowedFolders);
        if (!profile) {
          throw new ApiError(
              `Profile ${payload.profileId} is not visible to this key`, 403);
        }
        const notes = await db.profileNotes.list(data.orgId as string, profile.id, {
          limit: typeof payload.limit === 'number' ? payload.limit : undefined,
        });
        // The author is resolved to a name here rather than handed over as a
        // uuid: an agent has no way to look one up, and `created_by` alone would
        // make every note read as an opaque id.
        return {
          profileId: profile.id,
          notes: notes.map((note) => ({
            id: note.id,
            body: note.body,
            author: note.author_kind === 'agent' ?
              note.author_label || 'Agent' :
              assigneeName(note.created_by, state.members) || 'Unknown',
            authorKind: note.author_kind,
            createdAt: note.created_at,
            updatedAt: note.updated_at,
          })),
        };
      },
      [state, data.orgId]);

  useApiChannel(
      'monti:add-profile-note-request',
      async (payload: {
        requestId: string;
        profileId: string;
        body: string;
        agent?: {id: string; name: string};
        allowedFolders?: string[] | null;
      }) => {
        requireSignedIn();
        const body = typeof payload.body === 'string' ? payload.body.trim() : '';
        if (!body) {
          throw new ApiError('A note needs a body.', 400);
        }
        if (body.length > 2000) {
          throw new ApiError('A note is at most 2000 characters.', 400);
        }
        const profile = await resolveInScope(payload.profileId, payload.allowedFolders);
        if (!profile) {
          throw new ApiError(
              `Profile ${payload.profileId} is not visible to this key`, 403);
        }
        // The key's own name is what the note is filed under. Falling back to a
        // bare 'Agent' rather than to the signed-in user is the point of the
        // whole path: an unnamed key is still not a person.
        const note = await profileNoteActions.add(profile.id, body, {
          label: payload.agent?.name || 'Agent',
        });
        if (!note) {
          throw new Error('Failed to save to cloud state.');
        }
        toast.setMessage(`Noted on ${profile.name}`);
        return {noteId: note.id, profileId: profile.id, createdAt: note.created_at};
      },
      [state, data.orgId]);

  useApiChannel(
      'monti:delete-automation-request',
      async ({automationId}: {requestId: string; automationId: string}) => {
        requireSignedIn();
        // Trashed rows stay in `state.automations`, so this has to say so
        // rather than let a second delete look like it did something.
        const existing = state.automations.find(
            (item) => item.id === automationId && !item.deleted_at);
        if (!existing) {
          throw new ApiError(`No automation with id ${automationId}`, 404);
        }
        // To Trash, not gone. An agent deleting a workflow it misread is the
        // case this protects, and the app offers no permanent delete outside
        // Trash either -- the two surfaces mean the same thing by "delete".
        await automationActions.softDelete([automationId]);
        toast.setMessage(`${existing.name} moved to Trash`);
        return {deleted: automationId, trashed: true};
      },
      cloud);

  useApiChannel(
      'monti:run-automation-request',
      async (payload: {
        requestId: string;
        automationId: string;
        profileId: string;
        vars?: Record<string, unknown>;
        allowedFolders?: string[] | null;
      }) => {
        const automation = requireAutomation(payload.automationId);
        // The profile still goes through the folder gate. A scoped key may run
        // a shared automation, but only against a profile it can see -- and
        // re-read from the database, not from this window's render cache, for
        // the reason resolveInScope documents.
        const profile = await resolveInScope(payload.profileId, payload.allowedFolders);
        if (!profile) {
          throw new ApiError(
              `Profile ${payload.profileId} is not visible to this key`, 403);
        }
        const result = await automationActions.run(automation, profile, {
          trigger: 'mcp',
          vars: payload.vars,
        });
        if (!result?.ok) {
          throw new ApiError(result?.error || 'The run did not start.', 409);
        }
        return {runId: result.runId, automationId: automation.id, profileId: profile.id};
      },
      cloud);

  // ── Connectors ─────────────────────────────────────────────────────────────
  //
  // The rule these five are written against: a step stores a connector id and
  // nothing else, which is what keeps every credential out of the steps, the
  // vars, the run log and run.json. An API that handed the credentials back
  // would put them somewhere worse -- an agent transcript, which is logged and
  // which the user cannot unsend. So `config` is write-only here: settable,
  // mergeable, never returned. Not masked; absent.
  //
  // This is the same line useAutomationBridge already draws around proxy
  // passwords, drawn one step further because a connector's whole purpose is
  // to be named by id rather than carried by value.
  function connectorSummary(connector: MontiConnector) {
    return {
      id: connector.id,
      name: connector.name,
      category: connector.category,
      kind: connector.kind,
      is_default: Boolean(connector.is_default),
      // Which credentials this row actually has, by key -- never their values.
      // Without it "the send failed" and "the bot token was never saved" look
      // identical from the outside, and the second is the likelier one.
      configured: Object.keys(connector.config || {})
          .filter((key) => (connector.config[key] || '').trim()),
    };
  }

  // Writes are owner-only, enforced in Postgres. An UPDATE or DELETE that RLS
  // filters out returns success with no rows, so a member's edit would look
  // like it worked -- checked here first so the refusal is a sentence with a
  // 403 rather than a lie with a 200.
  function requireConnectorOwner() {
    requireSignedIn();
    if (!org.isOwner) {
      throw new ApiError(
          'Only the workspace owner can change connectors.', 403);
    }
  }

  function requireConnector(connectorId: string): MontiConnector {
    const found = state.connectors.find((item) => item.id === connectorId);
    if (!found) {
      throw new ApiError(`No connector with id ${connectorId}`, 404);
    }
    return found;
  }

  useApiChannel(
      'monti:list-connectors-request',
      () => ({
        connectors: state.connectors.map(connectorSummary),
        // The catalogue travels with the list rather than living behind its own
        // tool: an agent that has the ids but not the field shapes still cannot
        // create one, and two calls to answer one question is two chances to
        // skip the second.
        kinds: connectorKindsForApi(),
      }),
      cloud);

  useApiChannel(
      'monti:create-connector-request',
      async (payload: {
        requestId: string;
        name: string;
        kind: string;
        config?: Record<string, unknown>;
        isDefault?: boolean;
      }) => {
        requireConnectorOwner();
        const preset = presetFor(payload.kind);
        if (!preset) {
          throw new ApiError(
              `No connector kind called ${payload.kind}. There are: ` +
              `${CONNECTOR_PRESETS.map((item) => item.kind).join(', ')}.`, 400);
        }
        const config = stringConfig(payload.config);
        const problems = validateConnectorConfig(preset.kind, config);
        if (problems.length > 0) {
          throw new ApiError(`This connector is not valid: ${problems.join('; ')}`, 400);
        }
        // blank() decides both the category (from the preset, never from the
        // caller) and whether this is the first of its category and so the
        // default by definition. Overriding either here would be re-deriving
        // what the Connectors view already derives.
        const connector: MontiConnector = {
          ...connectorActions.blank(preset.kind),
          name: payload.name.trim(),
          config,
        };
        const error = await connectorActions.save(connector, false);
        if (error) {
          throw new ApiError(error, 400);
        }
        // Promotion is its own two statements (demote, then promote) and cannot
        // ride the insert -- the partial unique index would collide with the
        // incumbent. Skipped when blank() already made it the default.
        if (payload.isDefault && !connector.is_default) {
          await connectorActions.setDefault(connector.id);
        }
        toast.setMessage(`Added ${connector.name}`);
        return {connector: connectorSummary({
          ...connector,
          is_default: connector.is_default || Boolean(payload.isDefault),
        })};
      },
      cloud);

  useApiChannel(
      'monti:update-connector-request',
      async (payload: {
        requestId: string;
        connectorId: string;
        name?: string;
        config?: Record<string, unknown>;
        isDefault?: boolean;
      }) => {
        requireConnectorOwner();
        const existing = requireConnector(payload.connectorId);
        if (payload.isDefault === false) {
          throw new ApiError(
              'A category cannot be left without a default. Promote another ' +
              'connector instead, which demotes this one.', 400);
        }
        // Merged, not replaced. A caller changing a chat id must not have to
        // re-send the bot token to keep it -- and a caller that omits config
        // entirely must not blank every credential on the row.
        const config = payload.config === undefined ?
          existing.config :
          {...existing.config, ...stringConfig(payload.config)};
        const problems = validateConnectorConfig(existing.kind, config);
        if (problems.length > 0) {
          throw new ApiError(`This connector is not valid: ${problems.join('; ')}`, 400);
        }
        const connector: MontiConnector = {
          ...existing,
          name: payload.name === undefined ? existing.name : payload.name.trim(),
          config,
        };
        if (!connector.name) {
          throw new ApiError('name cannot be empty', 400);
        }
        const error = await connectorActions.save(connector, true);
        if (error) {
          throw new ApiError(error, 400);
        }
        if (payload.isDefault && !existing.is_default) {
          await connectorActions.setDefault(connector.id);
        }
        toast.setMessage(`Updated ${connector.name}`);
        return {connector: connectorSummary({
          ...connector,
          is_default: connector.is_default || Boolean(payload.isDefault),
        })};
      },
      cloud);

  useApiChannel(
      'monti:delete-connector-request',
      async ({connectorId}: {requestId: string; connectorId: string}) => {
        requireConnectorOwner();
        const existing = requireConnector(connectorId);
        // Steps naming it are left pointing at a dead id on purpose -- see
        // db/connectors.remove. Said out loud here because the caller is the
        // one who has to go fix them.
        const naming = state.automations
            .filter((automation) => automation.notify_connector_id === connectorId)
            .map((automation) => automation.name);
        if (!await connectorActions.remove(connectorId)) {
          throw new Error('Failed to delete the connector.');
        }
        toast.setMessage(`Deleted ${existing.name}`);
        return {
          deleted: connectorId,
          // Only the automation-level setting can be checked cheaply; a step
          // naming it sits inside the steps tree and is found by running it.
          notifyOnFinishBroken: naming,
        };
      },
      cloud);

  useApiChannel(
      'monti:test-connector-request',
      async ({connectorId}: {requestId: string; connectorId: string}) => {
        requireConnectorOwner();
        const connector = requireConnector(connectorId);
        if (!native?.testConnector) {
          throw new ApiError('Testing a connector needs the desktop app.', 503);
        }
        // The same resolved shape a run gets, so a test that passes proves the
        // thing a run would actually send with -- not a second code path.
        const result = await native.testConnector(runtimeConnector(connector));
        if (!result.ok) {
          // The service's own words. "chat not found" is the whole diagnosis;
          // "the test failed" is none of it.
          throw new ApiError(result.error || 'The test failed.', 502);
        }
        return {ok: true, connectorId, kind: connector.kind};
      },
      cloud);

  // ── Workspace vocabulary ───────────────────────────────────────────────────
  //
  // Two read-only lists that exist because other tools already take their
  // values. folderId is settable on four routes and status is a free string on
  // two, and until now neither could be discovered from outside the app -- so an
  // agent either guessed or left them alone. Read-only because creating a folder
  // or inventing a status is a workspace decision, not a side effect of a script.
  useApiChannel(
      'monti:list-folders-request',
      (payload: {requestId: string; allowedFolders?: string[] | null}) => {
        const visible = (folders: typeof state.folders) => (payload.allowedFolders ?
          folders.filter((folder) => payload.allowedFolders!.includes(folder.id)) :
          folders);
        const shape = (folder: {id: string; name: string}) =>
          ({id: folder.id, name: folder.name});
        return {
          // Scope applies to profile folders only: it is a gate on profiles,
          // and the other three libraries it does not cover are listed whole
          // rather than filtered by an id set that means nothing to them.
          profiles: visible(state.folders).map(shape),
          proxies: state.proxy_folders.map(shape),
          cookies: state.cookie_folders.map(shape),
          automations: state.automation_folders.map(shape),
        };
      },
      cloud);

  useApiChannel(
      'monti:list-statuses-request',
      () => ({
        // Built-ins differ per table (a proxy is never in Warmup); custom
        // labels are org-wide and offered by all three pickers, which is why
        // they are listed once rather than folded into each list.
        profiles: baseProfileStatuses,
        proxies: baseProxyStatuses,
        cookies: baseCookieStatuses,
        custom: state.custom_statuses,
      }),
      cloud);

  // ── Personal Telegram ──────────────────────────────────────────────────────
  //
  // Not connectors, and the confusion between the two is worth naming: a
  // telegram CONNECTOR is org-shared, carries its own bot token and is what a
  // notify step sends through. This is the per-person channel -- the workspace's
  // notification bot messaging the member's own chat when a run they subscribed
  // to finishes. Separate table, separate opt-in, no id.
  //
  // Neither the bot token nor the chat id leaves through here. The token is a
  // workspace credential and the chat id identifies a person's Telegram account;
  // an agent needs neither to answer "am I set up" or to change a subscription.
  useApiChannel(
      'monti:telegram-status-request',
      () => ({
        botConfigured: Boolean(org.org?.telegram_bot_token),
        botName: org.org?.telegram_bot_name || null,
        linked: Boolean(state.telegram_link),
        telegramUsername: state.telegram_link?.telegram_username || null,
        linkedAt: state.telegram_link?.linked_at || null,
        prefs: state.telegram_prefs.map((pref) => ({
          automationId: pref.automation_id,
          notifyOn: pref.notify_on,
        })),
        // Linking needs a human to press Start in Telegram, and the launcher
        // watches the bot's getUpdates feed for up to two minutes waiting for
        // it -- four times this API's own request timeout. So it stays in the
        // app, and this says so rather than leaving a caller to invent a reason.
        ...(state.telegram_link ? {} : {
          howToLink: 'Open Scout Web → Automations → Notification bot and press ' +
            'Link Telegram. It needs someone to press Start in the bot, so it ' +
            'cannot be done over this API.',
        }),
      }),
      [state, org.org]);

  useApiChannel(
      'monti:set-telegram-pref-request',
      async (payload: {requestId: string; automationId: string; notifyOn?: string}) => {
        requireSignedIn();
        requireAutomation(payload.automationId);
        const wanted = (payload.notifyOn || '').trim();
        if (wanted && wanted !== 'always' && wanted !== 'failure') {
          throw new ApiError('notifyOn must be always, failure, or empty to unsubscribe', 400);
        }
        // Refused rather than stored: a subscription with nowhere to send is a
        // setting that reads as on and does nothing, which is the failure this
        // whole route exists to make diagnosable.
        if (wanted && !state.telegram_link) {
          throw new ApiError(
              'This user has not linked their Telegram. Open Scout Web → Automations → ' +
              'Notification bot and press Link Telegram first.', 409);
        }
        await automationActions.setTelegramPref(
            payload.automationId, wanted ? (wanted as 'always' | 'failure') : null);
        return {automationId: payload.automationId, notifyOn: wanted || null};
      },
      cloud);

  useApiChannel(
      'monti:set-telegram-bot-request',
      async (payload: {requestId: string; botName: string; botToken: string}) => {
        requireSignedIn();
        const name = payload.botName.trim().replace(/^@/, '');
        const token = payload.botToken.trim();
        if (!name || !token) {
          throw new ApiError('botName and botToken are both required', 400);
        }
        // db.orgs.setTelegramBot turns RLS's success-with-no-rows back into a
        // sentence, so the owner check is already honest there -- no second one
        // here. withDbError rather than withDb: withDb toasts and returns
        // false, which would answer this call 200 after saving nothing.
        const error = await data.withDbError(
            (activeOrgId) => db.orgs.setTelegramBot(activeOrgId, token, name));
        if (error) {
          throw new ApiError(error, 403);
        }
        await org.reload({quiet: true});
        toast.setMessage(`Notification bot set to @${name}`);
        // The token is not echoed. It never is, from anywhere in this file.
        return {botName: name, botConfigured: true};
      },
      cloud);

  // The two routes that let an agent set up a table the way the user would.
  //
  // Not folder-scoped: a layout is a property of the person, not of the rows,
  // and a key granted one folder changing its own user's view harms nothing --
  // which is why these are `scope: any` where authoring an automation is not.

  // Discovery. An agent that has to guess "browser version" is `fpBrowser` gets
  // one failed call and no way to learn from it; this says what exists, what is
  // on, and what cannot be turned off.
  useApiChannel(
      'monti:table-columns-request',
      () => ({tables: describeAllTables(columnLayouts.layouts, {isTeam})}),
      [columnLayouts.layouts, isTeam]);

  useApiChannel(
      'monti:set-table-columns-request',
      (payload: {requestId: string; table?: string} & ColumnChange) => {
        requireSignedIn();
        if (!isTableId(payload.table)) {
          throw new ApiError(
              `No table called ${payload.table}. There are: ${TABLE_IDS.join(', ')}.`, 400);
        }
        const table = payload.table;
        const context = {isTeam};
        // Refused whole rather than applied in part: an agent whose typo is
        // quietly dropped cannot tell that half its request did nothing.
        const problem = columnChangeProblem(table, payload, context);
        if (problem) {
          throw new ApiError(problem, 400);
        }
        const next = applyColumnChange(table, payload, columnLayouts.layouts, context);
        columnLayouts.setLayouts(next);
        // The table it just changed, in the same shape the GET answers with, so
        // a caller can check its own write without a second round trip.
        return describeTable(table, next, context);
      },
      [columnLayouts, isTeam]);
}
