// Every state of the Updates page, on one scrollable page, with no launcher
// running and nobody signed in.
//
//   npx vite --host 127.0.0.1
//   open http://127.0.0.1:5173/preview-updates.html
//
// It mounts the real UpdatesSection and the real ChangelogModal against
// fixtures -- a harness carrying its own copy of the markup is a harness that
// stops describing the thing. Only the props are invented.
//
// The states here are the ones that are awkward to reach by hand: an update
// mid-download, a launcher waiting to install, a browser that was never
// installed, a failed check, and the offline changelog. Getting to any of them
// in the real app means publishing a release or pulling the network out.
import {StrictMode, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {ReleaseEntry, ReleaseNotes, ResourceState, UpdateState} from './native';
import {UpdatesSection} from './settings/sections/UpdatesSection';
import {ChangelogModal} from './components/modals/SettingsModal';
import './styles.css';

const NOW = Date.now();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

const LAUNCHER_RELEASES: ReleaseEntry[] = [
  {
    tag: 'v1.0.58', version: '1.0.58', name: 'v1.0.58',
    publishedAt: minutesAgo(90),
    notes: 'Updates now publish on tags only, so a build can no longer replace a\n' +
      'version clients already have.\n\n  - One Updates page for the launcher and the browser.\n' +
      '  - The browser reports its real Chromium version.\n  - Changelog reads the release list.',
  },
  {
    tag: 'v1.0.57', version: '1.0.57', name: 'v1.0.57',
    publishedAt: minutesAgo(60 * 48),
    notes: 'Scout Web Panel follow-ups, statuses for proxies and cookie-sets, and the\ncollapsible sidebar rail.',
  },
  // Every release published before body_path was wired into the workflow.
  {tag: 'v1.0.56', version: '1.0.56', name: 'v1.0.56', publishedAt: minutesAgo(60 * 120), notes: ''},
];

const BROWSER_RELEASES: ReleaseEntry[] = [
  {
    tag: 'browser-v151.0.7906.0-mac-arm64', version: '151.0.7906.0', name: 'Scout Web Browser 151.0.7906.0',
    publishedAt: minutesAgo(60 * 10),
    notes: 'Chromium 151. Injector rebuilt against the new bindings.',
  },
  {
    tag: 'browser-v150.0.7100.0-mac-arm64', version: '150.0.7100.0', name: 'Scout Web Browser 150.0.7100.0',
    publishedAt: minutesAgo(60 * 24 * 30), notes: 'Chromium 150.',
  },
];

const NOTES: ReleaseNotes = {
  launcher: LAUNCHER_RELEASES, browser: BROWSER_RELEASES, fetchedAt: minutesAgo(4),
};

function update(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    status: 'not-available',
    currentVersion: '1.0.58',
    lastCheckedAt: minutesAgo(3),
    updateInfo: null,
    progress: null,
    downloaded: false,
    error: null,
    canCheck: true,
    provider: 'generic',
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    browserStatus: 'ready',
    browserVersion: '151.0.7906.0',
    browserPath: '/Users/roman/Library/Application Support/Scout Web/Browser/v-aRSCo2rF7erpS/Scout Web.app',
    installedBuildId: 'aRSCo2r/F7erpSX',
    installedVersion: '151.0.7906.0',
    installedAt: minutesAgo(60 * 10),
    availableVersion: '151.0.7906.0',
    availableReleaseDate: minutesAgo(60 * 10),
    availableSize: 184499616,
    notes: '',
    lastCheckedAt: minutesAgo(3),
    updateAvailable: false,
    progress: null,
    error: null,
    ...overrides,
  };
}

const STATES: {title: string; why: string; update: UpdateState; resource: ResourceState}[] = [
  {
    title: 'Both current',
    why: 'The ordinary state. Must read as calm and still carry a date.',
    update: update(),
    resource: resource(),
  },
  {
    title: 'Browser update available',
    why: 'The case that had no UI at all before -- the browser only ever offered "Re-download".',
    update: update(),
    resource: resource({
      updateAvailable: true, availableVersion: '151.0.7912.0',
      installedVersion: '151.0.7906.0', browserVersion: '151.0.7906.0',
    }),
  },
  {
    title: 'Launcher update available',
    update: update({status: 'available', updateInfo: {version: '1.0.59', releaseNotes: 'Fixes.'}}),
    why: 'Primary action names the version rather than saying "Download".',
    resource: resource(),
  },
  {
    title: 'Both stale — "Update all" appears',
    why: 'The only state that earns a bulk action, so it is the only one that shows one.',
    update: update({status: 'available', updateInfo: {version: '1.0.59'}}),
    resource: resource({updateAvailable: true, availableVersion: '151.0.7912.0'}),
  },
  {
    title: 'Launcher downloading',
    why: 'Progress bar and a percentage in the pill; no action offered mid-transfer.',
    update: update({
      status: 'downloading',
      updateInfo: {version: '1.0.59'},
      progress: {percent: 42.4, bytesPerSecond: 2_400_000, transferred: 47_000_000, total: 111_000_000},
    }),
    resource: resource(),
  },
  {
    title: 'Launcher downloaded, ready to install',
    why: 'The one action that closes browser windows. Says so, and main asks again.',
    update: update({status: 'downloaded', downloaded: true, updateInfo: {version: '1.0.59'}}),
    resource: resource(),
  },
  {
    title: 'Browser downloading 200 MB',
    why: 'Must reassure that open sessions survive -- the install goes to a new directory.',
    update: update(),
    resource: resource({
      browserStatus: 'downloading', updateAvailable: true, availableVersion: '151.0.7912.0',
      progress: {percent: 18, transferred: 33_000_000, total: 184_499_616},
    }),
  },
  {
    title: 'Nothing installed yet (first run)',
    why: 'Profiles cannot launch at all here, and the download is ~200 MB. Both stated.',
    update: update(),
    resource: resource({
      browserStatus: 'idle', browserPath: '', installedVersion: '', browserVersion: '',
      installedAt: '', availableVersion: '', lastCheckedAt: '',
    }),
  },
  {
    title: 'Offline — check failed, install still usable',
    why: 'The browser still launches; the error explains the check, not the app.',
    update: update({status: 'error', error: 'getaddrinfo ENOTFOUND pub-a6c0e96f900b4b698762591fddd497aa.r2.dev'}),
    resource: resource({error: 'HTTP 503 fetching latest-mac-arm64.json'}),
  },
  {
    title: 'Development build',
    why: 'The updater is disabled outright here. Says why instead of showing a dead button.',
    update: update({status: 'disabled', canCheck: false, provider: 'disabled', lastCheckedAt: ''}),
    resource: resource(),
  },
  {
    title: 'Nothing checked yet',
    why: 'The first seconds after launch, before either feed answers. Must not show a ' +
      'green tick or claim to be up to date -- no check has run to stand behind it.',
    update: update({status: 'idle', lastCheckedAt: ''}),
    resource: resource(),
  },
];

function noop() {
  // The harness has no main process behind it.
}

function Preview() {
  const [changelog, setChangelog] = useState<'none' | 'live' | 'offline' | 'empty'>('none');
  const notes = changelog === 'offline' ?
    {...NOTES, stale: true} :
    changelog === 'empty' ?
      {launcher: [], browser: [], fetchedAt: '', stale: true} :
      NOTES;

  return (
    <div className="preview-page">
      <header className="preview-head">
        <h1>Updates page — every state</h1>
        <div>
          <button onClick={() => setChangelog('live')} type="button">Changelog</button>
          <button onClick={() => setChangelog('offline')} type="button">Changelog (offline)</button>
          <button onClick={() => setChangelog('empty')} type="button">Changelog (nothing cached)</button>
        </div>
      </header>

      {STATES.map((state) => (
        <section className="preview-state" data-state={state.title} key={state.title}>
          <div className="preview-label">
            <h2>{state.title}</h2>
            <p>{state.why}</p>
          </div>
          <div className="settings-panel preview-frame">
            <UpdatesSection
              onCheckBrowser={noop}
              onInstallBrowser={noop}
              onOpenChangelog={() => setChangelog('live')}
              onUpdaterAction={noop}
              releaseNotes={NOTES}
              resourceState={state.resource}
              updateState={state.update}
              updaterBusy={false}
            />
          </div>
        </section>
      ))}

      {changelog !== 'none' && (
        <ChangelogModal
          installedBrowserVersion="151.0.7906.0"
          onClose={() => setChangelog('none')}
          releaseNotes={notes}
          updater={{
            updateState: update(),
            busy: false,
            run: async () => undefined,
            dismissedVersion: '',
            setDismissedVersion: noop,
          }}
        />
      )}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { background: var(--paper); margin: 0; }
  .preview-page { display: grid; gap: 28px; margin: 0 auto; max-width: 760px; padding: 28px 20px 80px; }
  .preview-head { display: grid; gap: 10px; }
  .preview-head h1 { color: var(--ink); font-size: 19px; margin: 0; }
  .preview-head div { display: flex; gap: 8px; }
  .preview-state { display: grid; gap: 10px; }
  .preview-label h2 { color: var(--ink); font-size: 14px; margin: 0; }
  .preview-label p { color: var(--ink-faint); font-size: 12px; margin: 3px 0 0; }
  .preview-frame { background: var(--surface); border: 1px solid var(--border);
    border-radius: 14px; padding: 16px 18px; }
`;
document.head.append(style);

createRoot(document.getElementById('root')!).render(
    <StrictMode><Preview /></StrictMode>,
);
