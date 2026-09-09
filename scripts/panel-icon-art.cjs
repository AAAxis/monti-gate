// The Scout Panel's toolbar icon, as SVG strings.
//
// Separate from icon-art.cjs next door, which draws macOS app tiles: those are
// 1024px Dock icons inside Apple's rounded-square grid, and this is a 16pt
// browser toolbar button. Nothing about the two problems is the same.
//
// Two constraints shape it:
//
//   1. Chrome neither inverts nor re-tints an extension's action icon, and the
//      toolbar is near-white in the light theme and near-charcoal in the dark
//      one. One bitmap has to survive both.
//   2. The mark is drawn once, from src/assets/scout-mark.svg, and never
//      redrawn by hand. It is the product's logo; a simplified "version of it"
//      authored to survive 16px is a different logo.
//
// This used to answer (1) with a dark plate and a hairline rim, on the
// reasoning that the mark is black line art and would vanish on a dark toolbar
// if drawn on transparency. The plate solved the wrong half: it made the icon
// visible while making it the only button in the row wearing a filled tile, and
// a near-black plate on a near-charcoal toolbar reads as a hole rather than a
// control. The other bundled extensions (onlinesim-sms, foxywall) ship ordinary
// coloured logos on transparency and sit in the row correctly.
//
// A single mid-grey was tried next and rejected on the evidence: rendered at
// 16px beside real toolbar glyphs, #8a8a8a is washed out on #f2f2f2 and still
// muddy on #161616 -- weak in both places rather than right in either. The
// original comment here was correct that one bitmap cannot serve both toolbars;
// it just drew the wrong conclusion from it.
//
// So: TWO sets, and the extension picks at runtime. `on-light` is near-black
// ink for a light toolbar, `on-dark` is near-white for a dark one, and
// background.js swaps them with chrome.action.setIcon from the theme the
// launcher resolved at launch (refined by the panel's own prefers-color-scheme
// once it is opened). That is the same thing Chromium does for its own toolbar
// icons, which are vectors tinted by kColorToolbarButtonIcon -- we just have to
// do the tinting ahead of time because an extension's action icon is a bitmap.
//
// The tones are the launcher's own --accent at each end (styles.css: #1a1a1a
// light, #f0f0f0 dark), which is exactly what that token means -- ink that
// inverts with the theme. Not --plan-accent: styles.css scopes that cyan to
// four named surfaces and says in as many words that a fifth is a deliberate
// decision, not a reach for the nearest token. A toolbar glyph is not it.
//
// Superseded, deliberately: the fork carries chrome/app/vector_icons/
// scout_logo.icon, a 16dp vector with no baked colour that the toolbar tints
// with kColorToolbarButtonIcon like every other side-panel icon. Once the
// native Scout Assistant button ships, THAT is the icon users see and this one
// only matters to installs still on an older browser build.
const fs = require('node:fs');
const path = require('node:path');

// Literals rather than var(), because this is rasterized standalone with no
// cascade to read tokens from -- the same reason sidepanel.css carries its own
// copy of the palette. Keyed by the toolbar they sit ON, not by the ink they
// are drawn in: "on-dark" is the light-inked file, and naming it for the ink
// is how you end up shipping them swapped.
const VARIANTS = {
  'on-light': '#1a1a1a',
  'on-dark': '#f0f0f0',
};

// The canonical mark's inner drawing, lifted out of its <svg> wrapper so it can
// be re-wrapped at another size. The embeddable cut in src/assets is the right
// one to read: it paints with currentColor (so `color` below tints it) and its
// clipPath id is namespaced, which matters the moment two of these end up in
// one document. See src/assets/README.md before swapping the file.
function markInner() {
  const source = fs.readFileSync(path.join(__dirname, '../src/assets/scout-mark.svg'), 'utf8');
  const open = source.indexOf('>', source.indexOf('<svg')) + 1;
  const close = source.lastIndexOf('</svg>');
  return source.slice(open, close);
}

// The mark's own viewBox, from that file. Taller than it is wide, so the canvas
// centres it on width and lets height decide the scale.
const MARK_BOX = {width: 874, height: 1124};

// One entry per size Chrome asks for: 16 and 32 are the toolbar at 1x and 2x,
// 48 is chrome://extensions, 128 is the install dialog.
//
// `pad` is the share of the canvas left empty around the mark. With the plate
// gone these are much smaller than they were -- padding inside a plate is
// margin the eye reads as part of the button, but padding on transparency is
// just a smaller glyph than its neighbours. The larger sizes keep a little more
// because they are shown in lists beside other extensions' icons, which are
// themselves inset.
const SIZES = [
  {size: 16, pad: 0.02},
  {size: 32, pad: 0.03},
  {size: 48, pad: 0.06},
  {size: 128, pad: 0.10},
];

// One spec per (variant, size). `dir` is the subdirectory under icons/ the file
// belongs in, so the builder never has to know what the variants are called.
function iconSpecs() {
  const inner = markInner();
  const specs = [];
  for (const [dir, color] of Object.entries(VARIANTS)) {
    for (const {size, pad} of SIZES) {
      specs.push({
        dir,
        size,
        svg: () => {
          const room = size * (1 - pad * 2);
          const scale = room / MARK_BOX.height;
          const markWidth = MARK_BOX.width * scale;
          const left = (size - markWidth) / 2;
          const top = size * pad;
          return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
            `viewBox="0 0 ${size} ${size}">` +
            `<g transform="translate(${left.toFixed(2)} ${top.toFixed(2)}) ` +
            `scale(${scale.toFixed(5)})" color="${color}">${inner}</g>` +
            '</svg>';
        },
      });
    }
  }
  return specs;
}

module.exports = {VARIANTS, SIZES, iconSpecs};
