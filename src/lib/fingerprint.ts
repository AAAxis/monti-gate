// Translates a profile's stored fingerprint (the vocabulary the editor uses)
// into what the browser actually consumes: monti::Fingerprint's JSON dict and
// the handful of command-line switches that sit outside it.
import {AUTO_FROM_PROXY, portsToProtect} from './fingerprintPresets';
import {randomSeed, stableSeedFor} from './random';
import {numberOrNull} from './text';
import type {ScoutProfile, RuntimeFingerprint} from '../types';

// Maps the profile-edit UI's os preset to monti::Fingerprint's `preset` and
// `platform` keys. Desktop presets use Chromium's UA-CH override path; mobile
// choices pass explicit UA/platform values through the runtime fingerprint.
function fingerprintPresetFor(os?: string): string | undefined {
  if (!os) {
    return undefined;
  }
  if (os.startsWith('Windows')) {
    return 'windows';
  }
  if (os === 'macOS') {
    return 'macos';
  }
  if (os === 'Ubuntu') {
    return 'linux';
  }
  if (os === 'Android') {
    return 'android';
  }
  if (os === 'iOS') {
    return 'ios';
  }
  return undefined;
}

// Sec-CH-UA-Platform-Version for the chosen OS.
//
// This is the field that decides Windows 10 vs Windows 11, and it is carried
// separately from `preset` because the two are the same preset in every other
// respect: Microsoft froze the User-Agent string at "Windows NT 10.0" for both,
// so the UA is identical and this hint is the ONLY difference. Both Windows
// choices collapse to preset 'windows' above, and until this existed every
// Windows profile reported platform version 10.0.0 -- so a profile the user
// built as "Windows 11" was read as Windows 10 by anything looking at UA-CH,
// which is exactly what deviceinfo.me shows.
//
// The numbers are Chromium's own mapping (see GetPlatformVersion in
// components/embedder_support/user_agent_utils.cc): Windows 11 reports 13.0.0
// or higher, Windows 10 reports 10.0.0 or lower. 15.0.0 corresponds to a
// current Windows 11 build; 10.0.0 to Windows 10 22H2.
//
// Returning undefined (mobile, or an unknown OS) leaves the browser on the
// preset's default, which is the honest answer when we have nothing to add.
function platformVersionFor(os?: string): string | undefined {
  if (os === 'Windows 11') {
    return '15.0.0';
  }
  if (os === 'Windows 10') {
    return '10.0.0';
  }
  if (os === 'macOS') {
    // Matches the "Macintosh; Intel Mac OS X 10_15_7" the preset sends: since
    // macOS 11, Chrome freezes the UA string at 10_15_7 and reports the real
    // version only here, the same split Windows has.
    return '15.0.0';
  }
  return undefined;
}

function fingerprintPlatformFor(preset?: string, os?: string): string | undefined {
  if (os === 'Android') {
    return 'Linux armv8l';
  }
  if (os === 'iOS') {
    return 'iPhone';
  }
  if (preset === 'windows') {
    return 'Win32';
  }
  if (preset === 'macos') {
    return 'MacIntel';
  }
  if (preset === 'linux') {
    return 'Linux x86_64';
  }
  return undefined;
}

// iOS/CriOS has no "Chrome NNN" version concept -- it's WebKit-based, not
// Blink, so the same browserVersionPresets dropdown maps onto real iOS/
// Safari point releases instead of a Chrome major version. Previously this
// was silently ignored entirely (the iOS UA string was one hardcoded
// literal), so picking a different "Browser version" had zero effect on an
// iOS profile -- unlike Android/desktop, where it visibly changes the UA.
const iosVersionForBrowserPreset: Record<string, {ios: string; webkit: string}> = {
  'Chrome 126': {ios: '17_5', webkit: '605.1.15'},
  'Chrome 125': {ios: '17_4_1', webkit: '605.1.15'},
  'Chrome 124': {ios: '17_3_1', webkit: '605.1.15'},
};

export function userAgentForFingerprint(os?: string, browserVersion?: string): string {
  const chromeVersion = browserVersion === 'Auto' || !browserVersion ?
    '149.0.0.0' :
    browserVersion.replace('Chrome ', '') + '.0.0.0';
  switch (os) {
    case 'Android':
      return `Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`;
    case 'iOS': {
      const {ios, webkit} = iosVersionForBrowserPreset[browserVersion || ''] || {ios: '17_5', webkit: '605.1.15'};
      const dotted = ios.replace(/_/g, '.');
      return `Mozilla/5.0 (iPhone; CPU iPhone OS ${ios} like Mac OS X) AppleWebKit/${webkit} (KHTML, like Gecko) Version/${dotted} Mobile/15E148 Safari/604.1`;
    }
    case 'macOS':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    case 'Ubuntu':
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    default:
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
}

// UI webrtc preset -> monti::Fingerprint.webrtc_mode ("real"|"noise"|"off").
// "Proxy only" and "Custom" both resolve to "noise", which is what makes
// MontiManager::OnBrowserCreated disable non-proxied UDP -- there's no UI
// concept mapping onto a literal "manual" WebRTC mode today.
function fingerprintWebrtcModeFor(value?: string): string | undefined {
  switch (value) {
    case 'Real':
      return 'real';
    case 'Disabled':
      return 'off';
    case 'Proxy only':
    case 'Custom':
      return 'noise';
    default:
      return undefined;
  }
}

// UI canvas/webgl noise preset -> monti::Fingerprint's canvas_mode/webgl_mode
// ("real"|"noise"|"off"). "Block" maps to "off" (the closest the browser's
// spoof-mode vocabulary has to fully suppressing the surface).
function fingerprintNoiseModeFor(value?: string): string | undefined {
  switch (value) {
    case 'Real':
      return 'real';
    case 'Noise':
      return 'noise';
    case 'Block':
      return 'off';
    default:
      return undefined;
  }
}

// UI geolocation preset -> monti::Fingerprint.geolocation_mode
// ("real"|"off"|"manual"). "manual" needs latitude/longitude, which
// electron/main.cjs fills in from the assigned proxy's country (reusing its
// existing COUNTRY_DEFAULTS resolution) if this profile didn't set explicit
// coordinates elsewhere.
function fingerprintGeolocationModeFor(value?: string): string | undefined {
  switch (value) {
    case 'Ask':
      return 'real';
    case 'Block':
      return 'off';
    case 'Auto from proxy':
      return 'manual';
    default:
      return undefined;
  }
}

// The few fingerprint fields that reach the browser as plain switches rather
// than through the runtime fingerprint dict.
export function fingerprintSwitches(profile: ScoutProfile) {
  const fingerprint = profile.fingerprint;
  if (!fingerprint) {
    return '';
  }
  const switches = [];
  if (fingerprint.user_agent) {
    switches.push(`--user-agent=${fingerprint.user_agent}`);
  }
  // The AUTO_FROM_PROXY sentinel is a UI label, not a locale. Emitting it gave
  // the browser a literal `--lang=Auto from proxy`, and because main.cjs skips
  // its own proxy-derived --lang whenever one is already present, the garbage
  // switch also suppressed the correct one. Same guard buildRuntimeFingerprint
  // already applies to explicitLanguages below.
  if (fingerprint.language && fingerprint.language !== AUTO_FROM_PROXY) {
    switches.push(`--lang=${fingerprint.language.split(',')[0]}`);
  }
  // Chromium's --window-size takes "w,h"; the stored screen string is "WxH",
  // so passing it through verbatim was silently ignored.
  if (fingerprint.screen && fingerprint.screen !== 'Auto') {
    const size = fingerprint.screen.match(/^\s*(\d+)\s*[×x]\s*(\d+)/);
    if (size) {
      switches.push(`--window-size=${size[1]},${size[2]}`);
    }
  }
  return switches.join('\n');
}

// Builds the full fingerprint payload the browser applies, keyed exactly like
// monti::Fingerprint's JSON dict (see chrome/browser/monti/monti_fingerprint.cc
// ToDict/FromDict). Fields the browser should resolve from the assigned
// proxy's country (timezone/languages when left on "Auto from proxy", and
// latitude/longitude for "manual" geolocation) are left undefined here --
// electron/main.cjs fills those in immediately before serializing, reusing
// its existing COUNTRY_DEFAULTS-based resolution so that logic isn't
// duplicated between the renderer and the main process.
export function buildRuntimeFingerprint(profile: ScoutProfile): RuntimeFingerprint {
  const fingerprint = profile.fingerprint || {};
  const preset = fingerprintPresetFor(fingerprint.os);
  const explicitTimezone = fingerprint.timezone && fingerprint.timezone !== AUTO_FROM_PROXY ?
    fingerprint.timezone :
    undefined;
  const explicitLanguages = fingerprint.language && fingerprint.language !== AUTO_FROM_PROXY ?
    fingerprint.language.split(',').map((part) => part.split(';')[0].trim()).filter(Boolean) :
    undefined;
  const rotate = Boolean(fingerprint.rotate_on_launch);
  const seed = rotate ? randomSeed() : stableSeedFor(profile.id);
  // Mirrors Generate()'s own platform-derived defaults in monti_fingerprint.cc
  // -- touch/sensor/battery aren't separate user-facing fields, they follow
  // directly from which platform (desktop vs mobile) is selected above, same
  // as webrtc_mode/canvas_mode etc already do.
  const isMobile = preset === 'android' || preset === 'ios';
  const kBatteryLevels = [23, 41, 58, 67, 82, 94];
  return {
    platform: fingerprintPlatformFor(preset, fingerprint.os),
    ua_string: fingerprint.user_agent || userAgentForFingerprint(fingerprint.os, fingerprint.browser_version),
    preset,
    platform_version: platformVersionFor(fingerprint.os),
    seed,
    touch_points: isMobile ? 5 : 0,
    sensor_mode: isMobile ? 'idle-realistic' : 'off',
    battery_spoof: isMobile,
    battery_level: isMobile ? kBatteryLevels[seed % kBatteryLevels.length] / 100 : undefined,
    battery_charging: isMobile ? seed % 4 === 0 : undefined,
    webrtc_mode: fingerprintWebrtcModeFor(fingerprint.webrtc),
    canvas_mode: fingerprintNoiseModeFor(fingerprint.canvas),
    webgl_mode: fingerprintNoiseModeFor(fingerprint.webgl),
    webgpu_mode: fingerprintNoiseModeFor(fingerprint.webgpu),
    client_rects_mode: fingerprintNoiseModeFor(fingerprint.client_rects),
    audio_mode: fingerprintNoiseModeFor(fingerprint.audio),
    webgl_vendor: fingerprint.webgl_vendor || undefined,
    webgl_renderer: fingerprint.webgl_renderer || undefined,
    timezone: explicitTimezone,
    languages: explicitLanguages,
    geolocation_mode: fingerprintGeolocationModeFor(fingerprint.geolocation),
    cpu_cores: numberOrNull(String(fingerprint.cpu_cores ?? '')) || undefined,
    memory_gb: numberOrNull(String(fingerprint.memory_gb ?? '')) || undefined,
    screen: fingerprint.screen && fingerprint.screen !== 'Auto' ? fingerprint.screen : undefined,
    media_devices: fingerprint.media_devices || undefined,
    ports_to_protect: portsToProtect,
    do_not_track: Boolean(fingerprint.do_not_track),
    rotate_on_launch: rotate,
  };
}
