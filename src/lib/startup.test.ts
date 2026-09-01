import {describe, expect, it} from 'vitest';
import type {ApiState, ResourceState} from '../native';
import {describeStartup} from './startup';

function resource(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    browserStatus: 'ready',
    browserVersion: '151.0.7906.0',
    browserPath: '/Applications/EasyDeck.app',
    installedBuildId: 'aRSCo2r',
    installedVersion: '151.0.7906.0',
    installedAt: '2026-08-08T00:00:00.000Z',
    availableVersion: '151.0.7906.0',
    availableReleaseDate: '2026-08-08T00:00:00.000Z',
    availableSize: 184499616,
    notes: '',
    lastCheckedAt: '2026-08-09T00:00:00.000Z',
    updateAvailable: false,
    progress: null,
    error: null,
    ...overrides,
  };
}

const API: ApiState = {status: 'ready', port: 8471, url: 'http://127.0.0.1:8471', error: null};

describe('describeStartup', () => {
  it('blocks before anything has resolved', () => {
    expect(describeStartup(true, resource({browserStatus: 'idle'}), API, false).blocked).toBe(true);
    expect(describeStartup(false, resource(), API, true).blocked).toBe(true);
    expect(describeStartup(true, resource(), {...API, status: 'starting'}, true).blocked).toBe(true);
  });

  it('blocks on the first check, before the browser has ever been ready', () => {
    const startup = describeStartup(true, resource({browserStatus: 'checking'}), API, false);
    expect(startup.blocked).toBe(true);
    expect(startup.detail).toBe('Checking EasyDeck Browser resource.');
  });

  // The regression this file exists for. A manual "Check for updates", and the
  // automatic check every four hours, both push browserStatus to 'checking'. If
  // that re-blocks, App swaps the shell for the startup loader and unmounts
  // every open dialog -- which is what made the Check for updates button look
  // like it was reopening Settings on the Account tab.
  it('does not re-block a re-check once the browser has been ready', () => {
    expect(describeStartup(true, resource({browserStatus: 'checking'}), API, true).blocked).toBe(false);
  });

  // Same reason, one step further along: agreeing to install a browser update
  // must not throw the user out of the app either. The current build keeps
  // launching from its own versioned directory until they relaunch a session.
  it('does not block while a browser update downloads or installs', () => {
    expect(describeStartup(true, resource({browserStatus: 'downloading'}), API, true).blocked).toBe(false);
    expect(describeStartup(true, resource({browserStatus: 'installing'}), API, true).blocked).toBe(false);
  });

  // The latch must not swallow a real failure. Main only reports 'error' when
  // nothing resolved on disk at all, so there is nothing left to launch.
  it('still blocks on an outright browser failure', () => {
    const state = resource({browserStatus: 'error', error: 'HTTP 503 fetching the manifest'});
    const startup = describeStartup(true, state, API, true);
    expect(startup.blocked).toBe(true);
    expect(startup.failed).toBe(true);
    expect(startup.canRetryBrowser).toBe(true);
    expect(startup.detail).toBe('HTTP 503 fetching the manifest');
  });

  it('still blocks when the local API dies mid-session', () => {
    const startup = describeStartup(true, resource(), {...API, status: 'error', error: 'port in use'}, true);
    expect(startup.blocked).toBe(true);
    expect(startup.failed).toBe(true);
    // Nothing to retry here -- only the browser half offers one.
    expect(startup.canRetryBrowser).toBe(false);
  });

  it('is unblocked and quiet when both are up', () => {
    expect(describeStartup(true, resource(), API, true)).toEqual({
      blocked: false,
      failed: false,
      canRetryBrowser: false,
      detail: 'Ready.',
    });
  });
});
