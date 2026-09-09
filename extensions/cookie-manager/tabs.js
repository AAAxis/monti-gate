// The panel's tab strip: which of Cookies / Session / Automations is on screen.
//
// Its own file for the same reason cookie-format.js and sync-status.js are next
// door: this extension is loaded raw by Chrome with no build step, so a module
// here can import nothing and has to publish onto the global. Loaded via
// <script src> in sidepanel.html; the CJS branch exists only for the test.
//
// Unlike those two, this one touches the DOM, and this repo's vitest runs in
// plain node with no jsdom (see vite.config.ts, which says so deliberately). So
// the part with a history of being got wrong -- the arrow-key wrapping -- is
// split out as arithmetic a plain node test can reach, and create() does nothing
// at load: sidepanel.js calls it, the same way it calls classifySync().
(function(root) {
  'use strict';

  // The ARIA tabs keyboard contract, wrapping at both ends.
  //
  // `count` is the number of tabs ON SCREEN, not the number declared. A launch
  // with no automations hides that tab, and it must not survive as an invisible
  // stop between Session and the wrap back to Cookies.
  //
  // Everything else returns -1, which is what leaves Escape to the export-menu
  // and save-as-form handlers in sidepanel.js that already own it.
  function nextIndex(key, current, count) {
    if (!count) return -1;
    if (key === 'ArrowRight') return (current + 1) % count;
    // `+ count` before the modulo, not after: without it ArrowLeft at index 0
    // returns -1, which every caller here reads as "no move", and the strip
    // silently stops going left at the first tab.
    if (key === 'ArrowLeft') return (current - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return -1;
  }

  // Only a problem gets a mark. A dot on every healthy tab is decoration, and
  // 'off' -- nothing launched, or nothing synced yet -- is an absence of signal
  // rather than a fault, which is exactly the distinction sidepanel.css already
  // makes by leaving .card.tone-off neutral.
  //
  // The wording lives here beside the tones it pairs with, so the accessible
  // name and the colour can never say different things.
  const MARKED = {bad: 'needs attention', warn: 'needs a look'};

  function create(options) {
    const strip = options.strip;
    const doc = strip.ownerDocument;

    // One record per tab, resolved once from the markup's own aria-controls. A
    // tab and its panel are hidden and shown together and cannot drift apart,
    // which is the failure a class on the panel plus an attribute on the tab
    // would eventually produce.
    const entries = [...strip.querySelectorAll('[role="tab"]')].map((tab) => ({
      tab,
      name: tab.dataset.tab,
      panel: doc.getElementById(tab.getAttribute('aria-controls')),
      label: tab.querySelector('.tab-label').textContent,
    }));

    // Where the reader was in each panel. Shared scroll is not merely rude here:
    // the panels have very different heights, so switching to a short one clamps
    // scrollTop toward zero and destroys the value -- you lose your place either
    // way, and this way you at least get it back.
    const scrolls = new Map();

    // DOM order is tab order is default order. Cookies is first in all three.
    let selected = entries[0];

    const onScreen = () => entries.filter((entry) => !entry.tab.hidden);

    function paint(previous) {
      // Read before anything is hidden. Afterwards the document has already
      // shrunk to the incoming panel's height and the browser has clamped this
      // value, so capturing it later stores a number that is not where the
      // reader was.
      const leaving = previous && previous !== selected ?
        doc.scrollingElement.scrollTop : null;

      for (const entry of entries) {
        const on = entry === selected;
        entry.tab.setAttribute('aria-selected', String(on));
        // Roving tabindex: the whole strip is one stop in the tab order, and the
        // arrow keys move within it.
        entry.tab.tabIndex = on ? 0 : -1;
        // `hidden`, not a class. sidepanel.css's `.section:not([hidden])` idiom
        // already makes the UA's [hidden]{display:none} win, so this needs no
        // CSS of its own -- and the panel stays in the DOM, which it must: every
        // render function writes into all three on every refresh(), and an open
        // save-as form or an expanded launcher list has to survive a trip to
        // another tab.
        entry.panel.hidden = !on;
      }

      if (leaving !== null) {
        scrolls.set(previous.name, leaving);
        // The assignment forces the layout flush, so the incoming panel has its
        // height by the time this lands.
        doc.scrollingElement.scrollTop = scrolls.get(selected.name) || 0;
      }
    }

    function select(name, focus) {
      const next = entries.find((entry) => entry.name === name);
      if (!next || next.tab.hidden || next === selected) return;
      const previous = selected;
      selected = next;
      paint(previous);
      if (focus) selected.tab.focus();
    }

    strip.addEventListener('click', (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) select(tab.dataset.tab, true);
    });

    strip.addEventListener('keydown', (event) => {
      const visible = onScreen();
      const at = visible.findIndex((entry) => entry.tab === event.target);
      if (at === -1) return;
      const to = nextIndex(event.key, at, visible.length);
      if (to === -1) return;
      // Home and End would otherwise scroll the panel out from under the strip.
      event.preventDefault();
      select(visible[to].name, true);
    });

    // The markup already states the opening position; this only makes this
    // controller's model and the document agree before the first event.
    paint(null);

    return {
      // Called by renderAutomations once the launch snapshot says whether this
      // profile has any. Hiding the tab and hiding its panel are one act now,
      // which is why the section stopped setting its own `hidden`.
      setAvailable(name, available) {
        const entry = entries.find((item) => item.name === name);
        if (!entry || entry.tab.hidden === !available) return;
        entry.tab.hidden = !available;
        if (!available && selected === entry) {
          // A tab cannot be selected and absent at once. Back to the first tab
          // still on screen -- Cookies, which is never hidden -- rather than to
          // whatever came before: the only way to reach this is the launch
          // snapshot arriving milliseconds after open, before anyone has had
          // time to choose anything.
          const previous = selected;
          selected = onScreen()[0] || entries[0];
          paint(previous);
        } else {
          paint(null);
        }
      },

      // The tone the card inside the panel already computed, passed straight
      // through. The tone logic stays where it is -- classifySync's branch
      // ordering has its own test file because it has been wrong twice, and a
      // second copy of it here would be a third chance. Only the decision about
      // which tones are worth a dot lives here, in one place rather than at each
      // call site.
      setTone(name, tone) {
        const entry = entries.find((item) => item.name === name);
        if (!entry) return;
        if (MARKED[tone]) {
          entry.tab.dataset.tone = tone;
          // Colour alone is not a signal. The visible label stays the prefix of
          // the accessible name, so a screen reader hears an addition rather
          // than a rename.
          entry.tab.setAttribute('aria-label', `${entry.label} — ${MARKED[tone]}`);
        } else {
          delete entry.tab.dataset.tone;
          entry.tab.removeAttribute('aria-label');
        }
      },
    };
  }

  const api = {create, nextIndex};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ScoutTabs = api;
  }
})(globalThis);
