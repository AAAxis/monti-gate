// The Automations library.
//
// Cards rather than table rows: there are few of these and each carries more
// than a row's worth -- name, description, step count, where it is wired in,
// and how its last run went. The same call the Extensions tab made.
//
// And now the same shell, the same card and the same toolbar as that tab, not
// just the same call. This page was written before Extensions settled the house
// style for a card grid and had drifted a long way from it: no width cap, so at
// 1600px its cards fanned out to six columns while every neighbouring tab
// stopped at 1080; 20px padding and no shadow against Extensions' 14 and
// --shadow-xs; no mark, so a grid of automations was a grid of headings; and
// ragged card feet, because nothing made the description take the slack.
//
// What moved rather than changed: the New automation button is in this tab's
// own toolbar instead of the app Topbar, which is where Extensions puts its Add
// action and why that tab has no `case` in renderTopActions() at all. One place
// per action.
import {useEffect, useMemo, useState} from 'react';
import {
  Bot, BookOpen, CircleCheck, CircleSlash, CircleX, Clock, FolderInput, FolderPlus,
  History, LoaderCircle, MonitorSmartphone, Pencil, Play, Plus, Rocket, Share2,
  Sparkles, Star, Trash2, TriangleAlert, Undo2, Workflow,
} from 'lucide-react';
import {Assignee} from '../ui/Assignee';
import {AutomationMark, automationFrameStyle} from '../automations/AutomationMark';
import {Badge} from '../ui/Badge';
import {BusyButton} from '../ui/BusyButton';
import {ConnectorsView} from '../automations/ConnectorsView';
import {FolderGlyph} from '../ui/FolderGlyph';
import {MoveAutomationsModal} from '../modals/MoveAutomationsModal';
import {NotificationBotView} from '../automations/NotificationBotView';
import {TagChip} from '../ui/TagChip';
import {useAsyncAction} from '../../useAsyncAction';
import {useOrg} from '../../org';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import {SITE_LINKS} from '../../data/links';
import {assigneeName} from '../../lib/assignees';
import {ago} from '../../lib/relativeTime';
import {TRASH_FOLDER_ID, TRASH_RETENTION_DAYS, daysUntilPurge} from '../../lib/trash';
import {automationCap} from '../../automations/limit';
import {describeRunBlock} from '../../automations/runReadiness';
import {RUN_LABEL} from '../../automations/runStatus';
import {describeSchedule} from '../../automations/schedule';
import {sortAutomations} from '../../automations/sort';
import type {ShareRequest} from '../modals/ShareModal';
import type {
  ScoutAutomation, ScoutConnector, ScoutFolder, AutomationRun,
} from '../../types';
import type {RunStatus} from '../../automations/types';

// All, or the ones the browser start pages show. Chips rather than a filter
// dropdown, on the control Extensions and the proxy-mode selector already use.
// `pinned` earns its chip because it is the one property of an automation with
// a consequence outside this tab: a pinned workflow is a button inside every
// profile's session. `connectors` is not a filter at all but the tab's second
// collection -- the services automations call -- which lives here rather than
// in Settings because it is only ever used from this tab.
type View = 'all' | 'pinned' | 'mine' | 'connectors' | 'bot';

// The verdict's glyph. A coloured dot said "something happened"; a tick, a
// triangle and a cross say what happened, which is the whole of what the row is
// for at a glance across a grid.
//
// Here rather than beside RUN_LABEL and RUN_TONE in automations/runStatus.ts:
// that module is plain .ts and shared with the run-log dialog, and it has no
// business pulling in an icon set for one caller. Keyed by RunStatus all the
// same, so a status added to the union has to be given a glyph or typecheck
// fails -- which is the property that made those two maps worth having.
const RUN_GLYPH: Record<RunStatus, typeof CircleCheck> = {
  ok: CircleCheck,
  partial: TriangleAlert,
  failed: CircleX,
  cancelled: CircleSlash,
  running: LoaderCircle,
};

export function AutomationsTab({
  folderId, onFolderId, onNewFolder, onEditFolder,
  onEdit, onNew, onLoadExample, onCreateDemoProfile, onRun, onHistory, onShare, onOpenSite,
  onNewConnector, onEditConnector, newIds,
}: {
  // '' is All automations and TRASH_FOLDER_ID is Trash; anything else is a
  // folder id. Held in App rather than here for the reason the other three
  // tabs hold it there: creating a folder has to switch the view to it, and
  // the dialog that creates one is mounted from App.
  folderId: string;
  onFolderId: (folderId: string) => void;
  onNewFolder: () => void;
  onEditFolder: (folder: ScoutFolder) => void;
  onEdit: (automation: ScoutAutomation) => void;
  onNew: () => void;
  // Inserts the pre-written example and opens it. Unlike onNew it writes a row
  // before the editor opens, which is what makes it a normal automation from
  // the first moment rather than a draft with special provenance.
  onLoadExample: () => void;
  // Only offered when the org has no profiles at all: an automation with
  // nothing to run against is a dead end, and Direct mode is the one setup that
  // needs no proxy credentials to demonstrate.
  onCreateDemoProfile: () => void;
  // Opens the profile picker. Running never starts from this button any more:
  // it used to resolve a target with runTarget() and go, which is how a run
  // ended up on a profile nobody chose, failing on that profile's dead proxy.
  onRun: (automation: ScoutAutomation) => void;
  onHistory: (automation: ScoutAutomation) => void;
  // Raises the share sheet. One automation at a time, unlike the table tabs --
  // this grid has no selection model to batch with.
  onShare: (request: ShareRequest) => void;
  // Opens a page on the marketing site in the user's own browser, never in a
  // profile window -- those stay anonymous.
  onOpenSite: (pathname: string) => void;
  // The connector editor, mounted from App like every other modal.
  onNewConnector: () => void;
  onEditConnector: (connector: ScoutConnector) => void;
  // Which cards arrived since this machine last looked at this tab, frozen for
  // the length of the visit. This used to be worked out here, from a
  // localStorage key of its own; it moved to useNewArrivals when Profiles,
  // Proxies and Cookies needed the same answer and the sidebar needed it for
  // tabs nobody is standing on. See src/lib/newSince.ts.
  newIds: ReadonlySet<string>;
}) {
  const {data, automations, library, toast} = useWorkspace();
  const org = useOrg();
  // `runAction`, not `run`: each card in the grid below binds `run` to its own
  // newest AutomationRun, and the shadowing is silent right up until something
  // in a card tries to call this one.
  const {run: runAction, isPending} = useAsyncAction();
  const [view, setView] = useState<View>('all');
  // The "move automations here" picker, offered from an empty folder. This
  // grid has no selection model -- see onShare -- so filing an existing
  // automation happens either here or in the editor's Folder field.
  const [moveOpen, setMoveOpen] = useState(false);
  const {state} = data;
  const inTrash = folderId === TRASH_FOLDER_ID;

  // Starred first, then newest -- re-sorted here rather than trusting the DB
  // order because stars are per-user state the query cannot see.
  //
  // Trash is a folder in the rail but a flag on the row, so it splits the list
  // before anything else narrows it -- the shape visibleProfiles() uses.
  const sorted = useMemo(
      () => sortAutomations(state.automations, state.automation_stars),
      [state.automations, state.automation_stars]);
  const liveAutomations = useMemo(
      () => sorted.filter((automation) => !automation.deleted_at), [sorted]);
  const trashedAutomations = useMemo(
      () => sorted.filter((automation) => automation.deleted_at), [sorted]);
  // What the chips and the grid narrow: Trash, or the chosen folder, or all.
  const list = useMemo(() => {
    if (inTrash) {
      return trashedAutomations;
    }
    return folderId ?
      liveAutomations.filter((automation) => automation.folder_id === folderId) :
      liveAutomations;
  }, [inTrash, folderId, liveAutomations, trashedAutomations]);
  const starred = useMemo(
      () => new Set(state.automation_stars), [state.automation_stars]);

  // The real folder the view is pointed at, if any. '' is All automations and
  // TRASH_FOLDER_ID is a flag on the row; neither is somewhere an automation
  // can be moved to.
  const activeFolder = inTrash ? null :
    state.automation_folders.find((folder) => folder.id === folderId) || null;

  // UX only, never security: trg_automation_limit is the real gate and
  // describeDbError turns its exception into the same sentence. This just says
  // it before the click rather than after. Counted over every live automation
  // rather than the filtered view -- the cap is a property of the workspace,
  // and trashed rows do not count against it (enforce_automation_limit skips
  // them, so a meter that included them would disagree with the database).
  const {atCap} = automationCap(org.org, liveAutomations.length);
  // Trashed profiles still exist and can be restored, so they are not "no
  // profiles" -- offering to mint a Demo one on top of them would be the app
  // failing to see what the user already has.
  const hasNoProfiles = !state.profiles.some((profile) => !profile.deleted_at);
  // Why no run can start, or null. One decision for every card on the tab: it
  // is a property of the workspace, not of any one automation, so computing it
  // per card would be the same answer worked out N times.
  //
  // Shared with RunAutomationModal through runReadiness, which is the point of
  // that file -- the button and the dialog have to agree about which profiles
  // are usable, or the button opens a dialog that refuses everything.
  const block = describeRunBlock(state.profiles, state.proxies);

  // The newest run per automation, from whatever this session has seen. Older
  // history lives in the database and is opened explicitly -- see onHistory.
  //
  // `live` counts alongside it because one automation can now be running on
  // several profiles at once. The newest run alone would report a batch of five
  // as one run, and its status would flip to whichever finished last while four
  // were still going.
  const latest = new Map<string, AutomationRun>();
  const live = new Map<string, number>();
  for (const run of Object.values(automations.runs)) {
    if (!run.automation_id) {
      continue;
    }
    const seen = latest.get(run.automation_id);
    if (!seen || run.started_at > seen.started_at) {
      latest.set(run.automation_id, run);
    }
    if (run.status === 'running') {
      live.set(run.automation_id, (live.get(run.automation_id) || 0) + 1);
    }
  }

  // Nothing in the workspace at all -- not an empty folder, and not an empty
  // Trash. Those are answers; this is the invitation to write the first one,
  // and it replaces the whole screen including the folder rail (there is
  // nothing to file and nowhere to file it from).
  const automationsEmpty = state.automations.length === 0;

  async function deleteFolder(folder: ScoutFolder) {
    if (!window.confirm(
        `Delete folder ${folder.name}? Automations will move to All automations.`)) {
      return;
    }
    if (await library.removeFolder(folder.id)) {
      if (folderId === folder.id) {
        onFolderId('');
      }
      toast.setMessage(`${folder.name} folder deleted`);
    }
  }

  async function purgeOne(automation: ScoutAutomation) {
    // The one place in the app an automation can actually be destroyed, so it
    // says so plainly. window.confirm rather than a dialog of its own: it is
    // reachable only from inside Trash, which is already the "are you sure"
    // step -- unlike the editor's Delete, whose consequence (profiles quietly
    // stopping) needs a sentence that no native prompt can carry.
    if (!window.confirm(
        `Permanently delete ${automation.name}? This cannot be undone.`)) {
      return;
    }
    if (await automations.purge([automation.id])) {
      toast.setMessage(`${automation.name} deleted`);
    }
  }

  async function emptyTrash() {
    if (!window.confirm(
        `Permanently delete ${trashedAutomations.length} ` +
        `automation${trashedAutomations.length === 1 ? '' : 's'}? This cannot be undone.`)) {
      return;
    }
    if (await automations.purgeAll()) {
      toast.setMessage('Trash emptied');
    }
  }

  // .tab-empty, the shape an empty Profiles, Proxies, Cookies or Start tab
  // takes: a centred column with the mark at a fixed 56px, so the glyph lands
  // on the same line whichever of them you arrive at.
  //
  // No longer an early return: the integration bar has to render above it,
  // because the Connectors chip must stay reachable in a workspace that has
  // not written its first automation yet -- connectors are this tab's second
  // collection, not a view of the first.
  //
  // The block survives the restyle -- Extensions has no empty state and says
  // so, but its add-tile stands in for four words of encouragement, and this
  // one carries four distinct offers (create, load the example, mint a Demo
  // profile, read the docs) that no tile can hold.
  const automationsEmptyState = (
      <section className="tab-empty">
        <span className="tab-empty-mark">
          <Workflow size={26} strokeWidth={1.5} />
        </span>
        <h2>No automations yet</h2>
        <p>
          {atCap ?
            'Your plan doesn\'t include automations yet. They run a list of steps ' +
              'against a profile — open a page, fill a form, read something back — ' +
              'on launch, on a schedule, or from an agent.' :
            'An automation is a list of steps run against a profile: open a page, ' +
              'fill a form, read something back. Attach one to a profile and it runs ' +
              'when that profile launches.'}
        </p>
        <div className="tab-empty-actions">
          {atCap ? (
            <button className="primary" onClick={() => onOpenSite(SITE_LINKS.pricing)}>
              See plans
            </button>
          ) : (
            <>
              <button className="primary" onClick={onNew}>
                <Plus size={18} /> Create your first automation
              </button>
              {/* Inside the !atCap branch with the primary button, and for the
                  same reason: loading the example is an INSERT, so an org with
                  no automation slots left must not be offered it only to be
                  refused by trg_automation_limit after the click. */}
              <button className="ghost" onClick={onLoadExample}>
                <Sparkles size={18} /> Load the example
              </button>
            </>
          )}
          {/* A first automation is useless without something to run it on, and
              the Run button stays disabled until one exists. Direct mode needs
              no proxy, so this is the one profile we can offer to make outright
              rather than sending the user to another tab. */}
          {hasNoProfiles && (
            <button className="ghost" onClick={onCreateDemoProfile}>
              <MonitorSmartphone size={18} /> Create a Demo profile
            </button>
          )}
          <button className="ghost" onClick={() => onOpenSite(SITE_LINKS.docs)}>
            <BookOpen size={18} /> See the documentation
          </button>
        </div>
      </section>
  );

  const shown = view === 'pinned' ?
    list.filter((automation) => automation.pinned) :
    view === 'mine' ?
      list.filter((automation) => automation.assigned_to === org.userId) :
      list;
  // The third chip only earns its place once there is somebody to tell apart.
  const showAssignee = state.members.length > 1;

  return (
    <section className="automations-tab">
      {/* The tab's frame, on the paper surface the Extensions and Integrations
          bars use: what you are looking at on the left, how many there are and
          how to make another on the right. */}
      <section className="integration-bar">
        <div className="choice-chips" role="radiogroup" aria-label="Automations view">
          {(['all', 'pinned', 'mine', 'connectors', 'bot'] as const)
              .filter((option) => option !== 'mine' || showAssignee)
              .map((option) => (
                <button
                  aria-checked={view === option}
                  className={view === option ? 'choice-chip active' : 'choice-chip'}
                  key={option}
                  onClick={() => setView(option)}
                  role="radio"
                  type="button"
                >
                  {option === 'all' ? 'All' :
                    option === 'pinned' ? 'On start pages' :
                      option === 'mine' ? 'Assigned to me' :
                        option === 'connectors' ? 'Connectors' : 'Notification bot'}
                </button>
              ))}
        </div>
        {view === 'bot' ? null : view === 'connectors' ? (
          <div className="integration-bar-side">
            <span className="integration-bar-count">
              <strong>{state.connectors.length}</strong>{' '}
              {state.connectors.length === 1 ? 'connector' : 'connectors'}
            </span>
            {/* Owners get the button; members get nothing rather than a
                disabled one -- there is no action they could take to enable
                it, and the read-only view says who can. */}
            {org.isOwner && (
              <button className="ghost" onClick={onNewConnector} title="Add a connector">
                <Plus size={16} /> New connector
              </button>
            )}
          </div>
        ) : (
          <div className="integration-bar-side">
            <span className="integration-bar-count">
              <strong>{shown.length}</strong> {shown.length === 1 ? 'automation' : 'automations'}
            </span>
            {/* In Trash the one bulk action replaces the one that makes no
                sense there: you do not create an automation into Trash. */}
            {inTrash ? (
              <button
                className="ghost danger"
                disabled={trashedAutomations.length === 0}
                onClick={() => void emptyTrash()}
                title="Permanently delete everything in Trash"
              >
                <Trash2 size={16} /> Empty Trash
              </button>
            ) : (
              <button
                className="ghost"
                disabled={atCap}
                onClick={onNew}
                title={atCap ?
                  'Your plan doesn\'t include any more automations.' :
                  'Create an automation'}
              >
                <Plus size={16} /> New automation
              </button>
            )}
          </div>
        )}
      </section>

      {/* Not on Connectors or Notification bot. Those two chips are not views
          of the automation list at all -- they are this tab's other two
          collections -- so a folder rail above them would be filtering
          something that is not on screen. */}
      {view !== 'connectors' && view !== 'bot' && !automationsEmpty && (
        <section className="folder-row" aria-label="Automation folders">
          <button
            aria-pressed={!folderId}
            className={folderId ? 'folder-card' : 'folder-card active'}
            onClick={() => onFolderId('')}
            type="button"
          >
            <span className="folder-glyph"><Workflow size={15} strokeWidth={1.75} /></span>
            <span className="folder-card-name">All automations</span>
            <span className="folder-card-count">{liveAutomations.length}</span>
          </button>

          {state.automation_folders.map((folder) => {
            const count = liveAutomations.filter(
                (automation) => automation.folder_id === folder.id).length;
            const active = folder.id === folderId;
            return (
              // A div, not a button: the pencil and the trash are buttons of
              // their own, and nesting those inside the card's button is both
              // invalid and unclickable.
              <div className={active ? 'folder-card active' : 'folder-card'} key={folder.id}>
                <button
                  aria-pressed={active}
                  className="folder-card-main"
                  onClick={() => onFolderId(folder.id)}
                  type="button"
                >
                  <FolderGlyph color={folder.color} icon={folder.icon} />
                  <span className="folder-card-name">{folder.name}</span>
                </button>
                <span className="folder-card-count">{count}</span>
                <span className="folder-card-actions">
                  <button
                    aria-label={`Edit ${folder.name}`}
                    onClick={() => onEditFolder(folder)}
                    title={`Edit ${folder.name}`}
                    type="button"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    aria-label={`Delete ${folder.name}`}
                    className="danger-icon"
                    onClick={() => void deleteFolder(folder)}
                    title={`Delete ${folder.name}`}
                    type="button"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            );
          })}

          <button
            aria-pressed={inTrash}
            className={inTrash ? 'folder-card active' : 'folder-card'}
            onClick={() => onFolderId(TRASH_FOLDER_ID)}
            type="button"
          >
            <span className="folder-glyph"><Trash2 size={15} strokeWidth={1.75} /></span>
            <span className="folder-card-name">Trash</span>
            <span className="folder-card-count">{trashedAutomations.length}</span>
          </button>

          <button className="folder-card folder-card-new" onClick={onNewFolder} type="button">
            <span className="folder-glyph"><FolderPlus size={15} strokeWidth={1.75} /></span>
            <span className="folder-card-name">New folder</span>
          </button>
        </section>
      )}

      {view === 'connectors' && (
        <ConnectorsView onNew={onNewConnector} onEdit={onEditConnector} />
      )}

      {view === 'bot' && <NotificationBotView />}

      {view !== 'connectors' && view !== 'bot' && automationsEmpty && automationsEmptyState}

      {view !== 'connectors' && view !== 'bot' && !automationsEmpty && <>
      {/* Repeated from the empty state on purpose. That copy of the offer goes
          away the instant the first automation is saved, so someone who loads
          the example before making a profile would otherwise be left with a Run
          button that is disabled and nothing on this tab explaining how to
          un-disable it.
          Shaped like the Extensions tab's admin note rather than as its own
          box: it is a standing fact about the screen, not a message about
          something that just happened. */}
      {hasNoProfiles && (
        <section className="api-note automation-profile-note">
          <MonitorSmartphone size={18} />
          <span>An automation needs a profile to run against.</span>
          <button className="ghost" onClick={onCreateDemoProfile}>
            <MonitorSmartphone size={16} /> Create a Demo profile
          </button>
        </section>
      )}

      <div className="automation-grid">
        {shown.map((automation) => {
          const attachedTo = state.profiles.filter(
              (profile) => !profile.deleted_at && profile.automation_id === automation.id);
          const run = latest.get(automation.id);
          const runningCount = live.get(automation.id) || 0;
          const busy = runningCount > 0;
          const isStarred = starred.has(automation.id);
          // The colour used to tint the plate behind whatever mark the card
          // drew, brand logo included, which put a violet chip behind the
          // Instagram glyph. It rides the frame's edge now instead, so it
          // still identifies the automation and no longer argues with a logo
          // that brought its own colours -- see AutomationMark.
          const frame = automationFrameStyle(automation.color);
          // The verdict the card reports: this session's newest run where there
          // is one, and otherwise the denormalized columns, written by whichever
          // machine ran it last -- which is what survives a restart and what
          // covers a teammate's machine, arriving on the normal focus refresh.
          //
          // Reconciled here rather than rendered as two near-identical rows, as
          // it was: they are one line saying one thing, and only ever differed
          // in where the same four facts were read from.
          const verdict = run ?
            {
              at: run.finished_at || run.started_at,
              duration_ms: run.duration_ms,
              error: run.error,
              status: run.status,
            } :
            automation.last_run_at && automation.last_run_status ?
              {
                at: automation.last_run_at,
                duration_ms: null,
                error: null,
                status: automation.last_run_status,
              } :
              null;
          return (
            <article
              className={newIds.has(automation.id) ?
                'automation-card automation-card-framed is-new' :
                'automation-card automation-card-framed'}
              key={automation.id}
              style={frame}
            >
              {/* The chrome, on the frame rather than in the card: the two
                  secondary actions on the leading edge, the step count on the
                  trailing one. Both used to live below -- Share and History as
                  glyphs crowding the foot beside Run and Edit, the count as a
                  badge competing with the name for the head's first line.
                  Moving them out leaves the card itself holding nothing but the
                  mark, the name, what it does, and the two buttons that matter.
                  Per-card rather than on a selection toolbar, because this tab
                  has no selection model at all -- no checkboxes, no
                  useSelection. Adding one just to reach parity with the three
                  table tabs would be a larger change than the buttons. */}
              <div className="automation-card-bar">
                <div className="automation-card-tools">
                  <button
                    className="automation-card-tool"
                    onClick={() => onShare({kind: 'automation', ids: [automation.id]})}
                    aria-label={`Share ${automation.name}`}
                    title="Share with another workspace"
                    type="button"
                  ><Share2 size={15} /></button>
                  <button
                    className="automation-card-tool"
                    onClick={() => onHistory(automation)}
                    aria-label={`History for ${automation.name}`}
                    title="Run history"
                    type="button"
                  ><History size={15} /></button>
                </div>
                {/* Plain text, not a <Badge>: it is the one fact every
                    automation has, so a chip around it on every card in the
                    grid is twelve outlines reporting the unremarkable.
                    It opens the editor, which the foot's Edit also does. A
                    duplicate on purpose: the steps are what the editor shows,
                    so the count is where a hand goes looking for them, and a
                    label that reads like a link into the thing it counts should
                    be one. */}
                <button
                  className="automation-card-count"
                  onClick={() => onEdit(automation)}
                  title="Open the steps"
                  type="button"
                >
                  {automation.steps.length} step{automation.steps.length === 1 ? '' : 's'}
                </button>
              </div>

              {/* The card proper, inset in the frame on every side. Everything
                  that describes the automation lives in here; everything the
                  app says *about* it -- the actions, the count -- rides the
                  frame outside. */}
              <div className="automation-card-body">
                {/* Mark and name, one wrapping row, like .extension-card-head.
                    Delete used to sit here, at the end of the row. It was the one
                    destructive action in the app reachable in a single click from
                    a grid, on a card whose other three buttons are all safe, and
                    it guarded itself with a window.confirm(). It now lives in the
                    editor's footer beside Cancel and Save -- you open the thing
                    before you throw it away. */}
                <div className="automation-card-head">
                  <AutomationMark icon={automation.icon} color={automation.color} />
                  {/* The star lives INSIDE the h3, straight after the last word
                      of the name, so it cannot wrap away from it into the badge
                      row -- a long name takes its star along to the second line.
                      It is mine, not the workspace's: it re-sorts my grid and
                      nobody else's. aria-pressed rather than two labels, so a
                      screen reader hears one control changing state. */}
                  <h3>
                    {automation.name}
                    <button
                      aria-label={isStarred ?
                        `Unstar ${automation.name}` : `Star ${automation.name}`}
                      aria-pressed={isStarred}
                      className={isStarred ?
                        'automation-star is-starred' : 'automation-star'}
                      onClick={() => automations.setStarred(automation.id, !isStarred)}
                      title={isStarred ? 'Unstar' : 'Star — starred sort to the top'}
                      type="button"
                    >
                      <Star size={15} strokeWidth={2} />
                    </button>
                  </h3>
                </div>

                {/* Always rendered, empty or not: this is the element carrying
                    flex: 1, and it is what makes every card's foot land on the
                    same line across a row. A card without one would pull its
                    buttons up to meet its badges. */}
                <p>{automation.description}</p>

                {/* These were .status-pill -- green text, no fill, no border, no
                    radius, despite the name. Three of them in a row read as one
                    green sentence. Every tab that used it has since moved to
                    <Badge>, and the class is gone. */}
                {(attachedTo.length > 0 || automation.pinned || automation.assigned_to ||
                  automation.schedule?.enabled || automation.created_via === 'mcp' ||
                  (automation.created_by && automation.created_by !== org.userId) ||
                  (automation.tags || []).length > 0) && (
                  <div className="automation-card-meta">
                    {/* First in Trash, because how long is left is the only
                        question worth asking about a card in there. */}
                    {automation.deleted_at && (
                      <Badge
                        icon={<Clock size={12} />}
                        title={`Deleted ${ago(automation.deleted_at)}. ` +
                          `Removed for good ${TRASH_RETENTION_DAYS} days after that.`}
                      >
                        {(() => {
                          const days = daysUntilPurge(automation.deleted_at);
                          return days === 0 ?
                            'Removed today' :
                            `${days} day${days === 1 ? '' : 's'} left`;
                        })()}
                      </Badge>
                    )}
                    {/* "Whose is this" is the question a team asks of a card
                        before any of the others. Only rendered when somebody
                        holds it -- an "Unassigned" badge on every card would be
                        a grid of noise. */}
                    {automation.assigned_to && (
                      <Assignee userId={automation.assigned_to} />
                    )}
                    {/* Who made it -- but only when that is news: an agent over
                        MCP always (created_by is just whoever had the launcher
                        open, which is the misattribution the label corrects), a
                        teammate when it is not you. Your own cards say nothing,
                        for the same reason every card saying "Unassigned" would
                        be noise. */}
                    {automation.created_via === 'mcp' ? (
                      <Badge
                        icon={<Bot size={12} />}
                        title="Created by an agent over MCP"
                      >{automation.created_by_label || 'Agent'}</Badge>
                    ) : automation.created_by && automation.created_by !== org.userId && (
                      <Badge title="Who created this automation">
                        by {assigneeName(automation.created_by, state.members)}
                      </Badge>
                    )}
                    {automation.schedule?.enabled && (
                      <Badge
                        icon={<Clock size={12} />}
                        title="Runs on a schedule while the launcher is open"
                      >{describeSchedule(automation.schedule)}</Badge>
                    )}
                    {attachedTo.length > 0 && (
                      <Badge
                        icon={<Rocket size={12} />}
                        title={attachedTo.map((p) => p.name).join(', ')}
                      >On launch · {attachedTo.length}</Badge>
                    )}
                    {automation.pinned && (
                      <Badge icon={<Workflow size={12} />}>Start page</Badge>
                    )}
                    {/* Tags last, and in the tag chip rather than a Badge, so they
                        read as labels the user chose rather than as more facts the
                        app is reporting about this row. */}
                    {(automation.tags || []).map((tag) => <TagChip key={tag} tag={tag} />)}
                  </div>
                )}

                {/* The last verdict, as a row rather than a sentence: the status
                    coloured and led by its own glyph on one edge, when it
                    happened on the other. It reads as a line in a log, which is
                    what it is -- the most recent entry of the list it opens.
                    A button, because the whole row is the way into the history:
                    the glyph up on the frame is the deliberate route, this is
                    the one you reach for when a red "Failed" is what caught your
                    eye. The error itself moves to the title -- a run that failed
                    on a 300-character stack trace used to wrap it across four
                    lines of the card, and the dialog one click away shows it
                    properly.
                    One block, not two: `verdict` already reconciled this
                    session's runs with the columns the last session left. */}
                {verdict && (
                  <button
                    className={`automation-card-run is-${verdict.status}`}
                    onClick={() => onHistory(automation)}
                    title={verdict.error || 'Open the run history'}
                    type="button"
                  >
                    <span className="automation-card-run-label">
                      {(() => {
                        const Glyph = RUN_GLYPH[verdict.status];
                        return <Glyph aria-hidden="true" size={14} />;
                      })()}
                      {/* "Running · 3" rather than "Running": one automation can
                          be in flight on several profiles now, and a single label
                          would report a batch of five as one run. */}
                      {RUN_LABEL[verdict.status]}
                      {runningCount > 1 ? ` · ${runningCount}` : ''}
                    </span>
                    {/* Duration where there is one, elapsed time otherwise: a
                        finished run is best described by how long it took, and a
                        running one has no how-long yet. */}
                    <span className="automation-card-run-when">
                      {!busy && verdict.duration_ms ?
                        `${(verdict.duration_ms / 1000).toFixed(1)}s · ${ago(verdict.at)}` :
                        ago(verdict.at)}
                    </span>
                  </button>
                )}

                {/* In Trash the two actions are the only two that make sense:
                    put it back, or finish the job. Running or editing
                    something the app is treating as deleted is not offered at
                    all rather than offered and disabled -- there is no state
                    the user could reach from here that would enable them,
                    short of Restore, which is right there. */}
                {inTrash ? (
                  <div className="extension-card-foot">
                    <BusyButton
                      busy={isPending(`restore-${automation.id}`)}
                      busyLabel="Restoring"
                      icon={<Undo2 size={14} />}
                      onClick={() => void runAction(`restore-${automation.id}`, async () => {
                        if (await automations.restore([automation.id])) {
                          toast.setMessage(`${automation.name} restored`);
                        }
                      })}
                    >Restore</BusyButton>
                    <button
                      className="automation-card-edit danger"
                      onClick={() => void purgeOne(automation)}
                      type="button"
                    ><Trash2 size={14} /> Delete permanently</button>
                  </div>
                ) : (
                <div className="extension-card-foot">
                  {/* Opens the picker; it never starts a run itself. It used to
                      resolve a target with runTarget() and go, which is how a run
                      landed on a profile nobody chose and died on that profile's
                      dead proxy. Disabled when nothing in the workspace could
                      accept a run -- but never for "which profile", which is a
                      question the dialog asks.
                      The title is on the wrapper, not on the button. Chromium
                      suppresses pointer events on a disabled control, tooltips
                      included, so the one moment the explanation is needed is the
                      one moment a title on the button itself never appears. */}
                  <span title={block || 'Pick profiles and run'}>
                    <BusyButton
                      busy={busy}
                      busyLabel={runningCount > 1 ? `Running ${runningCount}` : 'Running'}
                      icon={<Play size={14} />}
                      onClick={() => onRun(automation)}
                      disabled={Boolean(block)}
                      // A disabled button is not tabbable, so the reason has to
                      // travel with its name to be readable at all.
                      aria-label={block ? `Run — ${block}` : undefined}
                    >Run</BusyButton>
                  </span>
                  {/* Borderless, in .filter-trigger's vocabulary -- the quiet
                      silhouette the Profiles and Proxies toolbars use for
                      everything that is not the one action the screen is for.
                      With Run filled beside it, the border was the second thing
                      in the foot claiming to be primary. */}
                  <button
                    className="automation-card-edit"
                    onClick={() => onEdit(automation)}
                    type="button"
                  ><Pencil size={14} /> Edit</button>
                </div>
                )}
              </div>
            </article>
          );
        })}

        {/* Last tile rather than a button somewhere else, the pattern the
          * Extensions grid and the start page's bookmark grid both use: the way
          * to get another one of these sits where the next one would go. Not
          * shown while the Pinned filter is on -- a new automation is not
          * pinned, so it would land outside the list it was added to. */}
        {view === 'all' && !atCap && !inTrash && (
          <button className="automation-card extension-add-tile" onClick={onNew} type="button">
            <span className="extension-add-icon"><Plus size={20} strokeWidth={1.75} /></span>
            <span className="extension-add-label">New automation</span>
            <span className="extension-add-hint">
              {activeFolder ?
                `A list of steps run against a profile, filed in ${activeFolder.name}` :
                'A list of steps run against a profile'}
            </span>
          </button>
        )}
      </div>

      {/* Four ways to arrive at an empty grid, and they want four different
        * sentences -- an empty view under a chip or a folder card that is
        * clearly on reads as a page that failed rather than as an answer.
        * The folder case gets a button, because "put something in it" is the
        * one of the four with an action attached. */}
      {shown.length === 0 && (
        inTrash ? (
          <p className="automation-view-empty">
            Trash is empty. Deleted automations stay here for{' '}
            {TRASH_RETENTION_DAYS} days before they are removed for good.
          </p>
        ) : activeFolder ? (
          <div className="automation-view-empty">
            <p>Nothing is filed in {activeFolder.name} yet.</p>
            <button className="ghost" onClick={() => setMoveOpen(true)} type="button">
              <FolderInput size={16} /> Move automations here
            </button>
          </div>
        ) : view === 'pinned' ? (
          <p className="automation-view-empty">
            No automations are on your start pages yet. Open one and pin it, or pin it
            from the Start page tab.
          </p>
        ) : view === 'mine' ? (
          <p className="automation-view-empty">
            Nothing is assigned to you yet.
          </p>
        ) : (
          // view 'all' with an empty list and no folder selected means folderId
          // names a folder that is no longer in state -- a teammate deleted it
          // while this window was open. Not an error worth a dialog: say so and
          // point at the way back.
          <p className="automation-view-empty">
            That folder no longer exists. Pick another, or choose All automations.
          </p>
        )
      )}

      {moveOpen && activeFolder && (
        <MoveAutomationsModal folder={activeFolder} onClose={() => setMoveOpen(false)} />
      )}
      </>}
    </section>
  );
}
