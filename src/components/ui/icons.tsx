import React from 'react';
import * as CountryFlagIcons from 'country-flag-icons/react/3x2';
import {Monitor, Puzzle} from 'lucide-react';
import {AndroidMark, AppleMark, UbuntuMark, WindowsMark} from './PlatformMarks';
import type {Integration} from '../../data/integrations';

// Renders a real flag SVG (bundled, so it never depends on the OS having a
// color-emoji font with flag glyphs -- Regional Indicator Symbol emoji looked
// right in theory but rendered as two boxed letters on this user's Windows
// build even with an explicit emoji font-family). Falls back to the bare
// 2-letter code as text if it's not a recognized ISO code.
export function FlagIcon({countryCode}: {countryCode?: string}) {
  const code = countryCode?.trim().toUpperCase();
  const Flag = code && /^[A-Z]{2}$/.test(code) ?
    (CountryFlagIcons as Record<string, React.FC<React.SVGProps<SVGSVGElement>>>)[code] :
    undefined;
  if (Flag) {
    return <Flag className="flag-svg" />;
  }
  return <>{code || '--'}</>;
}

// Maps a fingerprint OS preset (see osPresets) to its platform mark. Five of
// the six used to collapse into two glyphs, because lucide has no brand logos
// -- PlatformMarks.tsx supplies real ones. Two pairs share a mark on purpose
// (Windows 11/10, macOS/iOS); the label and title tell them apart. Anything
// unrecognized falls back to a dimmed <Monitor> rather than rendering nothing.
export function PlatformIcon({os, size = 16}: {os?: string; size?: number}) {
  const label = os || 'Unknown';
  const Mark = PLATFORM_MARKS[os || ''];
  if (Mark) {
    return (
      <span className="platform-mark" role="img" aria-label={label} title={label}>
        <Mark size={size} />
      </span>
    );
  }
  return <Monitor size={size} aria-label={label} opacity={0.4}><title>{label}</title></Monitor>;
}

const PLATFORM_MARKS: Record<string, ({size}: {size?: number}) => React.ReactElement> = {
  'Windows 11': WindowsMark,
  'Windows 10': WindowsMark,
  'macOS': AppleMark,
  'Ubuntu': UbuntuMark,
  'Android': AndroidMark,
  'iOS': AppleMark,
};

// The mark, and the version beside it for the one platform that stores one.
//
// Windows 11 and Windows 10 share the flag -- downstream they are the same
// `windows` preset and the same Windows NT 10.0 user agent -- so with the mark
// alone the Profiles table drew the two presets identically and the column
// could not answer the question it was there for. The number is what tells
// them apart, and it is read straight off fingerprint.os rather than derived.
//
// Nothing else carries a version. `osPresets` is exactly
// ['Windows 11', 'Windows 10', 'macOS', 'Ubuntu', 'Android', 'iOS']: there is
// no macOS 26 to show, no Ubuntu 24.04, and the frozen macOS user agent says
// 10_15_7 for every profile. So those render the mark on its own rather than a
// number this app would have had to invent -- which would be a claim about
// what the browser reports, and a false one.
export function PlatformLabel({os, size = 16}: {os?: string; size?: number}) {
  const version = os?.startsWith('Windows ') ? os.slice('Windows '.length) : '';
  return (
    <span className="platform-label">
      <PlatformIcon os={os} size={size} />
      {version && <span className="platform-version">{version}</span>}
    </span>
  );
}

// An integration's brand mark, or its Lucide stand-in when there is no asset.
// Shared by the integration cards, the connect dialog and the key list so all
// three agree on how a given tool is drawn.
export function IntegrationMark({integration, size = 20}: {integration: Integration; size?: number}) {
  const Icon = integration.icon;
  if (!integration.logo) {
    return <Icon size={size} />;
  }
  const className = integration.invertOn ?
    `integration-logo invert-on-${integration.invertOn}` :
    'integration-logo';
  return <img alt="" className={className} src={integration.logo} style={{height: size, width: size}} />;
}

// An extension's artwork: its store icon, the EasyDeck mark for the one we ship
// ourselves, or a Lucide stand-in when neither is available. Shared by the
// Installed cards and the Discover cards so an extension is drawn the same way
// before and after it is added.
//
// `tint` renders the EasyDeck mark as a CSS mask instead of an <img>, because it
// is black-on-transparent line art and would disappear on the dark theme's
// raised surface. Store icons are full-colour and stay images.
// The card's own heading carries the name, so every branch here is decorative.
export function ExtensionMark({logo, tint}: {logo?: string; tint?: boolean}) {
  if (tint) {
    return <span aria-hidden="true" className="extension-mark is-monti" />;
  }
  if (logo) {
    return <img alt="" className="extension-mark" src={logo} />;
  }
  return (
    <span aria-hidden="true" className="extension-mark is-fallback">
      <Puzzle size={20} strokeWidth={1.75} />
    </span>
  );
}

// Google's mark, inline. Lucide has no brand icons and their guidelines require
// the official four-colour G on a sign-in button.
export function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3-2.34z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.94l3 2.34C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}
