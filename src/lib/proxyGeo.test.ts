import {describe, expect, it} from 'vitest';
import {expectedTimezoneFor, proxyLocationLabel, timezoneMismatch, utcOffsetMinutes} from './proxyGeo';
import type {ScoutProxy} from '../types';

function proxy(patch: Partial<ScoutProxy> = {}): ScoutProxy {
  return {id: 'p1', name: 'Test', host: '203.0.113.10', port: 8080, ...patch};
}

describe('expectedTimezoneFor', () => {
  // The whole point of the feature: the per-IP zone the check measured beats the
  // country table, which only knows one zone per country.
  it('prefers the measured per-IP zone over the country default', () => {
    expect(expectedTimezoneFor(proxy({country_code: 'US', timezone: 'America/Denver'})))
        .toBe('America/Denver');
  });

  it('falls back to the country default when the IP zone is unknown', () => {
    expect(expectedTimezoneFor(proxy({country_code: 'US'}))).toBe('America/New_York');
  });

  it('is case-insensitive about the country code', () => {
    expect(expectedTimezoneFor(proxy({country_code: 'de'}))).toBe('Europe/Berlin');
  });

  // A proxy with no location does not imply a timezone, and inventing one would
  // be worse than admitting it -- everything downstream keys off this null.
  it('returns null for an unchecked proxy', () => {
    expect(expectedTimezoneFor(proxy())).toBeNull();
    expect(expectedTimezoneFor(null)).toBeNull();
  });

  it('returns null for a country the table does not cover', () => {
    expect(expectedTimezoneFor(proxy({country_code: 'zz'}))).toBeNull();
  });
});

describe('utcOffsetMinutes', () => {
  it('reads a fixed-offset zone', () => {
    // UTC is UTC in every season, so this is safe to assert absolutely.
    expect(utcOffsetMinutes('UTC', new Date('2026-08-06T12:00:00Z'))).toBe(0);
  });

  it('accounts for daylight saving at the given instant', () => {
    // New York is UTC-4 in August and UTC-5 in January. A fixed table would get
    // one of these wrong, which is why the offset is computed per instant.
    expect(utcOffsetMinutes('America/New_York', new Date('2026-08-06T12:00:00Z'))).toBe(-240);
    expect(utcOffsetMinutes('America/New_York', new Date('2026-01-06T12:00:00Z'))).toBe(-300);
  });

  it('returns null rather than throwing on a zone ICU does not know', () => {
    expect(utcOffsetMinutes('Mars/Olympus_Mons')).toBeNull();
  });
});

describe('timezoneMismatch', () => {
  const august = new Date('2026-08-06T12:00:00Z');

  it('flags a zone on a different offset from the proxy', () => {
    const result = timezoneMismatch('America/Chicago', proxy({
      country_code: 'US', timezone: 'America/New_York', city: 'New York',
    }));
    expect(result).toMatchObject({chosen: 'America/Chicago', expected: 'America/New_York'});
  });

  // The reason the comparison is by offset and not by name. Detroit and New York
  // are the same clock, so warning about them would be noise -- and a warning
  // people learn to dismiss protects nobody.
  it('does not flag two names that are the same clock', () => {
    expect(timezoneMismatch('America/New_York', proxy({timezone: 'America/Detroit'}))).toBeNull();
    expect(utcOffsetMinutes('America/Detroit', august))
        .toBe(utcOffsetMinutes('America/New_York', august));
  });

  it('says nothing when the profile is on Auto from proxy', () => {
    expect(timezoneMismatch('Auto from proxy', proxy({timezone: 'Asia/Tokyo'}))).toBeNull();
  });

  it('says nothing when there is no proxy or no known location', () => {
    expect(timezoneMismatch('Asia/Tokyo', null)).toBeNull();
    expect(timezoneMismatch('Asia/Tokyo', proxy())).toBeNull();
  });

  it('says nothing when either zone is unparseable', () => {
    expect(timezoneMismatch('Not/AZone', proxy({timezone: 'Asia/Tokyo'}))).toBeNull();
    expect(timezoneMismatch('Asia/Tokyo', proxy({timezone: 'Not/AZone'}))).toBeNull();
  });

  it('names the proxy by location, falling back to host:port', () => {
    expect(timezoneMismatch('Asia/Tokyo', proxy({
      timezone: 'America/New_York', city: 'New York', country: 'United States',
    }))?.proxyLabel).toBe('New York, United States');
    expect(timezoneMismatch('Asia/Tokyo', proxy({timezone: 'America/New_York'}))?.proxyLabel)
        .toBe('203.0.113.10:8080');
  });
});

describe('proxyLocationLabel', () => {
  it('joins city, region and country', () => {
    expect(proxyLocationLabel(proxy({city: 'Denver', region: 'Colorado', country: 'United States'})))
        .toBe('Denver, Colorado, United States');
  });

  // ip-api.com returns city and regionName equal for city-states and some
  // metros, which read as a stutter ("Singapore, Singapore, Singapore").
  it('collapses repeated parts', () => {
    expect(proxyLocationLabel(proxy({city: 'Singapore', region: 'Singapore', country: 'Singapore'})))
        .toBe('Singapore');
  });

  it('is empty for a proxy with no location', () => {
    expect(proxyLocationLabel(proxy())).toBe('');
    expect(proxyLocationLabel(null)).toBe('');
  });
});
