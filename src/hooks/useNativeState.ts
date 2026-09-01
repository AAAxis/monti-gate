import {useEffect, useState} from 'react';
import {native} from '../native';
import type {ApiState, ReleaseNotes, ResourceState, UpdateState} from '../native';
import type {Toast} from './useToast';

// The three main-process status channels all follow one shape: ask once at
// mount, then subscribe. Written once here instead of three near-identical
// effects.
function useSubscribedState<T>(
    get: (() => Promise<T>) | undefined,
    subscribe: ((listener: (value: T) => void) => () => void) | undefined) {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let cancelled = false;
    void get?.().then((next) => {
      if (!cancelled) {
        setValue(next);
      }
    });
    const unsubscribe = subscribe?.((next) => setValue(next));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // The native bridge is a module singleton; these never change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [value, setValue] as const;
}

// Whether the bundled browser and the local automation API are ready. The app
// shell blocks on both -- a launch with either missing fails in a way the user
// cannot act on.
export function useResourceStatus(toast: Toast) {
  const [resourceState, setResourceState] = useSubscribedState<ResourceState>(
      native?.getResourceStatus?.bind(native), native?.onResourceState?.bind(native));
  const [apiState] = useSubscribedState<ApiState>(
      native?.getApiStatus?.bind(native), native?.onApiState?.bind(native));

  const {updateMessage, setMessage} = toast;
  useEffect(() => {
    if (resourceState?.browserStatus === 'downloading') {
      const percent = resourceState.progress?.percent ? ` ${resourceState.progress.percent}%` : '';
      setMessage(`Downloading EasyDeck Browser${percent}`);
    } else if (resourceState?.browserStatus === 'installing') {
      setMessage('Installing EasyDeck Browser');
    } else if (resourceState?.browserStatus === 'ready') {
      // Only clear our own progress line -- another action's toast may have
      // landed in the meantime and is not ours to wipe.
      updateMessage((current) =>
        current.startsWith('Downloading EasyDeck Browser') || current === 'Installing EasyDeck Browser' ?
          '' :
          current);
    } else if (resourceState?.browserStatus === 'error') {
      setMessage(resourceState.error || 'Failed to download EasyDeck Browser');
    }
  }, [resourceState, setMessage, updateMessage]);

  return {
    resourceState,
    apiState,
    // Look, don't fetch.
    checkBrowser: () => void native?.checkBrowserResource?.().then(setResourceState),
    // Fetch and install: "Update to X", "Install", and "Reinstall" all land
    // here. Kept under the old name because App and the browser-missing
    // banner both already call it.
    retryBrowserDownload: () => void native?.downloadBrowserResource?.().then(setResourceState),
  };
}

// Release history for the changelog, from the GitHub release list both
// programs publish to. Loaded once on mount; the main process caches it, so
// re-opening the changelog costs nothing.
export function useReleaseNotes() {
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNotes | null>(null);
  useEffect(() => {
    let cancelled = false;
    void native?.getReleaseNotes?.().then((notes) => {
      if (!cancelled) {
        setReleaseNotes(notes);
      }
    // A changelog is not worth an error state. If this fails the modal says so
    // and offers a retry.
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return releaseNotes;
}

// Launcher self-update: the status the main process reports, the three actions
// the user can take, and which version they have dismissed the corner toast
// for. Dismissal is per-version on purpose -- closing it should not hide a
// later, different update forever.
export function useUpdater(toast: Toast) {
  const [updateState, setUpdateState] = useSubscribedState<UpdateState>(
      native?.getUpdateStatus?.bind(native), native?.onUpdateState?.bind(native));
  const [busy, setBusy] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState('');

  async function run(action: 'check' | 'download' | 'install') {
    try {
      setBusy(true);
      if (action === 'check') {
        const state = await native?.checkForUpdates?.();
        if (state) {
          setUpdateState(state);
        }
      } else if (action === 'download') {
        const state = await native?.downloadUpdate?.();
        if (state) {
          setUpdateState(state);
        }
      } else {
        const result = await native?.installUpdate?.();
        if (result && !result.ok) {
          toast.setMessage(result.error || 'Update is not ready to install');
        }
      }
    } catch (error) {
      toast.setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return {updateState, busy, run, dismissedVersion, setDismissedVersion};
}
