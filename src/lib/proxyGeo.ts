// What timezone a proxy implies, and whether a profile's chosen one contradicts it.
//
// The launch path resolves this independently in electron/main.cjs -- it has to,
// because it runs a fresh proxy check and must not depend on the renderer being
// open. This module is the UI half: it answers the same question from the stored
// proxy row so the profile editor can warn before a mismatched profile is ever
// launched. Both read country-defaults.json, so there is one table, not two.
import countryDefaults from '../../electron/country-defaults.json';
import {AUTO_FROM_PROXY} from './fingerprintPresets';
import type {ScoutProxy} from '../types';

type CountryDefault = {timezone: string; language: string; latitude: number; longitude: number};
const DEFAULTS = countryDefaults as Record<string, CountryDefault>;

// The timezone a proxy's exit location implies: what the last check measured
// from the egress IP, else the country's default zone, else nothing.
//
// Returning null is a real answer -- an unchecked proxy, or one in a country the
// table does not cover, genuinely does not imply a timezone, and claiming one
// would be worse than saying so.
export function expectedTimezoneFor(proxy: ScoutProxy | null | undefined): string | null {
  if (!proxy) {
    return null;
  }
  if (proxy.timezone) {
    return proxy.timezone;
  }
  const code = (proxy.country_code || '').toLowerCase();
  return DEFAULTS[code]?.timezone || null;
}

// The proxy's location as a person would say it: "New York, United States".
export function proxyLocationLabel(proxy: ScoutProxy | null | undefined): string {
  if (!proxy) {
    return '';
  }
  return [proxy.city, proxy.region, proxy.country || proxy.country_code]
      .filter(Boolean)
      .filter((part, index, parts) => parts.indexOf(part) === index)
      .join(', ');
}

// The current UTC offset of an IANA zone, in minutes, or null if ICU does not
// recognise it. Used instead of comparing zone names because names are not the
// thing sites check -- a proxy reported as America/Detroit and a profile set to
// America/New_York are the same clock, and warning about that would train people
// to dismiss the warning that matters.
export function utcOffsetMinutes(timezone: string, at: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const field: Record<string, string> = {};
    for (const part of parts) {
      field[part.type] = part.value;
    }
    const asUtc = Date.UTC(
        Number(field.year), Number(field.month) - 1, Number(field.day),
        Number(field.hour) % 24, Number(field.minute), Number(field.second));
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return null;
  }
}

export type TimezoneMismatch = {chosen: string; expected: string; proxyLabel: string};

// Whether an explicitly chosen timezone contradicts the proxy it will launch
// behind. Null means "nothing to warn about", which covers the cases where a
// mismatch cannot honestly be asserted: the profile is on Auto, there is no
// proxy, the proxy has no known location, or either zone is unparseable.
export function timezoneMismatch(
    chosen: string | null | undefined,
    proxy: ScoutProxy | null | undefined): TimezoneMismatch | null {
  if (!chosen || chosen === AUTO_FROM_PROXY || !proxy) {
    return null;
  }
  const expected = expectedTimezoneFor(proxy);
  if (!expected || expected === chosen) {
    return null;
  }
  const chosenOffset = utcOffsetMinutes(chosen);
  const expectedOffset = utcOffsetMinutes(expected);
  if (chosenOffset === null || expectedOffset === null || chosenOffset === expectedOffset) {
    return null;
  }
  return {
    chosen,
    expected,
    proxyLabel: proxyLocationLabel(proxy) || `${proxy.host}:${proxy.port}`,
  };
}
