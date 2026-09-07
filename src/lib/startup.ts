// The startup gate: whether the shell shows the app or the loading screen.
//
// Lives outside App.tsx so it can be tested. The bug it exists to prevent is
// not a rendering bug and does not look like one -- see below.
import type {ApiState, ResourceState} from '../native';

export type Startup = {
  blocked: boolean;
  failed: boolean;
  canRetryBrowser: boolean;
  detail: string;
};

// Both the browser resource and the local API have to be up before any tab is
// worth showing: a launch with either missing fails in a way the user cannot
// act on from inside the app.
//
// `browserWasReady` is what keeps this a startup gate rather than a
// whenever-we-touch-the-network gate. Blocking means "this app cannot be used
// right now", and that is only true before the browser has resolved once. A
// later check re-entering 'checking' says nothing about whether the copy on
// disk still launches -- it does, and applyBrowserResourceError in main falls
// back to it even when the check fails outright.
//
// Without the latch, every browser check swapped the whole shell for the
// startup loader, which unmounted everything below it. checkBrowserResource
// broadcasts 'checking' from the Check for updates button *and* on a four-hour
// timer, so an open Settings dialog vanished and came back on its first tab.
// It read as the button reopening Settings on Account -- a settings-routing bug
// that was never in settings at all.
export function describeStartup(
    orgReady: boolean,
    resourceState: ResourceState | null,
    apiState: ApiState | null,
    browserWasReady: boolean): Startup {
  const browserFailed = resourceState?.browserStatus === 'error';
  const apiFailed = apiState?.status === 'error';
  const browserReady = resourceState?.browserStatus === 'ready';
  const apiReady = apiState?.status === 'ready';
  const detail = !orgReady ? 'Checking cloud session and loading workspace.' :
    browserFailed ? resourceState?.error || 'Scout Web Browser resource failed to install.' :
      apiFailed ? apiState?.error || 'Local API failed to start.' :
        !browserReady ? (
          resourceState?.browserStatus === 'downloading' ?
            `Downloading Scout Web Browser ${resourceState.progress?.percent || 0}%` :
            resourceState?.browserStatus === 'installing' ?
              'Installing Scout Web Browser.' :
              'Checking Scout Web Browser resource.'
        ) :
          !apiReady ? 'Starting local API.' : 'Ready.';
  return {
    // browserFailed still blocks even once latched: main only reports 'error'
    // when nothing resolved on disk at all, which is exactly the case a user
    // has to act on before any tab is worth showing.
    blocked: !orgReady || browserFailed || (!browserReady && !browserWasReady) || !apiReady,
    failed: browserFailed || apiFailed,
    canRetryBrowser: browserFailed,
    detail,
  };
}
