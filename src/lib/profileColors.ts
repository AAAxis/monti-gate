// The colour a profile is tagged with, and how it is drawn.
//
// This used to be six raw hexes in fingerprintPresets.ts -- wrong file (a
// profile's colour has nothing to do with its fingerprint) and wrong values: a
// saturated #2563eb fill glares against warm paper in light and burns a hole in
// charcoal in dark, because one literal cannot be right in both themes.
//
// So the six presets are now *keys*, resolved to the --profile-* token triples
// in styles.css, built exactly like the --method-* verb chips on the API tab: a
// pale fill, a matching border, and an ink dark enough to read on it. Each has
// one value per theme, so a profile's colour inverts with the app.
//
// ScoutProfile.color stays a plain string and the column is untouched: it holds
// a key for the six presets, or a hex when the user picks a custom colour.
import type {CSSProperties} from 'react';

export type ProfileColorKey = 'slate' | 'blue' | 'green' | 'violet' | 'red' | 'amber';

export const PROFILE_COLORS: {key: ProfileColorKey; label: string}[] = [
  {key: 'slate', label: 'Slate'},
  {key: 'blue', label: 'Blue'},
  {key: 'green', label: 'Green'},
  {key: 'violet', label: 'Violet'},
  {key: 'red', label: 'Red'},
  {key: 'amber', label: 'Amber'},
];

// The colour a stored value falls back to when it cannot be read. Deliberately
// a constant and NOT randomProfileColor(): this is a read path, so a random
// answer would give the same profile a different colour every time anything
// asked, and the Dock tile would change under the user.
export const DEFAULT_PROFILE_COLOR: ProfileColorKey = 'blue';

// The colour a *new* profile starts with. Random rather than always blue
// because this is what its launched window's Dock tile is drawn in
// (electron/profile-icons.cjs), and a screen of profiles that all defaulted to
// blue gave every one of them the same tile -- the one thing the per-profile
// icon exists to prevent. Six colours means repeats once there are more than a
// few profiles; the colour is a hint for telling windows apart, not an id, and
// the picker is right there for anyone who wants to choose.
//
// Only ever called when a profile is created. See DEFAULT_PROFILE_COLOR above
// for why read paths must not use this.
export function randomProfileColor(): ProfileColorKey {
  return PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)].key;
}

// The palette this replaced, in its original order, so profiles saved before
// this change adopt the muted tone instead of keeping a stale literal that only
// ever looked right in one theme. Matched case-insensitively; anything else the
// user chose by hand is left alone as a custom colour.
const LEGACY_HEX_TO_KEY: Record<string, ProfileColorKey> = {
  '#171613': 'slate',
  '#2563eb': 'blue',
  '#16a34a': 'green',
  '#a855f7': 'violet',
  '#dc2626': 'red',
  '#f59e0b': 'amber',
};

const KEYS = new Set<string>(PROFILE_COLORS.map((color) => color.key));

// A stored colour as one of the six keys, or null when it is a custom hex (or
// missing). Every read path goes through this, so the legacy mapping lives in
// exactly one place.
export function resolveProfileColor(value?: string | null): ProfileColorKey | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (KEYS.has(trimmed)) {
    return trimmed as ProfileColorKey;
  }
  return LEGACY_HEX_TO_KEY[trimmed.toLowerCase()] || null;
}

// The colour a draft should carry given whatever was stored. Keeps a custom hex
// as-is; normalizes the six legacy hexes to their key; falls back to the default.
export function normalizeProfileColor(value?: string | null): string {
  const preset = resolveProfileColor(value);
  if (preset) {
    return preset;
  }
  return isCustomHex(value) ? (value as string).trim() : DEFAULT_PROFILE_COLOR;
}

export function isCustomHex(value?: string | null): boolean {
  return Boolean(value && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()));
}

// What a custom colour shows in the <input type="color">, which only accepts
// #rrggbb. A preset key has no hex of its own -- the token does -- so it opens
// on a neutral rather than on whatever the last profile happened to use.
export function customHexFor(value?: string | null): string {
  return isCustomHex(value) ? (value as string).trim() : '#6b6862';
}

// The fill/border/ink for a profile chip, avatar or swatch. Returned as a style
// object rather than a class because the six presets are data, not six CSS
// rules -- and a custom hex could never be a class at all.
export function profileColorStyle(value?: string | null): CSSProperties {
  const preset = resolveProfileColor(value);
  if (preset) {
    return {
      background: `var(--profile-${preset}-bg)`,
      borderColor: `var(--profile-${preset}-border)`,
      color: `var(--profile-${preset}-ink)`,
    };
  }
  if (isCustomHex(value)) {
    const hex = (value as string).trim();
    return {background: hex, borderColor: hex, color: readableInkOn(hex)};
  }
  return {
    background: 'var(--accent)',
    borderColor: 'var(--accent)',
    color: 'var(--accent-ink)',
  };
}

// The second sanctioned place in this app allowed to name a colour instead of
// reading a token (the first is the theme previews in AppearanceSection). The
// ink here has to contrast with a hex the *user* picked, which no token can
// know about, and it must stay the same in both themes for exactly that reason.
function readableInkOn(hex: string): string {
  const {r, g, b} = expandHex(hex);
  // Rec. 709 luma on gamma-encoded values -- close enough to WCAG relative
  // luminance for a two-way black/white decision, without the linearization.
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma > 0.6 ? '#17161a' : '#ffffff';
}

function expandHex(hex: string): {r: number; g: number; b: number} {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ?
    raw.split('').map((char) => char + char).join('') :
    raw;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}
