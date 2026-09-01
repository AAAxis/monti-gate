// Updates: the two programs this app is responsible for keeping current.
//
// EasyDeck is two pieces of software -- this launcher, and the Chromium fork it
// starts profiles in -- and they update through entirely separate feeds. The
// old version of this page made that the user's problem: the browser was a
// "Status" row reading "Installed · 1.0.0" (a version the publisher never
// bumped, so it meant nothing) next to a button labelled "Re-download" (which
// actually ran check-and-update-if-stale, and did nothing at all when you were
// current). The launcher was a separate panel with a different shape. Neither
// showed a date, so "Up to date" was an assertion with nothing behind it --
// which mattered, because for six commits it was false.
//
// So: one page, and the two programs described identically. Same facts in the
// same order, same status vocabulary, one button that checks both. Whatever is
// true of one is legible for the other.
import {useEffect, useState} from 'react';
import type {ReactNode} from 'react';
import {
  AppWindow, Check, ChevronDown, Download, FileText, Globe, RefreshCw, RotateCcw,
} from 'lucide-react';
import type {ReleaseEntry, ResourceState, UpdateState} from '../../native';
import {native} from '../../native';
import {formatDate} from '../../lib/text';
import {SettingsGroup, SettingsRow} from '../rows';

// 'neutral' is for a state we did not establish -- a dev build, where the
// updater is off. It is not 'ok': a green tick claims something was checked
// and passed, and nothing was.
type Tone = 'neutral' | 'ok' | 'attention' | 'busy' | 'bad';

type ComponentView = {
  key: 'launcher' | 'browser';
  name: string;
  description: string;
  icon: ReactNode;
  version: string;
  installedAt: string;
  // What the Released row says when there is no date to show. 'Unknown' is the
  // honest default, but it is the wrong word for a build that was never
  // released at all -- see the 'disabled' branch.
  releasedFallback?: string;
  availableVersion: string;
  status: string;
  tone: Tone;
  // Distinguishes "there is a newer one" from "there is not one at all". Both
  // want attention and an action, but the header has to say different things:
  // calling a browser that was never installed "an update" is a lie.
  missing?: boolean;
  // We could not find out where this stands, so the page must not fold it into
  // a claim that everything is current.
  unknown?: boolean;
  // 0-100 while something is transferring, otherwise null.
  percent: number | null;
  note?: string;
  error?: string | null;
  primary?: {label: string; icon?: ReactNode; onClick: () => void};
  secondary?: {label: string; icon?: ReactNode; onClick: () => void}[];
  notes: ReleaseEntry[];
};

export type UpdatesSectionProps = {
  updateState: UpdateState | null;
  updaterBusy: boolean;
  onUpdaterAction: (action: 'check' | 'download' | 'install') => void;
  resourceState: ResourceState | null;
  onCheckBrowser: () => void;
  onInstallBrowser: () => void;
  onOpenChangelog: () => void;
  releaseNotes: {launcher: ReleaseEntry[]; browser: ReleaseEntry[]; fetchedAt: string; stale?: boolean} | null;
};

// "2 minutes ago" beats a timestamp here: the question this answers is "is
// that recent?", and a reader should not have to do the subtraction.
//
// Not lib/relativeTime.ts's ago(). That one is the terse "2m ago" form for
// dense lists -- the inbox bell and the automation cards -- and it returns ''
// for a missing date. This sits inside a sentence, so it needs words, and it
// needs "never" rather than "Last checked ." for a feed that has not been
// reached yet, which is exactly the state worth noticing.
function timeAgo(value: string): string {
  if (!value) {
    return 'never';
  }
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) {
    return 'never';
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return formatDate(value) || 'a while ago';
}

function launcherView(
    state: UpdateState | null,
    busy: boolean,
    act: (action: 'check' | 'download' | 'install') => void,
    notes: ReleaseEntry[]): ComponentView {
  const base = {
    key: 'launcher' as const,
    name: 'EasyDeck',
    description: 'This app: profiles, proxies, cookies and automations.',
    icon: <AppWindow size={17} />,
    version: state?.currentVersion || '',
    // The launcher does not record its own install date -- the OS does, and
    // reading it would mean a main-process stat of our own bundle for one
    // line. The release date of the version being run is the more useful fact
    // anyway: it says how old this build is.
    installedAt: notes.find((entry) => entry.version === state?.currentVersion)?.publishedAt || '',
    availableVersion: '',
    notes,
  };
  const available = state?.updateInfo?.version || '';
  switch (state?.status) {
    case 'disabled':
      return {
        ...base,
        status: 'Development build',
        tone: 'neutral',
        unknown: true,
        percent: null,
        // Not 'Unknown'. A date is missing here because this build was never
        // released, which is a fact we have rather than one we are missing --
        // and saying "Unknown" next to a version number reads as a fault.
        releasedFallback: 'Never released',
        note: 'Updates run in packaged builds only, so there is no release to compare against.',
      };
    case 'checking':
      return {...base, status: 'Checking…', tone: 'busy', percent: null};
    case 'available':
      return {
        ...base,
        status: 'Update available',
        tone: 'attention',
        percent: null,
        availableVersion: available,
        primary: {
          label: available ? `Update to ${available}` : 'Download update',
          icon: <Download size={15} />,
          onClick: () => act('download'),
        },
      };
    case 'downloading':
      return {
        ...base,
        status: `Downloading ${Math.round(state.progress?.percent || 0)}%`,
        tone: 'busy',
        percent: state.progress?.percent ?? 0,
        availableVersion: available,
      };
    case 'downloaded':
      return {
        ...base,
        status: 'Ready to install',
        tone: 'attention',
        percent: null,
        availableVersion: available,
        // The one action here that closes browser windows. Main asks for
        // confirmation when any profile is open, so this stays a plain button.
        note: 'Installing restarts the launcher and closes any open profiles.',
        primary: {
          label: 'Restart & install',
          icon: <RotateCcw size={15} />,
          onClick: () => act('install'),
        },
      };
    case 'error':
      return {
        ...base,
        status: 'Update check failed',
        tone: 'bad',
        percent: null,
        error: state.error,
        primary: {label: 'Try again', icon: <RefreshCw size={15} />, onClick: () => act('check')},
      };
    case 'not-available':
      return {
        ...base,
        status: 'Up to date',
        tone: 'ok',
        percent: null,
        // main routes "the feed has nothing published" through not-available
        // too (applyUpdateError), and that is a different sentence from "we
        // asked and you already have the newest one". Say which happened.
        note: state.error || undefined,
      };
    default:
      // Nothing has been checked yet, so this is not 'ok' -- a green tick here
      // claims a check ran and passed. `unknown` also keeps the page headline
      // from folding an unchecked component into "everything is up to date".
      return {
        ...base,
        status: busy ? 'Checking…' : 'Not checked yet',
        tone: busy ? 'busy' : 'neutral',
        unknown: !busy,
        percent: null,
      };
  }
}

function browserView(
    state: ResourceState | null,
    onCheck: () => void,
    onInstall: () => void,
    notes: ReleaseEntry[]): ComponentView {
  const installed = state?.installedVersion || state?.browserVersion || '';
  const base = {
    key: 'browser' as const,
    name: 'EasyDeck Browser',
    description: 'The browser profiles launch into. It updates separately from the launcher.',
    icon: <Globe size={17} />,
    version: installed,
    installedAt: state?.installedAt || '',
    availableVersion: '',
    notes,
  };
  switch (state?.browserStatus) {
    case 'checking':
      return {...base, status: 'Checking…', tone: 'busy', percent: null};
    case 'downloading':
      return {
        ...base,
        status: `Downloading ${state.progress?.percent || 0}%`,
        tone: 'busy',
        percent: state.progress?.percent ?? 0,
        availableVersion: state.availableVersion,
        note: 'Open sessions keep the current build until you relaunch them.',
      };
    case 'installing':
      return {
        ...base,
        status: 'Installing…',
        tone: 'busy',
        percent: null,
        availableVersion: state.availableVersion,
      };
    case 'ready':
      if (state.updateAvailable) {
        return {
          ...base,
          status: 'Update available',
          tone: 'attention',
          percent: null,
          availableVersion: state.availableVersion,
          // Says plainly what the versioned-directory install already
          // guarantees, so nobody closes their work first for no reason.
          note: 'Open sessions keep the current build until you relaunch them.',
          primary: {
            label: state.availableVersion ? `Update to ${state.availableVersion}` : 'Update',
            icon: <Download size={15} />,
            onClick: onInstall,
          },
        };
      }
      // An error on an otherwise-ready browser means the *check* failed, not
      // the install -- main falls back to the working copy on disk when it
      // cannot reach the feed. So the browser still launches, but claiming
      // "Up to date" under a red error line would be asserting something we
      // did not manage to find out.
      if (state.error) {
        return {
          ...base,
          status: 'Update check failed',
          tone: 'bad',
          percent: null,
          error: state.error,
          note: 'The installed browser still works. Only the check for a newer one failed.',
          primary: {label: 'Try again', icon: <RefreshCw size={15} />, onClick: onCheck},
        };
      }
      return {
        ...base,
        status: 'Up to date',
        tone: 'ok',
        percent: null,
      };
    case 'error':
      return {
        ...base,
        status: 'Not installed',
        tone: 'bad',
        missing: true,
        percent: null,
        error: state.error,
        primary: {label: 'Try again', icon: <RefreshCw size={15} />, onClick: onCheck},
      };
    default:
      return {
        ...base,
        status: 'Not installed',
        tone: 'attention',
        missing: true,
        percent: null,
        note: 'Profiles cannot launch until this is installed. It is about 200 MB.',
        primary: {label: 'Install', icon: <Download size={15} />, onClick: onInstall},
      };
  }
}

function ComponentCard({view}: {view: ComponentView}) {
  const [openNotes, setOpenNotes] = useState(false);
  const entry = view.notes.find((item) => item.version === view.version);
  return (
    <article className={`update-component tone-${view.tone}`}>
      <header>
        <span className="update-component-icon" aria-hidden="true">{view.icon}</span>
        <div className="update-component-id">
          <h4>{view.name}</h4>
          <p>{view.description}</p>
        </div>
        <span className={`update-pill tone-${view.tone}`}>
          {view.tone === 'ok' && <Check size={13} />}
          {view.status}
        </span>
      </header>

      <dl className="update-component-facts">
        <div>
          <dt>Version</dt>
          <dd>{view.version || '—'}</dd>
        </div>
        <div>
          <dt>Released</dt>
          <dd>{formatDate(view.installedAt) || view.releasedFallback || 'Unknown'}</dd>
        </div>
        {view.availableVersion && view.availableVersion !== view.version && (
          <div>
            <dt>Available</dt>
            <dd className="update-fact-new">{view.availableVersion}</dd>
          </div>
        )}
      </dl>

      {view.percent !== null && (
        <div className="update-progress">
          <span style={{width: `${Math.min(100, Math.max(0, view.percent))}%`}} />
        </div>
      )}

      {view.note && <p className="update-component-note">{view.note}</p>}
      {view.error && <p className="update-component-error">{view.error}</p>}

      <footer>
        <div className="update-component-actions">
          {view.primary && (
            <button onClick={view.primary.onClick} type="button">
              {view.primary.icon} {view.primary.label}
            </button>
          )}
          {view.secondary?.map((action) => (
            <button className="ghost" key={action.label} onClick={action.onClick} type="button">
              {action.icon} {action.label}
            </button>
          ))}
        </div>
        {view.notes.length > 0 && (
          <button
            aria-expanded={openNotes}
            className="ghost update-notes-toggle"
            onClick={() => setOpenNotes((open) => !open)}
            type="button"
          >
            <ChevronDown className={openNotes ? 'rotated' : ''} size={15} /> What&apos;s new
          </button>
        )}
      </footer>

      {openNotes && (
        <div className="update-component-notes">
          {entry?.notes ?
            <pre>{entry.notes}</pre> :
            <p>
              No notes were published for {view.version || 'this version'}.
              {view.notes.length > 0 && ' Older releases are in the full changelog.'}
            </p>}
        </div>
      )}
    </article>
  );
}

export function UpdatesSection({
  updateState,
  updaterBusy,
  onUpdaterAction,
  resourceState,
  onCheckBrowser,
  onInstallBrowser,
  onOpenChangelog,
  releaseNotes,
}: UpdatesSectionProps) {
  const launcher = launcherView(
      updateState, updaterBusy, onUpdaterAction, releaseNotes?.launcher || []);
  const browser = browserView(
      resourceState, onCheckBrowser, onInstallBrowser, releaseNotes?.browser || []);

  const checking = updaterBusy ||
    updateState?.status === 'checking' ||
    ['checking', 'downloading', 'installing'].includes(resourceState?.browserStatus || '');
  // The most recent time either feed was actually reached. "Up to date" with
  // no date behind it is what let a stale feed go unnoticed for six commits.
  const lastChecked = [updateState?.lastCheckedAt, resourceState?.lastCheckedAt]
      .filter(Boolean)
      .sort()
      .pop() || '';
  // The lastChecked value at the moment the user asked, held until it moves.
  // null means nobody is waiting on an answer.
  const [pendingSince, setPendingSince] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (pendingSince !== null && lastChecked && lastChecked !== pendingSince) {
      setPendingSince(null);
      setConfirmed(true);
    }
  }, [pendingSince, lastChecked]);

  const views = [launcher, browser];
  const stale = views.filter((view) => view.primary && view.tone === 'attention' && !view.missing);
  const missing = views.filter((view) => view.missing);
  const failed = views.filter((view) => view.tone === 'bad' && !view.missing);
  const known = views.filter((view) => !view.unknown);

  // In the order that matters to act on. A failed check outranks an available
  // update because it means the other answers on this page are unverified --
  // saying "everything is up to date" over a red error was exactly the kind of
  // unearned reassurance this page exists to stop giving.
  const headline =
    missing.length > 0 ? `${missing[0].name} is not installed` :
    failed.length > 0 ? 'Could not check for updates' :
    stale.length > 1 ? 'Updates are available for both' :
    stale.length === 1 ? `An update is available for ${stale[0].name}` :
    // Neither feed has been reached, so there is nothing to be up to date
    // against. Before `unknown` covered this state the page opened on a green
    // "Everything is up to date" that no check stood behind.
    known.length === 0 ? 'Not checked for updates yet' :
    // Only the components we actually checked. In a dev build the launcher is
    // not one of them, and "everything" would be covering for that.
    known.length < views.length ? `${known.map((view) => view.name).join(' and ')} is up to date` :
    'Everything is up to date';

  // A check that came back with no work to do. Drives the confirmation tick.
  const nothingToDo = missing.length === 0 && failed.length === 0 && stale.length === 0;

  // Confirming a manual check is the whole point of the button when the answer
  // is "nothing changed": without it the spinner runs, the page comes back
  // looking identical, and the only evidence anything happened is a relative
  // timestamp that already said "just now" a minute ago.
  //
  // Keyed on lastChecked moving rather than on the busy flag going false. Busy
  // is still false for the render immediately after the click, so watching it
  // would confirm a check that had not started.
  function checkBoth() {
    setConfirmed(false);
    setPendingSince(lastChecked);
    onUpdaterAction('check');
    onCheckBrowser();
  }

  return (
    <SettingsGroup title="Updates">
      <div className="updates-header">
        <div className="updates-header-text">
          <h4>{headline}</h4>
          {/* Only a check that came back clean gets the tick. If it turned
            * something up, the headline above already changed and a green
            * "checked" line underneath would be arguing with it. */}
          <p className={confirmed && nothingToDo ? 'updates-checked' : undefined}>
            {confirmed && nothingToDo && <Check size={13} />}
            Last checked {timeAgo(lastChecked)}.
          </p>
        </div>
        <div className="updates-header-actions">
          {stale.length > 1 && (
            <button onClick={() => stale.forEach((view) => view.primary?.onClick())} type="button">
              <Download size={15} /> Update all
            </button>
          )}
          <button className="ghost" disabled={checking} onClick={checkBoth} type="button">
            <RefreshCw className={checking ? 'spinning' : ''} size={15} />
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
      </div>

      <ComponentCard view={launcher} />
      <ComponentCard view={browser} />

      <SettingsRow
        label="Changelog"
        description="Every release of both programs, newest first."
      >
        <button className="ghost" onClick={onOpenChangelog} type="button">
          <FileText size={15} /> View changelog
        </button>
      </SettingsRow>
    </SettingsGroup>
  );
}
