// The artwork every .icns in assets/icons is rasterized from, as SVG strings.
//
// Kept apart from build-icons.cjs so the drawing can be reasoned about (and
// previewed in a browser) without an Electron process in the way, and apart
// from electron/profile-icons.cjs so the launch path never carries a
// rasterizer it doesn't use. The palette itself lives in profile-icons.cjs,
// because the runtime has to agree with the build about which six keys exist.
const fs = require('node:fs');
const path = require('node:path');

const {PROFILE_HUES} = require('../electron/profile-icons.cjs');

const CANVAS = 1024;

// macOS 11+ draws every app icon inside the same rounded square, and an icon
// that ignores it looks either oversized or unmoored next to its neighbours in
// the Dock. 824/1024 with a 185 radius is the published grid.
const TILE = {inset: 100, size: 824, radius: 185};

const CENTER = CANVAS / 2;

// Proportions taken from the browser mark this replaces, so the silhouette
// still reads as "a browser" at a glance: the gap ring sits at half the outer
// radius, the hub a little under two fifths of it.
const RING = {outer: 300, inner: 158, hub: 112};

// Three segments, 120 degrees apart, each pulled in by GAP_DEGREES at both
// ends so the tile shows through as a seam. -150 puts a seam at the top-left
// and a full segment across the top, which is the orientation the shape is
// recognised in.
const SEGMENT_STARTS = [-150, -30, 90];
const SEGMENT_SPAN = 120;
const GAP_DEGREES = 3.5;

// One entry per theme. `tileLight` tints the tile with the profile's own hue
// instead of leaving it neutral -- six near-white tiles differing only in a
// small ring are not tellable apart at 32px, which is the size that matters.
// `segments` runs lightest first so the shape reads as lit from above.
const THEMES = {
  light: {
    tileLight: 92,
    segments: [52, 40, 30],
    hub: 26,
    neutralTile: '#f5f2f0',
    neutralInk: '#1a1a19',
  },
  dark: {
    tileLight: 12,
    segments: [64, 52, 42],
    hub: 38,
    neutralTile: '#171615',
    neutralInk: '#f7f5f2',
  },
};

const THEME_KEYS = Object.keys(THEMES);

// Every icon this module can draw, as the names build-icons.cjs writes and
// electron/profile-icons.cjs looks up. Kept as one list so the two sides can
// never disagree about what exists.
function iconSpecs() {
  const specs = [];
  for (const theme of THEME_KEYS) {
    specs.push({name: `launcher-${theme}`, svg: () => launcherSvg(theme)});
    for (const key of Object.keys(PROFILE_HUES)) {
      specs.push({name: `profile-${key}-${theme}`, svg: () => profileSvg(key, theme)});
    }
  }
  return specs;
}

function profileSvg(key, themeKey) {
  const {hue, sat} = PROFILE_HUES[key];
  const theme = THEMES[themeKey];
  const tile = hslToHex(hue, sat, theme.tileLight);
  const segments = theme.segments
      .map((light, index) => segmentPath(SEGMENT_STARTS[index], hslToHex(hue, sat, light)))
      .join('\n  ');
  return wrap(`
  ${tileRect(tile)}
  ${segments}
  <circle cx="${CENTER}" cy="${CENTER}" r="${RING.hub}" fill="${hslToHex(hue, sat, theme.hub)}"/>
`);
}

// Deliberately not a ring: the launcher is one window among N browser windows,
// and a solid silhouette on a neutral tile is distinguishable from six ringed
// tiles at any size, including the 16px Finder list where a hue is not.
function launcherSvg(themeKey) {
  const theme = THEMES[themeKey];
  // A mountain-range silhouette: a solid mark that stays legible at 16px, the
  // same reason the previous mark was a single silhouette rather than a ring.
  // No tile behind it -- the launcher icon sits on a transparent background,
  // so only the mountain shows.
  return wrap(`
  <path d="M200 704 L392 470 L458 552 L512 398 L566 552 L632 470 L824 704 Z" fill="${theme.neutralInk}"/>
`);
}

function wrap(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" ` +
    `viewBox="0 0 ${CANVAS} ${CANVAS}">${body}</svg>`;
}

function tileRect(fill) {
  return `<rect x="${TILE.inset}" y="${TILE.inset}" width="${TILE.size}" height="${TILE.size}" ` +
    `rx="${TILE.radius}" ry="${TILE.radius}" fill="${fill}"/>`;
}

// One segment of the ring, as an annulus sector: out along the outer radius,
// in, back along the inner radius, close. Both arcs are under 180 degrees, so
// the large-arc flag is 0 throughout and only the sweep differs.
function segmentPath(startDegrees, fill) {
  const from = startDegrees + GAP_DEGREES;
  const to = startDegrees + SEGMENT_SPAN - GAP_DEGREES;
  const o1 = polar(RING.outer, from);
  const o2 = polar(RING.outer, to);
  const i2 = polar(RING.inner, to);
  const i1 = polar(RING.inner, from);
  const d = [
    `M ${o1.x} ${o1.y}`,
    `A ${RING.outer} ${RING.outer} 0 0 1 ${o2.x} ${o2.y}`,
    `L ${i2.x} ${i2.y}`,
    `A ${RING.inner} ${RING.inner} 0 0 0 ${i1.x} ${i1.y}`,
    'Z',
  ].join(' ');
  return `<path d="${d}" fill="${fill}"/>`;
}

function polar(radius, degrees) {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: round(CENTER + radius * Math.cos(radians)),
    y: round(CENTER + radius * Math.sin(radians)),
  };
}

// assets/scout-mark.svg is the brand file as exported, so its paths carry
// fill="black" and the whole thing is wrapped in a clipPath-bound <g>. Only the
// paths are wanted here -- the clip is the export's own bounding box and would
// crop the mark once it is scaled into the tile.
function helmetPaths(fill) {
  const source = fs.readFileSync(
      path.join(__dirname, '..', 'assets', 'scout-mark.svg'), 'utf8');
  const paths = source.match(/<path\b[^>]*\/>/g);
  if (!paths || !paths.length) {
    throw new Error('assets/scout-mark.svg has no <path> elements to draw');
  }
  return paths
      .map((markup) => markup.replace(/fill="[^"]*"/g, `fill="${fill}"`))
      .join('\n    ');
}

function hslToHex(hue, sat, light) {
  const s = sat / 100;
  const l = light / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;
  const [r, g, b] = rgbTriple(hue, chroma, secondary);
  return '#' + [r, g, b]
      .map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0'))
      .join('');
}

function rgbTriple(hue, chroma, secondary) {
  const sector = Math.floor(((hue % 360) + 360) % 360 / 60);
  switch (sector) {
    case 0: return [chroma, secondary, 0];
    case 1: return [secondary, chroma, 0];
    case 2: return [0, chroma, secondary];
    case 3: return [0, secondary, chroma];
    case 4: return [secondary, 0, chroma];
    default: return [chroma, 0, secondary];
  }
}

function round(value, places = 2) {
  return Number(value.toFixed(places));
}

module.exports = {CANVAS, iconSpecs, launcherSvg, profileSvg};
