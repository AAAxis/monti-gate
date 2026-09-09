// The panel's icon set, as one table.
//
// Inline SVG only, no external assets. Every entry here is a fixed, hand-
// authored path string indexed by our own literal name -- never built from
// cookie, proxy or profile data -- so writing it via innerHTML is not the kind
// of interpolation the "never put cookie/profile values in innerHTML" rule (see
// editor.js) is about.
//
// All icons share one 24x24 / stroke=2 grammar, so a single <svg> factory can
// size any of them for its slot: 18px for the header mark, 16px for a status
// icon, 14px for a button or an inline note.
//
// Lifted out of the old popup.js when the popup became a side panel. Kept as
// its own file rather than folded into sidepanel.js: it is a vocabulary, not
// behaviour, and it is the part most likely to be read while drawing something
// new.
const ScoutIcons = (() => {
  const PATHS = {
    circle: '<circle cx="12" cy="12" r="9"/>',
    alertTriangle: '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>' +
      '<path d="M12 9v4"/><path d="M12 17h.01"/>',
    xCircle: '<circle cx="12" cy="12" r="9"/><path d="m14.5 9.5-5 5"/><path d="m9.5 9.5 5 5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    alertOctagon: '<path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86Z"/>' +
      '<path d="M12 8v4"/><path d="M12 16h.01"/>',
    pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6"/><path d="M14 9v6"/>',
    loader: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    // Export: arrow leaving the tray, upward. Import: arrow landing in the tray,
    // downward. These two were once the same drawing -- the arrowhead was
    // traversed right-to-left in one and left-to-right in the other, which is
    // not a visible difference -- so Export and Import were indistinguishable.
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    'upload-tray': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    cookie: '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/>' +
      '<path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/>' +
      '<path d="M11 17v.01"/><path d="M7 14v.01"/>',
    // The Session tab's four rows, named by what the row states rather than by
    // the drawing: where the traffic leaves, where that lands, the clock the
    // profile claims, the machine it claims to be. `clock` above is the third.
    //
    // Lucide's Globe, MapPin and Monitor, path-for-path -- the start page draws
    // the same four rows from ROW_ICONS in src/lib/homePage.ts, and two
    // hand-redrawn sets is how one surface quietly stops matching the other.
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>' +
      '<path d="M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18"/>',
    mapPin: '<path d="M20 10c0 5.5-8 12-8 12s-8-6.5-8-12a8 8 0 0 1 16 0Z"/>' +
      '<circle cx="12" cy="10" r="3"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/>' +
      '<path d="M8 21h8"/><path d="M12 17v4"/>',
    // Automations. Solid, unlike everything else here: at 14px an outlined
    // triangle is three strokes meeting at sharp corners and turns to mush.
    play: '<path d="M8 5.2v13.6l11.5-6.8z" fill="currentColor" stroke="none"/>',
    // Stop, for a run in flight. Outlined, deliberately unlike `play`: these two
    // occupy the same slot in the same row seconds apart, and a solid square
    // beside a solid triangle read as one control that had changed shape rather
    // than as start and stop. The ring is the same circle every status icon here
    // is built on, so it sits in a row with them.
    stopCircle: '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
    externalLink: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/>' +
      '<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    // Disclosure. Rotated 90deg by CSS when its section is open, rather than
    // swapping to a second glyph -- one shape that turns reads as the same
    // control in two states, two shapes read as two controls.
    chevronRight: '<path d="m9 5 7 7-7 7"/>',
  };

  // fill/stroke are set on the element rather than left to CSS: make() is called
  // for status icons too, which sit in wrappers no `.icon svg` rule matches.
  // Without them SVG's initial fill (black) paints a solid glyph instead of an
  // outline and ignores the tone colour entirely.
  function make(name, size) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = PATHS[name] || PATHS.circle;
    return svg;
  }

  // Records the name on the element so a caller that swapped an icon for a
  // spinner can put the original back without having remembered it.
  function set(container, name, size) {
    container.dataset.icon = name;
    container.replaceChildren(make(name, size));
  }

  // Every static [data-icon] placeholder in the document, sized for a button.
  function hydrate(root, size) {
    for (const element of root.querySelectorAll('[data-icon]')) {
      set(element, element.dataset.icon, size);
    }
  }

  return {make, set, hydrate};
})();
