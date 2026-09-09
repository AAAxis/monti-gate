import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {sinceLabel, storedCheckState} from './ProxyCheckCell';
import type {ScoutProxy} from '../../types';

function proxy(patch: Partial<ScoutProxy>): ScoutProxy {
  return {id: 'p1', name: 'p1', type: 'socks5', host: '198.51.100.10', port: 1080, ...patch};
}

describe('storedCheckState', () => {
  it('reads a passing check off the stored columns', () => {
    expect(storedCheckState(proxy({
      checked_at: '2026-08-04T12:00:00.000Z',
      ping_ms: 685,
      country: 'United States',
      country_code: 'US',
    }))).toEqual({status: 'ok', pingMs: 685, country: 'United States', countryCode: 'US'});
  });

  // The failure has to win over the timestamp: a proxy that failed its last check
  // still *has* a checked_at, and reading that first would badge a dead proxy as
  // reachable with 0 ms.
  it('reports a failure even though the check ran', () => {
    expect(storedCheckState(proxy({
      checked_at: '2026-08-04T12:00:00.000Z',
      check_error: 'Proxy needs a username and password (407 Proxy Authentication Required)',
    }))).toEqual({
      status: 'fail',
      error: 'Proxy needs a username and password (407 Proxy Authentication Required)',
    });
  });

  it('is unchecked with no timestamp', () => {
    expect(storedCheckState(proxy({}))).toEqual({status: 'unchecked'});
  });

  // The Profiles table asks about the proxy behind a profile, and a direct
  // profile has none.
  it('is unchecked for no proxy at all', () => {
    expect(storedCheckState(null)).toEqual({status: 'unchecked'});
    expect(storedCheckState(undefined)).toEqual({status: 'unchecked'});
  });
});

describe('sinceLabel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads coarsely, in the units someone acts on', () => {
    expect(sinceLabel('2026-08-05T11:59:30.000Z')).toBe('just now');
    expect(sinceLabel('2026-08-05T11:45:00.000Z')).toBe('15m ago');
    expect(sinceLabel('2026-08-05T09:00:00.000Z')).toBe('3h ago');
    expect(sinceLabel('2026-08-03T12:00:00.000Z')).toBe('2d ago');
  });

  // Past a week the relative form stops meaning anything, so it becomes a date.
  it('falls back to the date beyond a week', () => {
    expect(sinceLabel('2026-07-20T12:00:00.000Z')).toBe('2026-07-20');
  });

  it('does not render NaN for an unparseable timestamp', () => {
    expect(sinceLabel('not a date')).toBe('unknown');
  });
});
