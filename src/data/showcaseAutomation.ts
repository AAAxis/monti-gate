// The worked example behind the Automations tab's "Load the example" button.
//
// A new org lands on an empty Automations tab, and an empty tab is a poor
// argument for a feature someone is being asked to pay for. This is the one
// workflow that arrives pre-written: open Google, type a query as real
// keystrokes, branch on what came back, and end on our own site with a
// screenshot in the run log. It exercises goto/waitFor/type/if/extract/click/
// screenshot in about fifteen seconds.
//
// It is an ORDINARY automation. Nothing reads it at runtime, nothing keys off
// its name, and no code path anywhere asks "is this the example?". Once
// inserted it is a row like any other -- editable, renameable, deletable. Its
// only privilege is arriving pre-written, which is why it lives in src/data
// beside the other seed data rather than in the runner or the editor.
//
// No `id`. The caller mints one with newId() at insert (see
// useAutomationActions.exampleAutomation), because an automation's id becomes a
// directory name for its run artifacts under <userData>/AutomationRuns/ and has
// to satisfy automations_id_fs_safe. A constant baked in here would also mean
// every org shared one id, and loading the example twice would collide on the
// primary key instead of producing two independent rows.
import type {MontiAutomation} from '../types';

export const SHOWCASE_AUTOMATION: Omit<MontiAutomation, 'id'> = {
  name: 'Search Google for Scout Web',
  description: 'Opens Google, searches for us, and ends on montigate.com with a ' +
    'screenshot. Edit it, rename it or delete it — it is a normal automation.',
  // Matches newAutomation(): a run that hangs on a bot check should fail on the
  // clock rather than hold the profile open indefinitely.
  timeout_ms: 300000,
  // Real now: the runner closes the browser when a run that opened it finishes
  // (see the onFinish wiring in main.cjs). Still false here, for a different
  // reason than before -- the example exists to be watched, and the last thing
  // it does is take a screenshot of a page worth looking at.
  close_on_finish: false,
  variables: {},
  pinned: false,
  steps: [
    {id: 's1', type: 'goto', url: 'https://www.google.com/', waitUntil: 'load'},

    // A profile with no cookies gets the consent interstitial on every single
    // run, and it sits on top of the search box, so typing without dismissing
    // it clicks nothing. Guarded by selectorExists rather than run
    // unconditionally because the banner is regional: an org whose profile has
    // already accepted, or whose egress IP is outside the EEA, never sees it,
    // and a bare click on an absent selector is a hard step failure.
    {
      id: 's2',
      type: 'if',
      label: 'Dismiss the cookie banner, if Google shows one',
      condition: {left: 'button#L2AGLb, button[aria-label*=\'Accept\']', op: 'selectorExists'},
      then: [
        {id: 's3', type: 'click', selector: 'button#L2AGLb, button[aria-label*=\'Accept\']'},
        {id: 's4', type: 'wait', minMs: 600, maxMs: 1200},
      ],
      else: [],
    },

    // textarea first: Google has served the query box as a <textarea> for years
    // now, but falls back to <input> on the lighter layouts it still hands to
    // some clients. One selector covering both beats two branches.
    {id: 's5', type: 'waitFor', for: 'selector', selector: 'textarea[name=q], input[name=q]'},

    // delayMs is the whole point of this step, not a nicety. Any value above
    // zero switches the runner from a single Input.insertText -- one atomic,
    // paste-shaped mutation -- to per-character Input.dispatchKeyEvent
    // (electron/automation/steps.cjs). Typing a search query by paste is
    // exactly the signal an anti-detect product must not emit, least of all in
    // its own demo.
    {
      id: 's6',
      type: 'type',
      label: 'Search for us',
      selector: 'textarea[name=q], input[name=q]',
      text: 'monti browser',
      clear: true,
      delayMs: 120,
      pressEnter: true,
    },

    {id: 's7', type: 'wait', minMs: 1200, maxMs: 2200},

    // The else branch is not a fallback nobody expects to hit -- as of writing
    // it is the branch that always runs. montigate.com is not indexed (no
    // robots.txt, no sitemap.xml, absent from results for this query), and the
    // page-one hit for "monti browser" is a different company at
    // montibrowser.com. The demo still has to end on our site rather than
    // dead-ending on a results page in front of whoever is watching, so it
    // navigates directly instead.
    //
    // Note the selector cannot match the competitor: 'montibrowser.com' does
    // not contain the substring 'montigate.com'.
    {
      id: 's8',
      type: 'if',
      label: 'Open our result, or go direct if it is not on page one',
      condition: {left: 'a[href*=\'montigate.com\']', op: 'selectorExists'},
      then: [
        {
          id: 's9',
          type: 'extract',
          selector: 'a[href*=\'montigate.com\']',
          what: 'attr',
          attr: 'href',
          into: 'foundUrl',
        },
        {id: 's10', type: 'click', selector: 'a[href*=\'montigate.com\']'},
      ],
      else: [
        {id: 's11', type: 'goto', url: 'https://www.montigate.com/', waitUntil: 'load'},
      ],
    },

    // Both branches converge here, so the run proves it arrived rather than
    // proving which path it took.
    {id: 's12', type: 'waitFor', for: 'url', url: 'montigate.com'},
    {id: 's13', type: 'screenshot', fullPage: true},
  ],
};
