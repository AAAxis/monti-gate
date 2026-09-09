// The org's data and everything that mutates it, in one place. Tabs and
// dialogs read from here instead of being handed two dozen props each, which
// is what let them be split out of the old single-component App at all.
import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {baseCookieStatuses, baseProfileStatuses, baseProxyStatuses} from '../data/statuses';
import {tagsInUse} from '../lib/tags';
import {statusList} from '../lib/text';
import {useAutomationScheduler} from '../hooks/useAutomationScheduler';
import {useToast} from '../hooks/useToast';
import {native} from '../native';
import {useOrg} from '../org';
import {useCloudData} from './useCloudData';
import {useCookieActions} from './useCookieActions';
import {useLibraryActions} from './useLibraryActions';
import {useProfileActions} from './useProfileActions';
import {useProfileNotes} from './useProfileNotes';
import {useConnectorActions} from './useConnectorActions';
import {useAutomationActions} from './useAutomationActions';
import {useProxyActions} from './useProxyActions';
import {useSharedActions} from './useSharedActions';
import {useTeamActions} from './useTeamActions';
import type {Toast} from '../hooks/useToast';
import type {WorkspaceCore} from './core';
import type {TagUsage} from '../lib/tags';
import type {CloudData} from './useCloudData';
import type {CookieActions} from './useCookieActions';
import type {LibraryActions} from './useLibraryActions';
import type {ProfileActions} from './useProfileActions';
import type {ProfileNoteActions} from './useProfileNotes';
import type {ConnectorActions} from './useConnectorActions';
import type {AutomationActions} from './useAutomationActions';
import type {ProxyActions} from './useProxyActions';
import type {SharedActions} from './useSharedActions';
import type {TeamActions} from './useTeamActions';

export type WorkspaceValue = {
  data: CloudData;
  toast: Toast;
  profiles: ProfileActions;
  // A profile's note thread. Separate from ProfileActions because a note is not
  // a column on the profile row -- it is its own table, read on demand, and the
  // only thing in CloudState it touches is the summary the Notes column shows.
  profileNotes: ProfileNoteActions;
  proxies: ProxyActions;
  library: LibraryActions;
  cookies: CookieActions;
  automations: AutomationActions;
  connectors: ConnectorActions;
  // Members and invites. The roster itself is in data.state.members, since the
  // Profiles table reads it too; this is the mutations plus the invite list,
  // which only the owner can see.
  team: TeamActions;
  // Pending hand-offs between teammates, and the assignment actions. The
  // assignments themselves are a column on the four entity tables, so they
  // arrive in data.state with the rows. See useSharedActions.
  shared: SharedActions;
  // Which profile row is highlighted. Lives here rather than in the Profiles
  // tab because deletes and saves have to keep it pointing at something real.
  selectedProfileId: string | null;
  setSelectedProfileId: (id: string | null) => void;
  // Which proxies are mid-check. A set because a batch check runs several at
  // once; see WorkspaceCore.
  checkingProxyIds: ReadonlySet<string>;
  beginProxyCheck: (id: string) => void;
  endProxyCheck: (id: string) => void;
  // Built-in statuses, the org's custom ones, and anything a profile is
  // already using -- so a status that only exists on an imported row still
  // shows up in the dropdowns instead of silently resetting to Ready.
  statusOptions: string[];
  // The same, for the two other tables that carry a status. Separate lists
  // rather than one shared one because the built-in halves differ per table
  // (a proxy is never in Warmup); the custom halves are identical.
  proxyStatusOptions: string[];
  cookieStatusOptions: string[];
  // Every tag the org's profiles actually carry, most used first and the user's
  // own words ahead of the catalogued brands. The picker offers the user half,
  // the table's filter offers all of it -- neither needs to walk the profiles
  // again to find out what exists.
  tagOptions: TagUsage[];
  // The same thing for the cookie-set library, kept as a separate list rather
  // than merged into tagOptions: that one feeds the Profiles filter dropdown
  // and the folder suggestions, so a cookie-only tag in it would offer a filter
  // that empties the profiles table. The half worth sharing is shared anyway --
  // both go through tagKey() and the same brand catalog, so "Instagram" on a
  // set and "instagram" on a profile render identically.
  cookieTagOptions: TagUsage[];
  reload: () => void;
  // The whole workspace, on demand: what the window-focus refresh pulls, minus
  // its throttle. Awaitable so a Refresh button can spin its icon for exactly
  // as long as the fetch takes rather than guessing at a duration.
  refresh: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  }
  return value;
}

export function WorkspaceProvider({children}: {children: ReactNode}) {
  const org = useOrg();
  const orgId = org.orgId;
  const toast = useToast();
  const data = useCloudData(orgId, toast);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [checkingProxyIds, setCheckingProxyIds] = useState<ReadonlySet<string>>(new Set());

  // Both take the previous set rather than replacing it, so concurrent checks
  // each own only their own id.
  const beginProxyCheck = useCallback((id: string) => {
    setCheckingProxyIds((current) => new Set(current).add(id));
  }, []);
  const endProxyCheck = useCallback((id: string) => {
    setCheckingProxyIds((current) => {
      if (!current.has(id)) {
        return current;
      }
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const core: WorkspaceCore = {
    data,
    toast,
    selectedProfileId,
    setSelectedProfileId,
    checkingProxyIds,
    beginProxyCheck,
    endProxyCheck,
  };
  const proxies = useProxyActions(core);
  const profiles = useProfileActions(core, proxies);
  const profileNotes = useProfileNotes(core);
  const library = useLibraryActions(core);
  const cookies = useCookieActions(core);
  // Takes orgId and the sign-in state directly rather than through core: run
  // records are written by whoever is signed in, and a run that starts while
  // signed out has to buffer to disk instead of failing.
  const automations = useAutomationActions(core, proxies, orgId, Boolean(org.userId));
  // The schedule ticker. Mounted here, not on the Automations tab: a schedule
  // fires whichever tab is open, and only while this window exists -- which is
  // the stated contract ("while the launcher is open").
  useAutomationScheduler(orgId, Boolean(org.userId), data.state, automations);
  // Mounted here rather than in the Connectors view: it pushes the connector
  // list into the main process on every change, and that has to keep happening
  // whether or not that view is open.
  const connectors = useConnectorActions(core);
  const team = useTeamActions(core);
  const shared = useSharedActions(core);

  const {load, reset} = data;
  const {setMessage} = toast;
  const {load: loadHandoffs} = shared;
  const {reload: reloadOrg} = org;

  useEffect(() => {
    if (org.error) {
      setMessage(org.error);
    }
  }, [org.error, setMessage]);

  // Reload whenever the active organization changes. Everything keyed by an id
  // has to be dropped first: a profile id from org A is also a real directory
  // under E:\ScoutProfiles, so a leaked selection would launch the wrong
  // firm's data.
  useEffect(() => {
    reset();
    setSelectedProfileId(null);
    if (!orgId) {
      return;
    }
    void load(orgId).then((loaded) => {
      if (loaded) {
        setSelectedProfileId(loaded.profiles.find((profile) => !profile.deleted_at)?.id || null);
      }
    });
  }, [orgId, load, reset]);

  // Built-in extensions whose files are downloaded rather than vendored (see
  // electron/built-in-extensions.cjs) have an org-wide toggle but per-machine
  // bytes. So when a colleague enables one, this machine arrives with the
  // toggle already on and nothing on disk, and it never sees the click that
  // would have fetched it. Ask main to fill any such gap once the org's state
  // is here. Fire-and-forget: launches never wait on it, and profiles started
  // before it lands simply run without that extension.
  const builtInToggles = data.state.built_in_extensions;
  useEffect(() => {
    if (!orgId) {
      return;
    }
    void native?.catchUpBuiltInExtensions?.(builtInToggles);
  }, [orgId, builtInToggles]);

  // When the workspace was last pulled, so the focus listener below can throttle
  // itself. A manual refresh stamps it too: pressing Refresh and then alt-tabbing
  // back should not fetch the same eight tables twice in a second.
  const lastRefreshRef = useRef(0);

  // Everything a "somebody else may have changed something" pull covers, in one
  // place, so the focus trigger and the toolbar's Refresh button can never drift
  // into fetching different sets.
  //
  // Quiet on purpose: `load` without it swaps the whole tab for the full-screen
  // LoadingState, which is right for the first load of a workspace and wrong for
  // a re-read of one already on screen. Callers that want a visible wait show it
  // on the control that started it.
  const refreshAll = useCallback(async (targetOrgId: string) => {
    lastRefreshRef.current = Date.now();
    await Promise.all([
      load(targetOrgId, {quiet: true}),
      // No poll of its own. There is no realtime anywhere in this app, so
      // something a colleague hands you while the launcher is in the background
      // surfaces when you come back to it -- which is the only moment you could
      // act on it anyway.
      loadHandoffs(targetOrgId),
      // The organizations row itself, which nothing else here reloads.
      //
      // `load` fetches the workspace -- profiles, proxies, cookies, automations
      // -- and OrgProvider re-resolves only on an auth event, so until this line
      // existed a plan change was invisible until the next token refresh or
      // sign-in. That is the whole of the purchase hand-off: the site's
      // thank-you page sends `scout://open`, electron/main.cjs focuses the
      // window, and this is what turns that focus into the new plan, the new
      // limits and the welcome screen. An admin comp grant and a colleague
      // upgrading the workspace arrive the same way.
      reloadOrg({quiet: true}),
    ]);
  }, [load, loadHandoffs, reloadOrg]);

  // A second worker's changes only reach this machine when we ask for them.
  // Window focus is the cheapest honest trigger: it is exactly the moment the
  // user comes back to the launcher, and eight small selects are far less
  // traffic than a poll. Throttled so alt-tabbing does not hammer the API.
  useEffect(() => {
    if (!orgId) {
      return;
    }
    const onFocus = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      if (Date.now() - lastRefreshRef.current < 10000) {
        return;
      }
      void refreshAll(orgId);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [orgId, refreshAll]);

  // Hand-offs are org-scoped, so unlike the workspace load this follows the org
  // switcher: what a colleague passed you in one workspace is not pending in
  // another.
  useEffect(() => {
    if (orgId) {
      void loadHandoffs(orgId);
    }
  }, [orgId, loadHandoffs]);

  const {
    custom_statuses: customStatuses, profiles: profileRows, cookies: cookieRows,
    proxies: proxyRows,
  } = data.state;
  // Three lists, one per table that carries a status: the table's own built-ins,
  // then the org's custom labels (shared by all three -- see data/statuses.ts),
  // then whatever the rows themselves already say, so a label deleted from the
  // library still appears in the picker of a row that kept it.
  const statusOptions = useMemo(
      () => statusList(
          baseProfileStatuses,
          customStatuses,
          profileRows.map((profile) => profile.status)),
      [customStatuses, profileRows],
  );
  const proxyStatusOptions = useMemo(
      () => statusList(
          baseProxyStatuses,
          customStatuses,
          proxyRows.map((proxy) => proxy.status)),
      [customStatuses, proxyRows],
  );
  const cookieStatusOptions = useMemo(
      () => statusList(
          baseCookieStatuses,
          customStatuses,
          cookieRows.map((cookie) => cookie.status)),
      [customStatuses, cookieRows],
  );
  const tagOptions = useMemo(() => tagsInUse(profileRows), [profileRows]);
  const cookieTagOptions = useMemo(() => tagsInUse(cookieRows), [cookieRows]);

  // Deliberately not memoized: several of the action closures read the current
  // cloudState, so a stable identity would hand consumers stale data. The old
  // single-component App re-rendered everything on any state change anyway, so
  // this costs nothing it did not already cost.
  const value: WorkspaceValue = {
    data,
    toast,
    profiles,
    profileNotes,
    proxies,
    library,
    cookies,
    automations,
    connectors,
    team,
    shared,
    selectedProfileId,
    setSelectedProfileId,
    checkingProxyIds,
    beginProxyCheck,
    endProxyCheck,
    statusOptions,
    proxyStatusOptions,
    cookieStatusOptions,
    tagOptions,
    cookieTagOptions,
    reload: () => {
      if (orgId) {
        void load(orgId, {quiet: true});
      }
    },
    refresh: () => (orgId ? refreshAll(orgId) : Promise.resolve()),
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
