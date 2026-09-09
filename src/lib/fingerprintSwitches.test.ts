import {describe, expect, it} from 'vitest';
import {buildRuntimeFingerprint, fingerprintSwitches} from './fingerprint';
import type {ScoutProfile} from '../types';

function profile(fingerprint: ScoutProfile['fingerprint']): ScoutProfile {
  return {id: 'p1', name: 'Test', fingerprint} as ScoutProfile;
}

describe('fingerprintSwitches', () => {
  // The bug this guards, observed on a live browser: the profile was launched
  // with a literal `--lang=Auto from proxy`. The sentinel is a UI label meaning
  // "resolve this from the proxy's country", and main.cjs does resolve it -- but
  // only when no --lang is already present, so emitting the label here both fed
  // the browser a non-locale and suppressed the correct switch.
  it('does not emit --lang for the Auto from proxy sentinel', () => {
    expect(fingerprintSwitches(profile({language: 'Auto from proxy'}))).toBe('');
  });

  it('emits --lang for a real locale, keeping only the first', () => {
    expect(fingerprintSwitches(profile({language: 'en-US,en'}))).toBe('--lang=en-US');
  });

  // Chromium's --window-size parses "w,h"; the stored screen string is "WxH", so
  // passing it through verbatim meant the switch was silently ignored and the
  // window opened at the default size.
  it('converts the screen string to the comma form --window-size expects', () => {
    expect(fingerprintSwitches(profile({screen: '412x915'}))).toBe('--window-size=412,915');
  });

  it('accepts the × spelling the screen presets use', () => {
    expect(fingerprintSwitches(profile({screen: '1512 × 982'}))).toBe('--window-size=1512,982');
  });

  it('omits --window-size for Auto and for anything it cannot parse', () => {
    expect(fingerprintSwitches(profile({screen: 'Auto'}))).toBe('');
    expect(fingerprintSwitches(profile({screen: 'not a size'}))).toBe('');
  });

  it('passes an explicit user agent through', () => {
    expect(fingerprintSwitches(profile({user_agent: 'Mozilla/5.0 (X11; Linux x86_64)'})))
        .toBe('--user-agent=Mozilla/5.0 (X11; Linux x86_64)');
  });

  // The browser namespace is `scout`; this switch was spelled `scout` and no
  // C++ ever read it. Removed rather than corrected -- nothing consumes the OS
  // hint, which the fingerprint JSON already carries as `preset`.
  it('no longer emits the dead fingerprint-os switch', () => {
    expect(fingerprintSwitches(profile({os: 'Android'}))).toBe('');
  });

  it('is empty for a profile with no fingerprint', () => {
    expect(fingerprintSwitches({id: 'p1', name: 'Test'} as ScoutProfile)).toBe('');
  });
});

// The Windows 11 / Windows 10 split, which is invisible everywhere except this
// one client hint.
//
// The bug, seen on a live profile: the editor said "Windows 11" and
// deviceinfo.me said "Windows 10 version 10.0". Both Windows choices collapse
// to preset 'windows' (correctly -- they share a UA string, because Microsoft
// froze it at "Windows NT 10.0"), and the browser then hardcoded
// Sec-CH-UA-Platform-Version to "10.0.0" for the preset. So every Windows
// profile, whatever the user picked, reported Windows 10 to anything reading
// UA-CH.
describe('buildRuntimeFingerprint platform_version', () => {
  const fp = (os: string) => buildRuntimeFingerprint(profile({os}) as ScoutProfile);

  it('separates Windows 11 from Windows 10 on the one field that can', () => {
    // Chromium's own mapping: Windows 11 is >= 13, Windows 10 is <= 10.
    expect(fp('Windows 11').platform_version).toBe('15.0.0');
    expect(fp('Windows 10').platform_version).toBe('10.0.0');
  });

  it('still sends both as the same preset and the same UA string', () => {
    // If these ever diverge the spoof is broken in the other direction: a real
    // Windows 11 Chrome sends the Windows 10 UA string too, and "fixing" the UA
    // to say NT 11.0 would be a tell of its own.
    expect(fp('Windows 11').preset).toBe('windows');
    expect(fp('Windows 10').preset).toBe('windows');
    expect(fp('Windows 11').ua_string).toBe(fp('Windows 10').ua_string);
    expect(fp('Windows 11').ua_string).toContain('Windows NT 10.0');
  });

  it('leaves the browser on its preset default where we know nothing extra', () => {
    // Mobile presets have no desktop platform version to claim, and inventing
    // one would be worse than the browser's own default.
    expect(fp('Android').platform_version).toBeUndefined();
    expect(fp('iOS').platform_version).toBeUndefined();
  });
});
