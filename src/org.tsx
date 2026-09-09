// Org context: which tenant the signed-in user is currently looking at.
//
// Everything under src/db/ takes an orgId explicitly, and this is where that id
// comes from. It lives outside App so it can own the auth subscription -- the
// app previously sampled the session only at boot and on an explicit sign-in,
// which meant a token refresh or a sign-out in another window went unnoticed.
import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import type {User} from '@supabase/supabase-js';
import {
  accountAvatarUrl,
  accountDisplayName,
  accountHasCustomAvatar,
  accountProviders,
  accountTableColumns,
} from './db/account';
import * as orgsDb from './db/orgs';
import {describeDbError} from './db/errors';
import {supabase} from './supabase';
import type {ScoutOrg, OrgMembership, OrgRole} from './types';
import type {TableLayouts} from './tables/columns';

export type OrgContextValue = {
  // False while the user's memberships are still being resolved. App waits on
  // this before loading anything, so it never issues a query with a null org.
  ready: boolean;
  userId: string | null;
  email: string;
  // Profile picture: the one uploaded in Settings if there is one, otherwise
  // whatever the identity provider supplied. Google sign-in populates the
  // latter; email/OTP sign-ins have neither, and the account row falls back to
  // the initials circle. See db/account.ts for the precedence and why.
  avatarUrl: string;
  // True when that picture was uploaded here rather than taken from Google --
  // the only case where Settings can offer to remove it.
  hasCustomAvatar: boolean;
  // Chosen in Settings, falling back to the provider's name. Empty for an
  // email-code account that has never set one -- callers show the address.
  displayName: string;
  // Auth provider ids ('email', 'google'), for "Signed in with".
  providers: string[];
  // ISO timestamp of when the account was created, for "Member since".
  createdAt: string | null;
  // Which columns this person's tables show, as their deviations from the
  // defaults. Derived here for the same reason displayName and avatarUrl are:
  // it lives in user_metadata, so the user record is where it arrives, and one
  // consumer reading `user` directly would be one consumer that has to know
  // that. See tables/ColumnLayouts.tsx, which owns the writes.
  tableColumns: TableLayouts;
  orgs: OrgMembership[];
  orgId: string | null;
  org: ScoutOrg | null;
  role: OrgRole | null;
  // Whether this person owns any workspace at all. False for somebody who
  // arrived by invitation and has never made one of their own -- bootstrap_org
  // hands them the workspace they were invited into and stops, so without being
  // asked they would never get one. App uses this to decide whether to ask.
  ownsAny: boolean;
  // When we last asked that question, or null for never. Account-level rather
  // than per-org: they are sitting in somebody else's workspace, and an org
  // column would re-ask them from the next one they join.
  personalPromptAt: string | null;
  // Whether the database behind this build has 20260808000000 applied. A
  // launcher ships to machines and can meet an older schema; the prompt and the
  // server-side active workspace are both suppressed rather than erroring when
  // it has not, which leaves exactly the behaviour that shipped before them.
  promptSupported: boolean;
  // Whether this person holds the account. The owner is the only one who can
  // invite, remove, or mint an API token -- org_invites, the delete policy on
  // org_members, and the write policies on api_tokens are all is_org_owner, so a
  // member's attempt would fail silently at the UI layer.
  //
  // NOT a gate on the workspace's own settings. The name, branding and built-in
  // extension toggles are is_org_member as of 2026-08-10, and the entitlement
  // columns are unwritable by anyone -- so neither needs asking about here.
  isOwner: boolean;
  error: string;
  setOrgId: (id: string) => void;
  // `quiet` is for a refresh the user did not ask for -- the window-focus one in
  // WorkspaceProvider. It keeps `ready` true and leaves the current memberships
  // in place if the read fails, because the loud version of both is wrong for a
  // background poll: `ready` going false swaps the whole app for the startup
  // loader (App.tsx gates on it), and clearing `orgs` on a dropped connection
  // would evict someone from their workspace mid-session. Same word and same
  // meaning as useCloudData's `load(orgId, {quiet: true})`, which rides the same
  // trigger.
  reload: (options?: {quiet?: boolean}) => Promise<void>;
  // Re-reads the user record. Settings calls this after an avatar or name edit
  // so the sidebar and the dialog update without waiting for the next auth
  // event -- updateUser() does not emit one.
  refreshUser: (next?: User | null) => Promise<void>;
};

const EMPTY: OrgContextValue = {
  ready: false,
  userId: null,
  email: '',
  avatarUrl: '',
  hasCustomAvatar: false,
  displayName: '',
  providers: [],
  createdAt: null,
  tableColumns: {},
  orgs: [],
  orgId: null,
  org: null,
  role: null,
  ownsAny: false,
  personalPromptAt: null,
  promptSupported: false,
  isOwner: false,
  error: '',
  setOrgId: () => {},
  reload: async () => {},
  refreshUser: async () => {},
};

const OrgContext = createContext<OrgContextValue>(EMPTY);

export function useOrg(): OrgContextValue {
  return useContext(OrgContext);
}

export function OrgProvider({children}: {children: ReactNode}) {
  const [ready, setReady] = useState(false);
  // The whole user record rather than the two fields the header needs: Settings
  // reads the creation date, the linked identities and the metadata off it, and
  // keeping one object means an avatar edit updates every consumer at once.
  const [user, setUser] = useState<User | null>(null);
  const [orgs, setOrgs] = useState<OrgMembership[]>([]);
  const [orgId, setOrgIdState] = useState<string | null>(null);
  const [personalPromptAt, setPersonalPromptAt] = useState<string | null>(null);
  const [promptSupported, setPromptSupported] = useState(false);
  const [error, setError] = useState('');
  // Guards against a second resolve landing out of order after a fast
  // sign-out/sign-in, which would show the previous user's orgs.
  const generation = useRef(0);
  // setOrgId is declared before reload and needs to reach it. Held in a ref
  // rather than taken as a dependency because reload closes over `user`, so
  // depending on it would rebuild setOrgId -- and with it every consumer of the
  // context -- on each hourly token refresh.
  const reloadRef = useRef<((options?: {quiet?: boolean}) => Promise<void>) | null>(null);

  const resolve = useCallback(async (uid: string | null, quiet = false) => {
    const run = ++generation.current;
    if (!uid) {
      setOrgs([]);
      setOrgIdState(null);
      setPersonalPromptAt(null);
      setPromptSupported(false);
      setError('');
      setReady(true);
      return;
    }
    if (!quiet) {
      setReady(false);
    }
    try {
      // In parallel, and it has to stay that way: this pair is on the startup
      // path in front of `ready`, and awaiting them in sequence would make every
      // cold start slower to serve a dialog that shows once in an account's
      // life.
      const [state, listed] = await Promise.all([
        orgsDb.accountState(),
        orgsDb.listMyOrgs(),
      ]);
      let memberships = listed;
      let serverActive = state.activeOrgId;
      if (memberships.length === 0) {
        // No org yet: bootstrap_org is SECURITY DEFINER and idempotent, and is
        // the only path a client has -- organizations has no INSERT policy.
        await orgsDb.createOrg();
        memberships = await orgsDb.listMyOrgs();
        serverActive = memberships[0]?.org.id || null;
      }
      if (run !== generation.current) {
        return;
      }

      // Server first, this machine second. The localStorage value is a hint for
      // when the server could not be asked -- an older database, or a resolve
      // that raced a dropped connection -- and it has to LOSE whenever there is
      // a server answer, because agreeing with the website is the entire point
      // of active_org() existing.
      //
      // Both are validated against the membership list before use: an id for a
      // workspace the user has since left must not survive either route.
      const hinted = orgsDb.currentOrgId();
      const active =
        memberships.find((item) => item.org.id === serverActive)?.org.id ||
        memberships.find((item) => item.org.id === hinted)?.org.id ||
        memberships[0]?.org.id || null;

      setOrgs(memberships);
      setOrgIdState(active);
      orgsDb.setCurrentOrgId(active);
      setPersonalPromptAt(state.personalPromptAt);
      setPromptSupported(state.supported);
      setError('');

      // Converge. The hint won, which means either a switch made while offline
      // or a set_active_org that failed after one -- push it now that the server
      // is reachable. Silent: nothing the user just did has failed, and the next
      // resolve would do this anyway.
      if (state.supported && active && active !== serverActive) {
        void orgsDb.setActiveOrg(active).catch(() => {});
      }
    } catch (caught) {
      if (run !== generation.current) {
        return;
      }
      if (quiet) {
        // Keep what we already had. A background refresh that fails means the
        // network blinked, not that the workspace went away -- and dropping the
        // memberships here would take the signed-in user to the startup loader
        // for as long as it lasted.
        return;
      }
      setOrgs([]);
      setOrgIdState(null);
      setError(describeDbError(caught, 'Could not load your organization.'));
    } finally {
      if (run === generation.current) {
        setReady(true);
      }
    }
  }, []);

  // The user we last resolved for. Held in a ref rather than compared against
  // the `user` state because getUser() and the INITIAL_SESSION event both
  // arrive at boot, and a state read would still be stale for the second one.
  const resolvedFor = useRef<string | null | undefined>(undefined);

  const applyUser = useCallback((next: User | null) => {
    setUser(next);
    const nextId = next?.id || null;
    // TOKEN_REFRESHED fires repeatedly with the same user; re-resolving on each
    // one would refetch the membership list for no reason.
    if (resolvedFor.current === nextId) {
      return;
    }
    resolvedFor.current = nextId;
    void resolve(nextId);
  }, [resolve]);

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    let cancelled = false;
    const apply = (next: User | null) => {
      if (!cancelled) {
        applyUser(next);
      }
    };
    void supabase.auth.getUser().then(({data}) => apply(data.user || null));
    const {data: subscription} = supabase.auth.onAuthStateChange((_event, session) => {
      apply(session?.user || null);
    });
    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, [applyUser]);

  // Synchronous on purpose. Everything the user can see re-keys off this state,
  // and a switcher that waits on a round trip before the sidebar changes reads
  // as broken on a slow connection -- so the local switch happens first,
  // unconditionally, and the server is told afterwards.
  //
  // What the RPC can fail to do is agree with the website. It cannot fail to
  // switch this machine, which has already switched and will still be switched
  // after a restart because the hint was written above. A toast would therefore
  // report a failure the user can neither see nor act on; resolve() reconciles
  // on the next sign-in or focus refresh.
  //
  // The one failure worth surfacing is not_a_member: the membership went away
  // between the switcher rendering and the click, so the workspace list itself
  // is stale and re-resolving is what removes it.
  const setOrgId = useCallback((id: string) => {
    setOrgIdState(id);
    orgsDb.setCurrentOrgId(id);
    void orgsDb.setActiveOrg(id).catch((caught) => {
      if (String((caught as Error)?.message || caught).includes('not_a_member')) {
        void reloadRef.current?.();
        return;
      }
      console.warn('set_active_org failed; keeping the local choice', caught);
    });
  }, []);

  const reload = useCallback(async (options?: {quiet?: boolean}) => {
    const uid = user?.id || null;
    resolvedFor.current = uid;
    await resolve(uid, Boolean(options?.quiet));
  }, [resolve, user]);
  reloadRef.current = reload;

  // updateUser() returns the new record and emits no auth event, so Settings
  // hands it straight back here rather than paying for a second round trip.
  // Called with nothing, this re-reads the user from the server.
  const refreshUser = useCallback(async (next?: User | null) => {
    if (next !== undefined) {
      applyUser(next);
      return;
    }
    if (!supabase) {
      return;
    }
    const {data} = await supabase.auth.getUser();
    applyUser(data.user || null);
  }, [applyUser]);

  const value = useMemo<OrgContextValue>(() => {
    const membership = orgs.find((item) => item.org.id === orgId) || null;
    return {
      ready,
      userId: user?.id || null,
      email: user?.email || '',
      avatarUrl: accountAvatarUrl(user),
      hasCustomAvatar: accountHasCustomAvatar(user),
      displayName: accountDisplayName(user),
      providers: accountProviders(user),
      createdAt: user?.created_at || null,
      tableColumns: accountTableColumns(user),
      orgs,
      orgId,
      org: membership?.org || null,
      role: membership?.role || null,
      // Across every membership, not just the active one: the question this
      // answers is "does this person have a workspace of their own anywhere",
      // and they are almost certainly looking at somebody else's when it
      // matters.
      ownsAny: orgs.some((item) => item.role === 'owner'),
      personalPromptAt,
      promptSupported,
      isOwner: membership?.role === 'owner',
      error,
      setOrgId,
      reload,
      refreshUser,
    };
  }, [ready, user, orgs, orgId, personalPromptAt, promptSupported, error,
    setOrgId, reload, refreshUser]);

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}
