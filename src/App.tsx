// The app shell: which tab is showing, which dialog is open, and the startup
// gate in front of both. Everything with real logic behind it lives in
// workspace/ (data and mutations), hooks/ (effects) or components/.
import {useEffect, useRef, useState} from 'react';
import type {ScoutAutomation, ScoutConnector} from './types';
import {BookOpen, CircleAlert, CircleCheck, Plus, Upload, UserPlus} from 'lucide-react';
import {CopyButton} from './components/ui/CopyButton';
import {SignIn} from './components/SignIn';
import {Sidebar, Topbar, UpdateToast} from './components/Shell';
import {ProfilesTab} from './components/tabs/ProfilesTab';
import {ProxiesTab} from './components/tabs/ProxiesTab';
import {CookiesTab} from './components/tabs/CookiesTab';
import {StartPageTab} from './components/tabs/StartPageTab';
import {AutomationsTab} from './components/tabs/AutomationsTab';
import {ExtensionsTab} from './components/tabs/ExtensionsTab';
import {IntegrationsTab} from './components/tabs/IntegrationsTab';
import {TeamTab} from './components/tabs/TeamTab';
import type {TeamView} from './components/tabs/TeamTab';
import {AssignCookieSetModal} from './components/modals/AssignCookieSetModal';
import {AutomationModal} from './components/modals/AutomationModal';
import {ConnectorModal} from './components/modals/ConnectorModal';
import {RunAutomationModal} from './components/modals/RunAutomationModal';
import {RunLogModal} from './components/modals/RunLogModal';
import {CookieSetModal} from './components/modals/CookieSetModal';
import {
  AutomationDeleteModal, ProfileDeleteModal, ProxyDeleteModal, ErrorModal,
} from './components/modals/ConfirmModals';
import type {AutomationDeleteRequest} from './components/modals/ConfirmModals';
import {BookmarkModal, FolderModal, ProxyModal, StatusModal} from './components/modals/EditorModals';
import {IntegrationModal} from './components/modals/IntegrationModal';
import {
  BookmarkImportModal, CookiePickerModal, ExtensionAddModal,
} from './components/modals/LibraryModals';
import {ImportProfilesModal} from './components/modals/ImportProfilesModal';
import {ImportProxiesModal} from './components/modals/ImportProxiesModal';
import {ImportCookiesModal} from './components/modals/ImportCookiesModal';
import {IntroModal} from './components/modals/IntroModal';
import {LeaveTeamModal} from './components/modals/LeaveTeamModal';
import {PersonalWorkspaceModal} from './components/modals/PersonalWorkspaceModal';
import {PlanWelcomeModal} from './components/modals/PlanWelcomeModal';
import {WorkspaceSetupModal} from './components/modals/WorkspaceSetupModal';
import {ProfileModal} from './components/modals/ProfileModal';
import {ShareModal} from './components/modals/ShareModal';
import type {ShareRequest} from './components/modals/ShareModal';
import {
  ChangelogModal, OAuthApprovalModal,
} from './components/modals/SettingsModal';
import {SettingsDialog} from './settings/SettingsDialog';
import type {SettingsSectionId} from './settings/SettingsDialog';
import {describeStartup} from './lib/startup';
import {BusyButton} from './components/ui/BusyButton';
import {LoadingState} from './components/ui/LoadingState';
import {RefreshButton} from './components/ui/RefreshButton';
import {COOKIE_INTRO_STEPS} from './data/cookieIntro';
import {PROFILE_INTRO_STEPS} from './data/profileIntro';
import {DEFAULT_FOLDER_ICON} from './data/folderIcons';
import {DEFAULT_PROFILE_COLOR, normalizeProfileColor} from './lib/profileColors';
import {newProfileDraft, profileFromDraft} from './drafts';
import {findIntegration} from './data/integrations';
import {SITE_LINKS} from './data/links';
import {runTarget} from './automations/target';
import {SITE_URL} from './lib/auth';
import {hasSeenProfileIntro, markProfileIntroSeen} from './lib/introSeen';
import {isSidebarCollapsed, setSidebarCollapsed} from './lib/sidebarCollapsed';
import {acknowledgePlan, lastAcknowledgedPlan} from './lib/planWelcome';
import {isPlanKey, PLANS, showsPlanPicker} from './plans';
import {TRASH_FOLDER_ID} from './lib/trash';
import {useApiKeys, useIntegrations} from './hooks/useApiKeys';
import {useAutomationBridge} from './hooks/useAutomationBridge';
import {
  useBackgroundProxyChecks, useFaviconWarmer, useOAuthApproval,
} from './hooks/useBackgroundWork';
import {useEditors} from './hooks/useEditors';
import {useNewArrivals} from './hooks/useNewArrivals';
import {useReleaseNotes, useResourceStatus, useUpdater} from './hooks/useNativeState';
import {useSignIn} from './hooks/useSignIn';
import {native} from './native';
import * as db from './db';
import {describeDbError} from './db/errors';
import {useOrg} from './org';
import {supabase} from './supabase';
import {useAsyncAction} from './useAsyncAction';
import {useWorkspace} from './workspace/WorkspaceProvider';
import type {TabId} from './data/tabs';

export function App() {
  const org = useOrg();
  const workspace = useWorkspace();
  const {data, toast} = workspace;

  const signIn = useSignIn();
  const {resourceState, apiState, checkBrowser, retryBrowserDownload} = useResourceStatus(toast);
  const updater = useUpdater(toast);
  const releaseNotes = useReleaseNotes();
  const apiKeys = useApiKeys(org.userId, org.orgId);
  const integrations = useIntegrations(apiKeys, apiState);
  const editors = useEditors();
  const oauth = useOAuthApproval(apiKeys.refresh);
  const {run, isPending} = useAsyncAction();

  const [activeTab, setActiveTab] = useState<TabId>('profiles');
  // What a teammate -- or an agent over MCP -- has added since this machine last
  // looked at each tab. Called here rather than inside the four tabs that show
  // it because the sidebar has to count arrivals on the tabs nobody is standing
  // on, and because the badge clearing and the rows staying green are two reads
  // of the same watermark that have to disagree for exactly one visit. See
  // src/lib/newSince.ts.
  const arrivals = useNewArrivals(activeTab);
  // The two workspace dialogs the sidebar switcher opens. Held here with every
  // other dialog rather than inside the switcher, so the switcher stays a menu
  // and closing it does not unmount what it opened.
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [leavingWorkspace, setLeavingWorkspace] = useState(false);
  // Lives here and not in Sidebar because the column it changes is on
  // .app-shell, which is this component's element. The initialiser is the lazy
  // form so localStorage is read once on mount rather than on every render.
  const [railCollapsed, setRailCollapsed] = useState(isSidebarCollapsed);
  // Which folder each tab is filtered to. Held here rather than in the tabs
  // because creating a folder from the dialog switches the view to it.
  const [profileFolderId, setProfileFolderId] = useState('');
  const [proxyFolderId, setProxyFolderId] = useState('');
  const [cookieFolderId, setCookieFolderId] = useState('');
  const [automationFolderId, setAutomationFolderId] = useState('');
  // What a just-created folder was suggested from -- a tag for a profile
  // folder, an ISO country code for a proxy one. Held for exactly one hand-off:
  // the tab opens its move dialog on it, then clears it.
  const [folderFillTag, setFolderFillTag] = useState('');
  const [folderFillCountry, setFolderFillCountry] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which settings tab is showing. Up here rather than inside SettingsDialog so
  // it outlives that dialog's mount -- the startup gate below can still swap
  // the whole shell for the loader, and the tab should not be what pays for it.
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('account');
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  // Unlike the profiles one this is never shown unprompted -- there is no
  // "seen" flag for it, only the About button on the Cookies tab.
  const [cookieIntroOpen, setCookieIntroOpen] = useState(false);
  // The automation being edited, and whether it already exists -- create and
  // replace are separate writes on purpose (see src/db/automations.ts), so the
  // dialog has to carry which one this is rather than infer it.
  const [automationDraft, setAutomationDraft] =
    useState<{automation: ScoutAutomation; exists: boolean} | null>(null);
  // The connector being added or edited, on the automationDraft pattern and
  // for the same reason: create and replace are separate writes. A new one
  // starts with kind '' -- the modal's picker fills it in.
  const [connectorDraft, setConnectorDraft] =
    useState<{connector: ScoutConnector; exists: boolean} | null>(null);
  const [historyFor, setHistoryFor] = useState<ScoutAutomation | null>(null);
  // The automation whose delete confirmation is open. Beside automationDraft
  // rather than in useEditors because only the editor raises it -- the card in
  // the grid has no Delete any more.
  const [automationDeleteRequest, setAutomationDeleteRequest] =
    useState<AutomationDeleteRequest | null>(null);
  // The automation whose profile picker is open. Held here rather than in the
  // Automations tab because the editor's own Run button raises the same dialog,
  // and that dialog must not be a second copy living inside the editor.
  const [runningAutomation, setRunningAutomation] = useState<ScoutAutomation | null>(null);
  // What is about to be shared out of the workspace. Held here rather than in
  // each tab because four tabs raise it and the dialog is one -- the same reason
  // the delete confirmations live in useEditors.
  const [sharing, setSharing] = useState<ShareRequest | null>(null);
  // Which half of the Team tab is showing. Held here, not in the tab, because
  // the inbox bell's "View all" has to land on the Shared view specifically --
  // the same reason the folder ids for three other tabs live up here.
  const [teamView, setTeamView] = useState<TeamView>('members');
  // The plan this machine last welcomed the active workspace onto, mirrored out
  // of localStorage so both the welcome and the walkthrough can read it without
  // touching storage on every render. `undefined` is "not read yet" and is
  // distinct from `null`, which is "never welcomed" -- collapsing the two would
  // open the dialog for one commit on every launch.
  const [acknowledgedPlan, setAcknowledgedPlan] = useState<string | null | undefined>(undefined);

  useAutomationBridge(workspace);
  useFaviconWarmer(workspace);
  useBackgroundProxyChecks(workspace, Boolean(org.email));

  // Billing lives on the web dashboard. Anything opened here goes to the real
  // browser via the main process, which allowlists the host.
  const openAccountPage = (pathname: string) => void native?.openExternal?.(`${SITE_URL}${pathname}`);

  async function signOut() {
    await supabase?.auth.signOut();
    setSettingsOpen(false);
    editors.closeAll();
    // Keys and integration status belong to the outgoing user. The workspace
    // clears its own data when orgId drops.
    apiKeys.setKeys([]);
    integrations.reset();
    signIn.reset();
  }

  // Latched, because "the browser is installed" is not a thing that stops being
  // true while we ask the feed whether a newer one exists. checkBrowserResource
  // broadcasts browserStatus 'checking' on every check -- including the manual
  // one behind Settings → Updates and the automatic one every four hours -- and
  // without this latch that alone re-blocks the shell, unmounting whatever
  // dialog was open. See describeStartup.
  const browserWasReady = useRef(false);
  if (resourceState?.browserStatus === 'ready') {
    browserWasReady.current = true;
  }

  const startup = describeStartup(org.ready, resourceState, apiState, browserWasReady.current);

  const orgId = org.orgId;
  const currentPlan = org.org?.plan;

  useEffect(() => {
    setAcknowledgedPlan(orgId ? lastAcknowledgedPlan(orgId) : null);
  }, [orgId]);

  // "Who is this workspace for?", asked once per workspace.
  //
  // The gate is a column, not localStorage -- unlike the walkthrough and the
  // plan welcome, which are properties of this machine. The answer belongs to
  // the organization, so somebody who signs in on a second computer, or who
  // already answered on the website, must not be asked again. `onboarded_at`
  // being set is that test, and it is set even when they decline.
  //
  // `org.ready` matters as much as it does for the plan welcome: `org.org` is
  // undefined during the first fetch, and reading undefined as "not onboarded"
  // would put this dialog in front of every returning user on every launch.
  //
  // First in the queue of the three one-shot dialogs, and declared above them
  // because both of the others read it. It is the only one that asks a question
  // rather than explaining something, it is the shortest, and the other two both
  // have another way in (the empty state and Settings > General for the
  // walkthrough; nothing is lost by the plan welcome waiting one launch). At
  // most one of the three is ever open.
  //
  // setupDone is local state rather than a re-read of the org: the row is
  // written before onDone fires, but org.org does not refresh until the next
  // resolve, and without this the dialog would reopen on the render in between.
  // "Would you like a workspace of your own?", asked once per account.
  //
  // Ahead of all three of the dialogs below, and it has to be: it is the only
  // one that can change which workspace is active, and every one of the others
  // is *about* the active workspace. Asking "who is this workspace for" and then
  // switching the workspace out from under the answer is worse than making the
  // other question wait one launch.
  //
  // promptSupported is the "database does not have 20260808000000 yet" gate. A
  // launcher build can meet an older schema, and account_state coming back
  // unsupported has to mean "do not ask" rather than "never asked".
  const [personalDone, setPersonalDone] = useState(false);
  const [personalBusy, setPersonalBusy] = useState(false);
  const personalDue = Boolean(org.email) && !startup.blocked && org.ready &&
    org.promptSupported && org.orgs.length > 0 && !org.ownsAny &&
    !org.personalPromptAt && !personalDone;

  // Dismissed before the create dialog opens rather than after it finishes: a
  // crash mid-create must not re-ask on the next launch, and the switcher is a
  // second way in for anyone who changes their mind.
  const answerPersonal = (thenCreate: boolean) => {
    setPersonalBusy(true);
    void db.orgs.dismissPersonalWorkspacePrompt()
        .catch((caught) => toast.setMessage(describeDbError(caught, 'Could not save that.')))
        .finally(() => {
          setPersonalBusy(false);
          setPersonalDone(true);
          if (thenCreate) {
            setCreatingWorkspace(true);
          }
        });
  };

  // "Who is this workspace for?", asked once per workspace.
  //
  // `org.isOwner` as well: it is a question about the company behind the
  // workspace, and its answer overwrites legal_name, country and website. A
  // member who joined an owner-who-never-onboarded's workspace was being asked
  // to describe somebody else's business -- and since 20260808000000 narrowed
  // organizations_update to is_org_owner, their answer would be refused anyway.
  const [setupDone, setSetupDone] = useState(false);
  const setupDue = Boolean(org.email) && !startup.blocked && org.ready && orgId &&
    org.isOwner && !org.org?.onboarded_at && !setupDone && !personalDue;

  // Whether this workspace has changed onto a paid plan since this machine last
  // said so. Gated on org.ready as well as the startup screen, because `plan` is
  // undefined during the first fetch and reading that as a change would
  // congratulate the user on every launch -- the same "not loaded is not a
  // value" rule src/team/limit.ts and src/automations/limit.ts are built around.
  const welcomeReady = Boolean(org.email) && !startup.blocked && org.ready &&
    acknowledgedPlan !== undefined;
  const planChanged = Boolean(welcomeReady && orgId && currentPlan &&
    currentPlan !== acknowledgedPlan);
  // Two plans change without raising anything: Free, which is not an occasion,
  // and one this build has never heard of, which means the mirror in
  // src/plans.ts is stale -- and a celebration that cannot name what it is
  // celebrating should not open at all. Both are still recorded below, so
  // neither re-asks on every launch.
  //
  // `&& !setupDue` keeps the three one-shot dialogs from stacking. Setup goes
  // first (see its own note below); the welcome is not lost, it opens on the
  // next launch because acknowledgePlan only runs when this one is dismissed.
  const planWelcomeDue = planChanged && isPlanKey(currentPlan) &&
    !showsPlanPicker(currentPlan) && !setupDue && !personalDue;

  // The silent half. Recording Free is not bookkeeping: it is what gives a later
  // upgrade a number to count up from, so it has to land on the plan the user is
  // on now rather than on the one they eventually buy.
  useEffect(() => {
    if (planChanged && orgId && currentPlan &&
        (showsPlanPicker(currentPlan) || !isPlanKey(currentPlan))) {
      acknowledgePlan(orgId, currentPlan);
      setAcknowledgedPlan(currentPlan);
    }
  }, [planChanged, orgId, currentPlan]);

  // Acknowledged on dismiss rather than on open, so a crash between the two
  // shows the welcome again instead of eating it.
  const dismissPlanWelcome = () => {
    if (orgId && currentPlan) {
      acknowledgePlan(orgId, currentPlan);
      setAcknowledgedPlan(currentPlan);
    }
  };

  // The walkthrough opens itself once, for someone who has nothing to look at
  // yet. Three things all have to be true, and each of them has bitten:
  //   - signed in, and past the startup gate, or it would open behind a screen
  //     that is returned before it renders -- and mark itself seen from there,
  //     so it would never be shown at all;
  //   - the cloud load finished, because `profiles` is an empty array while the
  //     first fetch is in flight, which is not an empty workspace;
  //   - not seen on this machine before.
  // It sits below describeStartup because it reads it, and above the early
  // returns because a hook cannot be called conditionally.
  //
  // A fourth now: no plan welcome due, so the two never stack. They collide in
  // exactly one real case and it is a likely one -- somebody invited into a paid
  // workspace, where every profile belongs to a colleague and their own list is
  // empty. The walkthrough is the one that waits, because it is the one with two
  // other ways in (the empty state, and Settings > General).
  // `!setupDue` as well as `!planWelcomeDue`, and it matters more here: a brand
  // new account has both an empty workspace AND an unanswered setup question, so
  // without this the two would collide on literally every first run rather than
  // in an edge case. The walkthrough marks itself seen the moment it opens, so
  // stacking would not just look wrong -- it would spend the one showing it gets.
  const introReady = Boolean(org.email) && !startup.blocked && !data.loading &&
    data.state.profiles.length === 0 && !planWelcomeDue && !setupDue && !personalDue;
  useEffect(() => {
    if (introReady && !hasSeenProfileIntro()) {
      markProfileIntroSeen();
      setIntroOpen(true);
    }
  }, [introReady]);

  // A profile's start page or side panel asking for one of its automation cards
  // to be opened here. main.cjs has already brought this window to the front;
  // all that is left is to show the thing the user pressed for.
  //
  // Two cases resolve to the tab alone, and the code below does not distinguish
  // them because the right answer is the same for both. The workflow may have
  // been deleted, or unshared, since the session that is asking was launched --
  // then the tab is the closest true answer, exactly as the bell's history
  // handler above resolves the same problem. Or `automationId` is null, because
  // the caller named none: the panel's empty state asking for the tab itself,
  // which is the only thing it can usefully offer a launch with nothing pinned.
  useEffect(() => {
    return native?.onOpenAutomationRequest?.(({automationId}) => {
      const automation = data.state.automations.find((item) => item.id === automationId);
      setActiveTab('automations');
      if (automation) {
        setAutomationDraft({automation, exists: true});
      }
    });
  }, [data.state.automations]);

  if (startup.blocked) {
    return (
      <main className="login-shell">
        <LoadingState
          label={startup.failed ? 'Scout Web is not ready' : 'Preparing Scout Web'}
          detail={startup.detail}
          failed={startup.failed}
          onRetry={startup.canRetryBrowser ? retryBrowserDownload : undefined}
        />
      </main>
    );
  }

  if (!org.email) {
    return <SignIn state={signIn} />;
  }

  const openIntegration = findIntegration(integrations.openId);

  return (
    <main className={railCollapsed ? 'app-shell rail-collapsed' : 'app-shell'}>
      <Sidebar
        activeTab={activeTab}
        collapsed={railCollapsed}
        newCounts={arrivals.counts}
        onCreateWorkspace={() => setCreatingWorkspace(true)}
        onLeaveWorkspace={() => setLeavingWorkspace(true)}
        onSettings={() => setSettingsOpen(true)}
        onSignOut={() => void signOut()}
        onTab={setActiveTab}
        // Not the updater form: it would put the localStorage write inside a
        // function React is free to call twice.
        onToggleCollapsed={() => {
          const next = !railCollapsed;
          setRailCollapsed(next);
          setSidebarCollapsed(next);
        }}
      />

      <section className="content">
        <Topbar
          activeTab={activeTab}
          actions={renderTopActions()}
          onViewShares={() => {
            setTeamView('shared');
            setActiveTab('team');
          }}
          // A bell notification opens the run history it reports on. The
          // automation may have been deleted since -- then the Automations tab
          // is the closest true answer, and its runs are still readable there
          // through their denormalised names.
          onOpenAutomationHistory={(automationId) => {
            const automation = data.state.automations.find(
                (item) => item.id === automationId);
            if (automation) {
              setHistoryFor(automation);
            } else {
              setActiveTab('automations');
            }
          }}
        />
        {data.loading ? (
          <LoadingState
            label="Loading cloud data"
            detail="Profiles, proxies, bookmarks, and extensions are syncing."
          />
        ) : renderTab()}
      </section>

      <div className="toast-stack">
        {toast.message && (
          // role=alert for a failure: a status line is polite and a screen
          // reader may sit on it until the user next idles, which is the wrong
          // trade for the one tone that reports something went wrong.
          <div
            className={`status-toast ${toast.tone}`}
            role={toast.tone === 'fail' ? 'alert' : 'status'}
          >
            <span className="status-toast-line">
              {toast.tone !== 'info' && (
                <span className="status-toast-mark" aria-hidden="true">
                  {toast.tone === 'fail' ? <CircleAlert size={16} /> : <CircleCheck size={16} />}
                </span>
              )}
              <span className="status-toast-text">{toast.message}</span>
            </span>
            {toast.detail && (
              <CopyButton
                className="link-button status-toast-copy"
                label="Copy"
                value={toast.detail}
              />
            )}
          </div>
        )}
        <UpdateToast
          resourceState={resourceState}
          state={updater.updateState}
          dismissedVersion={updater.dismissedVersion}
          onDismiss={updater.setDismissedVersion}
        />
      </div>

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onCheckBrowser={checkBrowser}
          onInstallBrowser={retryBrowserDownload}
          onOpenChangelog={() => setChangelogOpen(true)}
          onOpenIntro={() => {
            setSettingsOpen(false);
            setIntroOpen(true);
          }}
          // Plans have no tab of their own any more: the picker, pricing and
          // checkout live on the website.
          onOpenPlans={() => openAccountPage(SITE_LINKS.pricing)}
          onOpenSite={openAccountPage}
          onSectionChange={setSettingsSection}
          onSignOut={() => void signOut()}
          resourceState={resourceState}
          section={settingsSection}
          onUpdaterAction={(action) => void updater.run(action)}
          releaseNotes={releaseNotes}
          updateState={updater.updateState}
          updaterBusy={updater.busy}
        />
      )}
      {changelogOpen && (
        <ChangelogModal
          installedBrowserVersion={resourceState?.installedVersion || ''}
          onClose={() => setChangelogOpen(false)}
          releaseNotes={releaseNotes}
          updater={updater}
        />
      )}
      {personalDue && (
        <PersonalWorkspaceModal
          busy={personalBusy}
          orgName={org.org?.name || 'this workspace'}
          onCreate={() => answerPersonal(true)}
          onDecline={() => answerPersonal(false)}
        />
      )}
      {setupDue && orgId && (
        <WorkspaceSetupModal
          orgId={orgId}
          orgName={org.org?.name || ''}
          onDone={() => {
            setSetupDone(true);
            // Pull the row back so Settings and the Team tab show the business
            // name straight away rather than after the next focus refresh.
            void org.reload();
          }}
        />
      )}
      {/* The same component in create mode. create_workspace has already made
          the workspace active server-side by the time onDone fires, so the local
          switch here is what stops the UI waiting a whole resolve to catch up.
          reload() then brings the new membership into the switcher's list. */}
      {creatingWorkspace && (
        <WorkspaceSetupModal
          mode="create"
          orgId={null}
          orgName=""
          onCancel={() => setCreatingWorkspace(false)}
          onDone={(newOrgId) => {
            setCreatingWorkspace(false);
            org.setOrgId(newOrgId);
            void org.reload();
          }}
        />
      )}
      {leavingWorkspace && orgId && (
        <LeaveTeamModal
          orgName={org.org?.name || 'this workspace'}
          onClose={() => setLeavingWorkspace(false)}
          onConfirm={() => workspace.team.leave(orgId, org.userId as string)}
          onLeft={() => {
            setLeavingWorkspace(false);
            // active_org() re-checks the membership and falls back on its own;
            // the local hint does not, and would win on an offline start.
            db.orgs.setCurrentOrgId(null);
            void org.reload();
          }}
        />
      )}
      {planWelcomeDue && isPlanKey(currentPlan) && (
        <PlanWelcomeModal
          plan={PLANS[currentPlan]}
          // The row, not the mirror. PLANS still supplies the label and the
          // "before" column, but what the workspace is being welcomed onto has
          // to be what it actually got -- see the header of PlanWelcomeModal.
          //
          // `?? null` on seat_limit: ScoutOrg types it as a plain number, but a
          // row read back from a database where it is null means unlimited, and
          // the modal renders that word.
          limits={{
            profiles: org.org?.profile_limit ?? null,
            seats: org.org?.seat_limit ?? null,
            automations: org.org?.automation_limit ?? null,
          }}
          previous={acknowledgedPlan && isPlanKey(acknowledgedPlan) ?
            PLANS[acknowledgedPlan] :
            undefined}
          orgName={org.org?.name || 'This workspace'}
          onClose={dismissPlanWelcome}
        />
      )}
      {introOpen && (
        <IntroModal
          steps={PROFILE_INTRO_STEPS}
          onClose={() => setIntroOpen(false)}
          finishLabel="Create a profile"
          onFinish={() => {
            setIntroOpen(false);
            editors.newProfile();
          }}
        />
      )}
      {cookieIntroOpen && (
        <IntroModal
          steps={COOKIE_INTRO_STEPS}
          onClose={() => setCookieIntroOpen(false)}
          finishLabel="Add a cookie-set"
          onFinish={() => {
            setCookieIntroOpen(false);
            editors.setCookieImportOpen(true);
          }}
        />
      )}
      {editors.extensionAddOpen && (
        <ExtensionAddModal onClose={() => editors.setExtensionAddOpen(false)} />
      )}
      {editors.importOpen && <ImportProfilesModal onClose={() => editors.setImportOpen(false)} />}
      {editors.proxyImportOpen && (
        <ImportProxiesModal
          // Trash is a view, not a folder, so it never becomes a destination.
          folderId={proxyFolderId === TRASH_FOLDER_ID ? null : proxyFolderId || null}
          onClose={() => editors.setProxyImportOpen(false)}
        />
      )}
      {editors.cookieImportOpen && (
        <ImportCookiesModal
          // Trash is a view, not a folder, so it never becomes a destination.
          folderId={cookieFolderId === TRASH_FOLDER_ID ? null : cookieFolderId || null}
          onClose={() => editors.setCookieImportOpen(false)}
        />
      )}
      {editors.bookmarkImportOpen && (
        <BookmarkImportModal onClose={() => editors.setBookmarkImportOpen(false)} />
      )}
      {oauth.request && (
        <OAuthApprovalModal
          request={oauth.request}
          folder={oauth.folder}
          onFolder={oauth.setFolder}
          onRespond={(approved) => void oauth.respond(approved)}
        />
      )}
      {openIntegration && (
        <IntegrationModal
          integration={openIntegration}
          integrations={integrations}
          apiKeys={apiKeys}
          apiState={apiState}
        />
      )}

      {editors.profileDraft && (
        <ProfileModal
          draft={editors.profileDraft}
          onChange={editors.setProfileDraft}
          onClose={editors.closeProfileDraft}
          openFingerprint={editors.profileDraftSection === 'fingerprint'}
          onNewStatus={() => editors.setStatusDraft({name: ''})}
          onPickCookies={() => editors.setCookiePickerOpen(true)}
          onCreateProxy={(seed) => editors.openProxyDraft(seed, 'profile')}
          onRequestDelete={editors.requestDeleteProfiles}
        />
      )}
      {editors.cookiePickerOpen && editors.profileDraft && (
        <CookiePickerModal
          search={editors.profileDraft.cookie_search}
          onSearch={(value) => editors.patchProfileDraft({cookie_search: value})}
          selectedId={editors.profileDraft.cookie_id}
          onSelect={(cookie) => editors.patchProfileDraft({
            cookie_mode: 'saved',
            cookie_id: cookie.id,
            cookie_search: '',
          })}
          onClose={() => editors.setCookiePickerOpen(false)}
        />
      )}
      {editors.proxyDraft && (
        <ProxyModal
          draft={editors.proxyDraft}
          source={editors.proxyDraftSource}
          onChange={editors.setProxyDraft}
          onClose={editors.closeProxyDraft}
          onSaved={(proxyId, fromProfile) => {
            if (fromProfile) {
              editors.patchProfileDraft({proxy_id: proxyId, proxy_link: '', proxy_search: ''});
            }
            editors.closeProxyDraft();
          }}
          onRequestDelete={editors.requestDeleteProxies}
        />
      )}
      {editors.bookmarkDraft && (
        <BookmarkModal
          draft={editors.bookmarkDraft}
          onChange={editors.setBookmarkDraft}
          onClose={() => editors.setBookmarkDraft(null)}
        />
      )}
      {editors.folderDraft && (
        <FolderModal
          draft={editors.folderDraft}
          onChange={editors.setFolderDraft}
          onClose={() => editors.setFolderDraft(null)}
          onCreated={(folderId, seed) => {
            // `seed` is a tag or a country code depending on which library the
            // draft belongs to, so the kind decides where both values land.
            if (editors.folderDraft?.kind === 'proxy') {
              setProxyFolderId(folderId);
              setFolderFillCountry(seed || '');
              return;
            }
            // Cookie and automation folders are never suggested from anything,
            // so there is no seed to hand on -- just select the new folder.
            if (editors.folderDraft?.kind === 'cookie') {
              setCookieFolderId(folderId);
              return;
            }
            if (editors.folderDraft?.kind === 'automation') {
              setAutomationFolderId(folderId);
              return;
            }
            setProfileFolderId(folderId);
            setFolderFillTag(seed || '');
          }}
        />
      )}
      {connectorDraft && (
        <ConnectorModal
          connector={connectorDraft.connector}
          exists={connectorDraft.exists}
          onClose={() => setConnectorDraft(null)}
        />
      )}
      {automationDraft && (
        <AutomationModal
          automation={automationDraft.automation}
          exists={automationDraft.exists}
          tagOptions={workspace.tagOptions}
          // The profile a step's Check button tests its selector against: the
          // one this automation last ran on, so the page you check against is
          // the page the run actually used.
          checkProfile={runTarget(
              data.state,
              automationDraft.automation,
              workspace.selectedProfileId,
              workspace.automations.lastRunProfileId(automationDraft.automation.id),
          )}
          // Names and ids only. The config stays out of the editor entirely --
          // a step stores a connector id, and the main process is the only
          // thing that ever turns one into a credential.
          connectors={data.state.connectors.map((connector) => ({
            id: connector.id,
            name: connector.name,
            category: connector.category,
            is_default: connector.is_default,
          }))}
          // Live profiles only, for the schedule's target list -- a trashed
          // profile cannot accept a run.
          profiles={data.state.profiles
              .filter((profile) => !profile.deleted_at)
              .map((profile) => ({id: profile.id, name: profile.name}))}
          // For callAutomation's picker. The modal excludes the draft itself;
          // trashed ones are excluded here, for the same reason the profile
          // list above drops deleted rows -- you cannot call what is in Trash.
          automations={data.state.automations
              .filter((automation) => !automation.deleted_at)
              .map((automation) => ({id: automation.id, name: automation.name}))}
          folders={data.state.automation_folders.map((folder) => ({
            id: folder.id,
            name: folder.name,
          }))}
          members={data.state.members}
          telegramLinked={Boolean(data.state.telegram_link)}
          telegramPref={data.state.telegram_prefs.find((pref) =>
            pref.automation_id === automationDraft.automation.id)?.notify_on ?? null}
          onTelegramPref={(value) => void workspace.automations.setTelegramPref(
              automationDraft.automation.id, value)}
          onLinkTelegram={() => void workspace.automations.linkTelegram()}
          onClose={() => setAutomationDraft(null)}
          onRun={setRunningAutomation}
          onSave={(next) => workspace.automations.save(next, automationDraft.exists)}
          // Counted from the saved automation's id, not from the draft: the
          // draft may have unsaved edits, but what is attached to a profile is
          // whatever was last written.
          onDelete={() => setAutomationDeleteRequest({
            id: automationDraft.automation.id,
            label: automationDraft.automation.name || 'this automation',
            attachedProfiles: data.state.profiles.filter((profile) =>
              !profile.deleted_at &&
              profile.automation_id === automationDraft.automation.id).length,
          })}
        />
      )}
      {automationDeleteRequest && (
        <AutomationDeleteModal
          request={automationDeleteRequest}
          onClose={() => setAutomationDeleteRequest(null)}
          onDeleted={() => {
            setAutomationDeleteRequest(null);
            // The editor it was raised from is showing something that no longer
            // exists, so it goes too.
            setAutomationDraft(null);
          }}
        />
      )}
      {historyFor && (
        <RunLogModal automation={historyFor} onClose={() => setHistoryFor(null)} />
      )}
      {runningAutomation && (
        <RunAutomationModal
          automation={runningAutomation}
          // The editor's own Run button raises this over the still-open editor.
          nested={Boolean(automationDraft)}
          // Closes this and opens the proxy editor rather than stacking one
          // dialog on the other: the proxy editor is reachable from three other
          // places and none of them nest it. Re-opening Run afterwards costs a
          // click and shows the freshly-checked result.
          onFixProxy={(proxy) => {
            setRunningAutomation(null);
            editors.editProxy(proxy);
          }}
          onClose={() => setRunningAutomation(null)}
        />
      )}
      {editors.cookieSetOpen && (
        <CookieSetModal
          cookie={editors.cookieSetOpen}
          onClose={() => editors.setCookieSetOpen(null)}
          onAssign={editors.setAssignCookieSet}
        />
      )}
      {editors.assignCookieSet && (
        <AssignCookieSetModal
          cookie={editors.assignCookieSet}
          onClose={() => editors.setAssignCookieSet(null)}
        />
      )}
      {editors.statusDraft && (
        <StatusModal
          draft={editors.statusDraft}
          onChange={editors.setStatusDraft}
          onClose={() => editors.setStatusDraft(null)}
        />
      )}
      {editors.profileDeleteRequest && (
        <ProfileDeleteModal
          request={editors.profileDeleteRequest}
          onClose={() => editors.setProfileDeleteRequest(null)}
          onDeleted={() => {
            editors.profileDeleteRequest?.onDeleted?.();
            editors.setProfileDeleteRequest(null);
            editors.setProfileDraft(null);
          }}
        />
      )}
      {editors.proxyDeleteRequest && (
        <ProxyDeleteModal
          request={editors.proxyDeleteRequest}
          onClose={() => editors.setProxyDeleteRequest(null)}
          onDeleted={() => {
            editors.proxyDeleteRequest?.onDeleted?.();
            editors.setProxyDeleteRequest(null);
            editors.closeProxyDraft();
          }}
        />
      )}
      {sharing && org.orgId && (
        <ShareModal
          request={sharing}
          onClose={() => setSharing(null)}
          onShare={async (kind, ids, toUserId, note) => {
            const result = await workspace.shared.offer(
                org.orgId as string, kind, ids, toUserId, note);
            if ('count' in result) {
              // Names the person, because the whole point is that it is now
              // waiting on somebody -- "Shared" alone would not say that an
              // answer is still outstanding.
              const to = data.state.members.find((member) => member.user_id === toUserId);
              const name = to?.display_name || to?.email || 'them';
              toast.setMessage(`Shared with ${name}. They'll be asked to accept.`);
            }
            return result;
          }}
        />
      )}
      {toast.errorDialog && (
        <ErrorModal dialog={toast.errorDialog} onClose={() => toast.setErrorDialog(null)} />
      )}
    </main>
  );

  function renderTab() {
    switch (activeTab) {
      case 'proxies':
        return (
          <ProxiesTab
            folderId={proxyFolderId}
            onFolderId={setProxyFolderId}
            onAddProxy={editors.newProxy}
            onImportProxies={() => editors.setProxyImportOpen(true)}
            onEditProxy={(proxy) => editors.editProxy(proxy)}
            onNewFolder={() => editors.setFolderDraft({
              kind: 'proxy',
              name: '',
              icon: DEFAULT_FOLDER_ICON,
              color: DEFAULT_PROFILE_COLOR,
            })}
            onEditFolder={(folder) => editors.setFolderDraft({
              id: folder.id,
              kind: 'proxy',
              name: folder.name,
              icon: folder.icon || DEFAULT_FOLDER_ICON,
              color: normalizeProfileColor(folder.color),
            })}
            fillCountry={folderFillCountry}
            onFillCountryDone={() => setFolderFillCountry('')}
            onRequestDelete={editors.requestDeleteProxies}
            onShare={setSharing}
            newIds={arrivals.newIds.proxies}
          />
        );
      case 'cookies':
        return (
          <CookiesTab
            folderId={cookieFolderId}
            onFolderId={setCookieFolderId}
            onOpenCookieSet={editors.setCookieSetOpen}
            onAssignCookieSet={editors.setAssignCookieSet}
            onNewCookieSet={() => editors.setCookieImportOpen(true)}
            onShowAbout={() => setCookieIntroOpen(true)}
            onNewFolder={() => editors.setFolderDraft({
              kind: 'cookie',
              name: '',
              icon: DEFAULT_FOLDER_ICON,
              color: DEFAULT_PROFILE_COLOR,
            })}
            onEditFolder={(folder) => editors.setFolderDraft({
              id: folder.id,
              kind: 'cookie',
              name: folder.name,
              icon: folder.icon || DEFAULT_FOLDER_ICON,
              color: normalizeProfileColor(folder.color),
            })}
            onShare={setSharing}
            newIds={arrivals.newIds.cookies}
          />
        );
      case 'startPage':
        return (
          <StartPageTab
            onAddBookmark={editors.newBookmark}
            onEditBookmark={editors.editBookmark}
          />
        );
      case 'automations':
        return (
          <AutomationsTab
            folderId={automationFolderId}
            onFolderId={setAutomationFolderId}
            onNewFolder={() => editors.setFolderDraft({
              kind: 'automation',
              name: '',
              icon: DEFAULT_FOLDER_ICON,
              color: DEFAULT_PROFILE_COLOR,
            })}
            onEditFolder={(folder) => editors.setFolderDraft({
              id: folder.id,
              kind: 'automation',
              name: folder.name,
              icon: folder.icon || DEFAULT_FOLDER_ICON,
              color: normalizeProfileColor(folder.color),
            })}
            // Filed where you are standing. Creating one inside a folder and
            // finding it in All automations is the kind of small betrayal that
            // makes people stop trusting the folder rail. TRASH_FOLDER_ID
            // cannot reach here -- the tab hides both New buttons in Trash.
            onNew={() => setAutomationDraft({
              automation: {
                ...workspace.automations.newAutomation(),
                folder_id: automationFolderId || null,
              },
              exists: false,
            })}
            onLoadExample={() => void loadExampleAutomation()}
            onCreateDemoProfile={() => void createDemoProfile()}
            onEdit={(automation) => setAutomationDraft({automation, exists: true})}
            onRun={setRunningAutomation}
            onHistory={setHistoryFor}
            onShare={setSharing}
            onOpenSite={openAccountPage}
            onNewConnector={() => setConnectorDraft({
              connector: workspace.connectors.blank(''),
              exists: false,
            })}
            onEditConnector={(connector) => setConnectorDraft({connector, exists: true})}
            newIds={arrivals.newIds.automations}
          />
        );
      case 'extensions':
        return <ExtensionsTab onAddExtension={() => editors.setExtensionAddOpen(true)} />;
      case 'integrations':
        return (
          <IntegrationsTab
            apiKeys={apiKeys}
            integrations={integrations}
            onOpen={integrations.open}
            onOpenApiPage={() => openAccountPage(SITE_LINKS.api)}
          />
        );
      // No renderTopActions() case, like Automations and Extensions: the Invite
      // button belongs in this tab's own bar, beside the seat count it changes.
      case 'team':
        return (
          <TeamTab
            view={teamView}
            onView={setTeamView}
            onShare={setSharing}
            onOpenSite={openAccountPage}
          />
        );
      // Counted the way settings/SettingsDialog.tsx counts them, and for the
      // same reasons: Trash does not count against the profile limit until a
      // profile is restored, and automations are hard-deleted so every row in
      // state is a live one.
      case 'profiles':
      default:
        return (
          <ProfilesTab
            folderId={profileFolderId}
            onFolderId={setProfileFolderId}
            onEditProfile={editors.editProfile}
            onEditFingerprint={(profile) => editors.editProfile(profile, 'fingerprint')}
            onOpenCookieSet={(cookie) => {
              // The tab as well as the dialog: dismissing the inspector should
              // leave you looking at the library the set lives in, not at the
              // profiles table you came from. And its folder, or the table
              // behind it would be filtered to somewhere the set is not.
              setActiveTab('cookies');
              setCookieFolderId(cookie.folder_id || '');
              editors.setCookieSetOpen(cookie);
            }}
            onNewProfile={editors.newProfile}
            onNewFolder={() => editors.setFolderDraft({
              kind: 'profile',
              name: '',
              icon: DEFAULT_FOLDER_ICON,
              color: DEFAULT_PROFILE_COLOR,
            })}
            onEditFolder={(folder) => editors.setFolderDraft({
              id: folder.id,
              kind: 'profile',
              name: folder.name,
              icon: folder.icon || DEFAULT_FOLDER_ICON,
              color: normalizeProfileColor(folder.color),
            })}
            fillTag={folderFillTag}
            onFillTagDone={() => setFolderFillTag('')}
            onRequestDelete={editors.requestDeleteProfiles}
            onShare={setSharing}
            onShowIntro={() => setIntroOpen(true)}
            newIds={arrivals.newIds.profiles}
          />
        );
    }
  }

  function renderTopActions() {
    switch (activeTab) {
      case 'profiles':
        return (
          <>
            {/* Flat, the same silhouette the toolbar's filters and Columns take
              * -- see the .filter-trigger note in styles.css. Three bordered
              * buttons side by side made Refresh, Import and Add profile read as
              * equal offers, when only the last is the thing you came here to
              * do. The border is the hierarchy.
              *
              * Refresh first, and here rather than in the table toolbar: it acts
              * on the whole workspace -- proxies, hand-offs and the plan as well
              * as this table -- so it belongs beside the other header actions
              * and not among controls that only narrow the rows below. */}
            <RefreshButton />
            <button className="filter-trigger" onClick={() => editors.setImportOpen(true)}>
              <span className="filter-trigger-label"><Upload size={16} strokeWidth={1.9} /> Import</span>
            </button>
            <button onClick={editors.newProfile}><UserPlus size={16} /> Add profile</button>
          </>
        );
      // 'automations' has no case, on the same terms as 'extensions': both put
      // their create action in the tab's own .integration-bar, where it sits
      // beside the count it changes. A second copy in the Topbar would be two
      // buttons to keep in step over one plan-cap check.
      case 'proxies':
        return (
          <>
            {/* Matched to the Profiles pair above. This one sits in the same
              * slot of the same header, so a bordered Import here and a flat one
              * there would read as the button changing shape when you switch
              * tabs. */}
            <button className="filter-trigger" onClick={() => editors.setProxyImportOpen(true)}>
              <span className="filter-trigger-label"><Upload size={16} strokeWidth={1.9} /> Import</span>
            </button>
            <button onClick={editors.newProxy}><Plus size={16} /> Add proxy</button>
          </>
        );
      case 'cookies':
        return (
          <>
            <button className="ghost" onClick={() => setCookieIntroOpen(true)}>
              <BookOpen size={16} /> About
            </button>
            <BusyButton
              busy={isPending('add-cookie-set')}
              busyLabel="Uploading…"
              onClick={() => editors.setCookieImportOpen(true)}
            >
              <Plus size={16} /> Cookie-set
            </BusyButton>
          </>
        );
      case 'startPage':
        // Adding one bookmark is the "+" tile on the page itself, so the top
        // action is the thing the page has no room for: bringing a whole
        // browser's worth of bookmarks across.
        return (
          <button onClick={() => editors.setBookmarkImportOpen(true)}>
            <Upload size={16} /> Import bookmarks
          </button>
        );
      default:
        return null;
    }
  }

  // Inserts the pre-written example, then opens it for editing.
  //
  // The row is written before the editor opens (exists: false -> an INSERT,
  // never an upsert -- see the trg_automation_limit note in db/automations.ts),
  // so what the user is looking at is a real automation from the first frame
  // rather than a draft that only becomes real if they press Save. save()
  // hands the failure back instead of toasting it, so this has to surface it --
  // and it is the path that reports automation_limit_reached when an org's cap
  // has not been raised, which is a message worth showing verbatim.
  async function loadExampleAutomation() {
    const automation = workspace.automations.exampleAutomation();
    const error = await workspace.automations.save(automation, false);
    if (error) {
      toast.setMessage(error);
      return;
    }
    setAutomationDraft({automation, exists: true});
  }

  // A Direct-mode profile for the example to run against.
  //
  // Built through newProfileDraft/profileFromDraft rather than assembled here,
  // so the fingerprint, colour and tag defaults come from the same place every
  // other new profile gets them from -- a hand-rolled row would drift the first
  // time those defaults change. Direct mode needs no proxy credentials, which
  // is the only reason this can be a one-click offer at all; profiles.save
  // selects the new profile, which is what runTarget then resolves against.
  async function createDemoProfile() {
    const profile = profileFromDraft({
      ...newProfileDraft(),
      name: 'Demo',
      proxy_mode: 'direct',
    });
    if (await workspace.profiles.save(profile)) {
      toast.setMessage('Created the Demo profile — it browses direct, with no proxy.');
    }
  }
}

