#!/usr/bin/env node
// Serves the Scout Panel against fixture data, so its layout can be looked at
// without launching a profile.
//
//   node scripts/preview-panel.mjs
//
// Prints one URL per state. Open them and drag the window to the widths a real
// side panel gets -- Chrome's floor is 320px and the user resizes from there.
//
// No Electron, no Supabase, no running launcher and no dependencies: it reads
// the extension directory and serves it, the same way verify-palette.mjs just
// reads two files. sidepanel.html, sidepanel.css, sidepanel.js and icons.js are
// served verbatim -- a harness carrying its own copy of the markup is a harness
// that stops describing the thing. Only chrome.* is replaced.
//
// What this cannot show is anything that needs the launcher on the other end:
// every action resolves to {ok: true} without going anywhere.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, extname, join, normalize, sep} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(here, '../extensions/cookie-manager');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Every state the panel has to survive. Several are easy to forget and each has
// been broken at least once: a session whose timezone contradicts its exit (the
// card must stop claiming success), a launch with no automations (which must now
// say so on a tab that is always there, rather than hiding the tab), and a window
// the launcher never touched.
//
// `session` is scout-session.json as built-in-extensions.cjs writes it;
// `status` is what background.js answers `get-status` with; `automation` is what
// it answers `automation-status` with, and its `run`/`last` are summaries as
// electron/automation/progress.cjs composes them. All three shapes are owned
// elsewhere -- if the panel stops matching them, fix the panel.
//
// The clock is the one thing a fixture cannot state: `startedAt` is filled in at
// page load, relative to now, so the elapsed line reads as a real duration
// instead of counting up from 2026.
const FIXTURES = {
  ok: {
    session: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      proxy: {
        ok: true,
        title: 'Anti-detect proxy active',
        detail: '142.252.99.144:64455 · Los Angeles, California, US · 1131 ms',
        // The common case, and the one the wording used to get wrong: a
        // profile on "Auto from proxy". The zone was DERIVED from this exit, so
        // the row states where it came from in the neutral tone. It does not
        // say "matches exit" -- that would be the panel agreeing with itself
        // and calling it a check.
        fields: [
          {label: 'Exit', value: '142.252.99.144', icon: 'globe', mono: true, note: '1131 ms'},
          {label: 'Location', value: 'Los Angeles, California, US', icon: 'mapPin',
            note: 'checked 4 min ago'},
          {label: 'Timezone', value: 'America/Los_Angeles', icon: 'clock', mono: true,
            note: 'from exit IP'},
          {label: 'Device', value: 'Windows 11 · 1920x1080', icon: 'monitor'},
        ],
      },
      recheckable: true,
      automations: [
        {id: 'a1', name: 'Warm up the feed'},
        {id: 'a2', name: 'Check the inbox and mark read'},
      ],
    },
    status: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      sync: {
        available: true, paused: false, inSync: true, reachable: true,
        pushedAt: 0, pushedCount: 148, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false, lastSet: 'Sophia Bennett 2026-08-07',
      },
      seed: {imported: true, seededAt: 0, seededCount: 64},
      counts: {total: 148, site: 12, siteDomain: 'instagram.com'},
    },
    // What the launcher holds, plus the live jar it is diffed against. The
    // interesting row is reddit.com: present in the saved set, absent from the
    // jar, so the list marks it as something a load would ADD rather than
    // replace.
    launcherCookies: {
      ok: true,
      set: 'Sophia Bennett 2026-08-07',
      count: 4,
      cookies: [
        {domain: '.instagram.com', name: 'sessionid', path: '/', expires: 1798761600},
        {domain: '.instagram.com', name: 'csrftoken', path: '/', expires: null},
        {domain: '.google.com', name: 'SID', path: '/', expires: 1806537600},
        {domain: '.reddit.com', name: 'reddit_session', path: '/', expires: 1814486400},
      ],
    },
    jar: [
      {domain: '.instagram.com', name: 'sessionid'},
      {domain: '.google.com', name: 'SID'},
    ],
    // The live workspace list, which replaces the snapshot's two rows a moment
    // after the panel opens. The point of this fixture is the sort and the
    // badges: `a1` is this profile's own, `a2` is pinned for everyone, and the
    // three below are a teammate's -- invisible from inside the browser until
    // this route existed, and the whole reason it does.
    workspaceAutomations: {
      ok: true,
      available: true,
      automations: [
        {id: 'z9', name: 'Zip through the archive', description: '', pinned: false,
          assigned: false, icon: '', color: 'violet'},
        {id: 'a2', name: 'Check the inbox and mark read', description: 'Opens each unread thread.',
          pinned: true, assigned: false, icon: '', color: 'blue'},
        {id: 'b4', name: 'Amazon order export', description: 'Rachel’s. Runs weekly.',
          pinned: false, assigned: false, icon: '', color: 'amber'},
        {id: 'a1', name: 'Warm up the feed', description: 'Scrolls, likes, waits.',
          pinned: true, assigned: true, icon: '', color: 'green'},
        {id: 'c7', name: 'Bulk-follow from a CSV', description: '', pinned: false,
          assigned: false, icon: '', color: ''},
      ],
    },
    // The library the picker offers. `set_1` is assigned; the rest are the
    // team's, and picking one of them is a one-shot load.
    cookieSets: {
      ok: true,
      available: true,
      assignedId: 'set_1',
      sets: [
        {id: 'set_1', name: 'Sophia Bennett 2026-08-07', count: 148, folder_id: null,
          tags: [], updated_at: '2026-08-07T09:12:00.000Z'},
        {id: 'set_2', name: 'Client B — Amazon', count: 214, folder_id: null,
          tags: [], updated_at: '2026-08-08T14:30:00.000Z'},
        {id: 'set_3', name: 'Rachel — LinkedIn', count: 61, folder_id: null,
          tags: [], updated_at: '2026-08-05T11:02:00.000Z'},
      ],
    },
  },

  // The state the one-shot picker creates, and the one worth looking hardest
  // at: this window is holding "Client B — Amazon", which the profile is not
  // assigned. Nothing is being saved anywhere, the card says so and names the
  // set, "Save to Launcher now" is gone, and the two ways out are in its place.
  //
  // Without the suppression this is the six-second bug: the jar holds set B,
  // the push loop is aimed at set A, and A -- the set this profile launches
  // with -- gets overwritten with B's cookies.
  loaded: {
    session: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      proxy: {
        ok: true,
        title: 'Anti-detect proxy active',
        detail: '142.252.99.144:64455 · Los Angeles, California, US · 131 ms',
        fields: [{label: 'Exit', value: '142.252.99.144', icon: 'globe', mono: true, note: '131 ms'}],
      },
      recheckable: true,
      automations: [{id: 'a1', name: 'Warm up the feed'}],
    },
    status: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      sync: {
        available: true, paused: false, inSync: false, reachable: true,
        pushedAt: 0, pushedCount: 0, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false, lastSet: 'Client B — Amazon',
        pushSuppressed: true, loadedSetId: 'set_2', loadedSetName: 'Client B — Amazon',
      },
      seed: {imported: true, seededAt: 0, seededCount: 64},
      counts: {total: 214, site: 31, siteDomain: 'amazon.com'},
    },
    cookieSets: {
      ok: true,
      available: true,
      assignedId: 'set_1',
      sets: [
        {id: 'set_1', name: 'Sophia Bennett 2026-08-07', count: 148, folder_id: null,
          tags: [], updated_at: '2026-08-07T09:12:00.000Z'},
        {id: 'set_2', name: 'Client B — Amazon', count: 214, folder_id: null,
          tags: [], updated_at: '2026-08-08T14:30:00.000Z'},
      ],
    },
    jar: [{domain: '.amazon.com', name: 'session-id'}],
  },

  // A workspace with nothing in it, on the tab that says so. The empty state
  // used to read "pin a workflow and it will appear here on the next launch",
  // which was right while this list was the launch snapshot and is wrong now --
  // reaching this screen means the workspace itself is empty.
  noworkspace: {
    session: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      proxy: {ok: true, title: 'Anti-detect proxy active', detail: '131 ms', fields: []},
      recheckable: true,
      automations: [],
    },
    status: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      sync: {
        available: true, paused: false, inSync: true, reachable: true,
        pushedAt: 0, pushedCount: 12, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false, lastSet: '',
      },
      seed: {imported: false, seededAt: 0, seededCount: 0},
      counts: {total: 12, site: 0, siteDomain: ''},
    },
    openTab: 'automations',
    workspaceAutomations: {ok: true, available: true, automations: []},
    cookieSets: {ok: true, available: true, assignedId: null, sets: []},
  },

  // The launcher answered neither list, and the panel has to say so instead of
  // painting the same empty state a genuinely empty workspace gets.
  //
  // 'Unknown message' is background.js's own reply for a message type its
  // switch does not have, which means this profile is running a service worker
  // from before these routes existed -- Chrome caches an unpacked extension's
  // worker against its directory path, so a profile that has already launched
  // can keep the old one after an upgrade. It is the likeliest reason either
  // list is empty right after a release, and until this fixture existed the
  // screen for it was indistinguishable from "your team has no workflows".
  stale: {
    session: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      proxy: {ok: true, title: 'Anti-detect proxy active', detail: '131 ms', fields: []},
      recheckable: true,
      automations: [],
    },
    status: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      sync: {
        available: true, paused: false, inSync: true, reachable: true,
        pushedAt: 0, pushedCount: 184, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false,
        lastSet: 'IG · Maraneng Jam (live).json',
      },
      seed: {imported: false, seededAt: 0, seededCount: 0},
      counts: {total: 184, site: 22, siteDomain: 'instagram.com'},
    },
    openTab: 'automations',
    workspaceAutomations: {ok: false, available: true, error: 'Unknown message'},
    cookieSets: {ok: false, available: true, error: 'Unknown message'},
  },

  // A run in flight, on the tab it belongs to. The row for the running workflow
  // has to show a spinner and refuse a second click, and the other row has to be
  // disabled too -- the runner allows one run per profile, so offering the button
  // would be offering a click that cannot succeed.
  running: {
    session: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      proxy: {
        ok: true,
        title: 'Anti-detect proxy active',
        detail: '142.252.99.144:64455 · Los Angeles, California, US · 131 ms',
        fields: [{label: 'Exit', value: '142.252.99.144', icon: 'globe', mono: true, note: '131 ms'}],
      },
      recheckable: true,
      automations: [
        {id: 'a1', name: 'Warm up the feed'},
        {id: 'a2', name: 'Check the inbox and mark read'},
      ],
    },
    status: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      sync: {
        available: true, paused: false, inSync: true, reachable: true,
        pushedAt: 0, pushedCount: 148, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false, lastSet: '',
      },
      seed: {imported: true, seededAt: 0, seededCount: 64},
      counts: {total: 148, site: 12, siteDomain: 'instagram.com'},
    },
    openTab: 'automations',
    automation: {
      ok: true,
      available: true,
      run: {
        runId: 'run_1', status: 'running', automationId: 'a1',
        automationName: 'Warm up the feed', trigger: 'panel',
        startedAtOffsetMs: -84000, finishedAt: null,
        stepCount: 3, totalSteps: 12, progress: 0.25,
        currentStep: 'Fill #password', error: null,
      },
      last: null,
    },
  },

  // The same run, with no honest position to report: a loop pushed its step count
  // past the declared total, so progressOf gave up. The bar must sweep rather than
  // fill, and the step count must be gone from the meta line rather than reading
  // "step 46 of 12".
  indeterminate: {
    session: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      proxy: {ok: true, title: 'Anti-detect proxy active', detail: '131 ms', fields: []},
      recheckable: true,
      automations: [{id: 'a1', name: 'Scrape every listing on the page'}],
    },
    status: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      sync: {
        available: true, paused: false, inSync: true, reachable: true,
        pushedAt: 0, pushedCount: 12, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false, lastSet: '',
      },
      seed: {imported: false, seededAt: 0, seededCount: 0},
      counts: {total: 12, site: 0, siteDomain: ''},
    },
    openTab: 'automations',
    automation: {
      ok: true,
      available: true,
      run: {
        runId: 'run_2', status: 'running', automationId: 'a1',
        automationName: 'Scrape every listing on the page', trigger: 'schedule',
        startedAtOffsetMs: -422000, finishedAt: null,
        stepCount: 45, totalSteps: 6, progress: null,
        currentStep: 'Read the text of .listing-title (row 38 of 40)', error: null,
      },
      last: null,
    },
  },

  // A run that failed, reported after the fact. This is the state the panel could
  // not show at all before: the launcher's live map is empty the instant a run
  // seals, so without `last` the card the user was watching simply vanished
  // without ever saying whether it worked.
  //
  // Also the tab-dot case: the tone is 'bad', so the Automations tab carries a
  // mark for a reader sitting on Cookies.
  ranfailed: {
    session: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      proxy: {ok: true, title: 'Anti-detect proxy active', detail: '131 ms', fields: []},
      recheckable: true,
      automations: [{id: 'a1', name: 'Daily login'}],
    },
    status: {
      profile: {id: 'p1', name: 'Sophia Bennett'},
      sync: {
        available: true, paused: false, inSync: true, reachable: true,
        pushedAt: 0, pushedCount: 148, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false, lastSet: '',
      },
      seed: {imported: true, seededAt: 0, seededCount: 64},
      counts: {total: 148, site: 12, siteDomain: 'instagram.com'},
    },
    openTab: 'automations',
    automation: {
      ok: true,
      available: true,
      run: null,
      last: {
        runId: 'run_3', status: 'failed', automationId: 'a1',
        automationName: 'Daily login', trigger: 'panel',
        startedAtOffsetMs: -95000, finishedAtOffsetMs: -32000,
        stepCount: 4, totalSteps: 12, progress: null,
        currentStep: 'Wait for #two-factor',
        error: 'Wait for #two-factor: timed out after 15000ms',
      },
    },
  },

  // Nothing pinned to this profile and nothing running. The tab is on screen and
  // has to explain which of those is true and what to do about it -- this is the
  // screen that used to be a hidden tab, i.e. nothing at all.
  noautomations: {
    session: {
      profile: {id: 'p4', name: 'Fresh profile'},
      proxy: {ok: true, title: 'Anti-detect proxy active', detail: '88 ms', fields: []},
      recheckable: true,
      automations: [],
    },
    status: {
      profile: {id: 'p4', name: 'Fresh profile'},
      sync: {
        available: true, paused: false, inSync: true, reachable: true,
        pushedAt: 0, pushedCount: 0, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false, lastSet: '',
      },
      seed: {imported: false, seededAt: 0, seededCount: 0},
      counts: {total: 0, site: 0, siteDomain: ''},
    },
    openTab: 'automations',
    automation: {ok: true, available: true, run: null, last: null},
  },

  // The case that justifies scoping the status poll by PROFILE rather than by the
  // token's automations list: nothing is pinned here, so there is nothing to run
  // from this window -- and a run started from the launcher is going anyway. The
  // card must show it, above an empty list that is still honest about having
  // nothing to offer.
  elsewhere: {
    session: {
      profile: {id: 'p4', name: 'Fresh profile'},
      proxy: {ok: true, title: 'Anti-detect proxy active', detail: '88 ms', fields: []},
      recheckable: true,
      automations: [],
    },
    status: {
      profile: {id: 'p4', name: 'Fresh profile'},
      sync: {
        available: true, paused: false, inSync: true, reachable: true,
        pushedAt: 0, pushedCount: 0, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false, lastSet: '',
      },
      seed: {imported: false, seededAt: 0, seededCount: 0},
      counts: {total: 0, site: 0, siteDomain: ''},
    },
    openTab: 'automations',
    automation: {
      ok: true,
      available: true,
      run: {
        runId: 'run_4', status: 'running', automationId: 'not-in-this-launch',
        automationName: 'Nightly inventory sweep', trigger: 'schedule',
        startedAtOffsetMs: -12000, finishedAt: null,
        stepCount: 1, totalSteps: 8, progress: 0.125,
        currentStep: 'Go to shop.example.com/inventory', error: null,
      },
      last: null,
    },
  },

  // A healthy proxy carrying a detectable session. The card must go amber
  // rather than green: "Anti-detect proxy active" over a red "≠ Europe/Berlin"
  // is the panel contradicting itself.
  mismatch: {
    session: {
      profile: {id: 'p3', name: 'Marcus Webb'},
      proxy: {
        ok: true,
        title: 'Anti-detect proxy active',
        detail: '91.208.14.22:41000 · Frankfurt, Hesse, DE · 88 ms',
        // The one case where "matches exit" would be earned is its opposite:
        // the zone was chosen by hand, so comparing it to the exit is a real
        // check -- and here it fails. Note also a stale reading, which the
        // Location row now says out loud.
        fields: [
          {label: 'Exit', value: '91.208.14.22', icon: 'globe', mono: true, note: '88 ms'},
          {label: 'Location', value: 'Frankfurt, Hesse, DE', icon: 'mapPin', note: 'checked 6 d ago'},
          {label: 'Timezone', value: 'America/New_York', icon: 'clock', mono: true,
            note: '≠ Europe/Berlin', noteTone: 'bad'},
          {label: 'Device', value: 'macOS 15 · 2560x1440', icon: 'monitor'},
        ],
      },
      recheckable: true,
      automations: [{id: 'a1', name: 'Warm up the feed'}],
    },
    status: {
      profile: {id: 'p3', name: 'Marcus Webb'},
      sync: {
        available: true, paused: true, inSync: false, reachable: true,
        pushedAt: 0, pushedCount: 0, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false, lastSet: '',
      },
      seed: {imported: false, seededAt: 0, seededCount: 0},
      // A domain no column can fit, and a profile name that has to ellipsise in
      // the sticky header.
      counts: {total: 52, site: 7, siteDomain: 'a-very-long-subdomain.example-shop.co.uk'},
    },
  },

  // A dead proxy, no automations, and sync throttled rather than broken --
  // three different tones at once.
  fail: {
    session: {
      profile: {id: 'p2', name: 'A profile with a really quite long name indeed'},
      proxy: {
        ok: false,
        title: 'Anti-detect proxy failed',
        detail: '45.128.61.7:9021 failed its last check: proxy authentication was rejected.',
      },
      recheckable: true,
      automations: [],
    },
    status: {
      profile: {id: 'p2', name: 'A profile with a really quite long name indeed'},
      sync: {
        available: true, paused: false, inSync: false, reachable: true,
        pushedAt: 0, pushedCount: 0, lastError: '', lastErrorKind: 'rate-limited',
        lastErrorSource: 'push', pushPending: true, lastSet: '',
      },
      seed: {imported: false, seededAt: 0, seededCount: 0},
      counts: {total: 3, site: 0, siteDomain: ''},
    },
  },

  // No scout-session.json and no run token: the extension is loaded, but this
  // window was never launched from the launcher. Every launcher-backed control
  // must be off and must say why.
  nolaunch: {
    session: null,
    status: {
      profile: null,
      sync: {
        available: false, paused: false, inSync: false, reachable: true,
        pushedAt: 0, pushedCount: 0, lastError: '', lastErrorKind: '',
        lastErrorSource: '', pushPending: false, lastSet: '',
      },
      seed: {imported: false, seededAt: 0, seededCount: 0},
      counts: {total: 0, site: 0, siteDomain: ''},
    },
  },
};

// Serialized in rather than written out as source, so the fixtures above stay
// ordinary JavaScript objects this file can lint and a reader can edit.
function harness() {
  // data-theme="system" matches sidepanel.html's own default -- without it the
  // nolaunch fixture, which never reaches the line that stamps a theme, painted
  // light on a dark desktop and the harness quietly disagreed with the panel.
  return `<!doctype html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8">
<title>Scout Panel preview</title>
<link rel="stylesheet" href="sidepanel.css">
</head>
<body>
<script id="harness">
const QUERY = new URLSearchParams(location.search);
const FIXTURES = ${JSON.stringify(FIXTURES)};
const fixture = FIXTURES[QUERY.get('state')] || FIXTURES.ok;
// The theme rides the query string here; in the real panel it arrives on
// scout-session.json from the launcher's own setting.
if (fixture.session) fixture.session.theme = QUERY.get('theme') || 'light';

// A run's timestamps are the one thing a static fixture cannot state: an absolute
// startedAt would have the elapsed clock counting up from whenever this file was
// written. Fixtures give an offset from now instead, resolved here once at load so
// the clock in the meta line reads as a real duration and keeps ticking.
for (const run of [fixture.automation && fixture.automation.run,
  fixture.automation && fixture.automation.last]) {
  if (!run) continue;
  if (typeof run.startedAtOffsetMs === 'number') {
    run.startedAt = new Date(Date.now() + run.startedAtOffsetMs).toISOString();
  }
  if (typeof run.finishedAtOffsetMs === 'number') {
    run.finishedAt = new Date(Date.now() + run.finishedAtOffsetMs).toISOString();
  }
}

const noop = {addListener() {}};
window.chrome = {
  runtime: {
    getURL: (path) => path,
    sendMessage: async (message) => {
      if (message.type === 'get-session') return {ok: true, session: fixture.session};
      if (message.type === 'get-status') return fixture.status;
      if (message.type === 'list-launcher-cookies') return fixture.launcherCookies;
      // Absent on the older fixtures, and that absence is itself a state worth
      // rendering: no automation key means no launch credential, which is what
      // the panel reads as "there will never be a run to report here".
      if (message.type === 'automation-status') {
        return fixture.automation || {ok: false, available: false};
      }
      // The two live workspace lists. Both absent means the launcher is closed:
      // the panel keeps the launch snapshot's automations and shows no picker,
      // which is a real state and the one every fixture written before these
      // routes existed now exercises for free.
      if (message.type === 'list-automations') {
        return fixture.workspaceAutomations || {ok: false, available: false};
      }
      if (message.type === 'list-launcher-cookie-sets') {
        return fixture.cookieSets || {ok: false, available: false};
      }
      return {ok: true};
    },
  },
  storage: {onChanged: noop},
  // The live jar, which the launcher-cookie list diffs against to mark sites
  // this browser does not have yet.
  cookies: {onChanged: noop, getAll: async () => fixture.jar || []},
  tabs: {onActivated: noop, onUpdated: noop, create() {}},
};

// The real markup, fetched rather than duplicated.
fetch('sidepanel.html').then((response) => response.text()).then((html) => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  // Taken from the markup rather than listed here. This was a hardcoded array,
  // and adding sync-status.js to sidepanel.html left the preview loading a
  // sidepanel.js whose first statement destructures a global that no longer
  // existed -- a blank panel that said nothing about why. The order matters and
  // the document already states it.
  const sources = [...parsed.querySelectorAll('script[src]')].map((tag) => tag.getAttribute('src'));
  let pending = sources.length;
  for (const source of sources) {
    const element = document.createElement('script');
    element.src = source;
    element.async = false;
    element.addEventListener('load', () => {
      if (--pending) return;
      // Most fixtures are about the Cookies tab, which opens by default. The ones
      // about a run are not, and clicking through by hand for every screenshot is
      // how a state stops being looked at. The real tab, clicked the real way --
      // tabs.js owns selection and publishes no API for it.
      const wanted = fixture.openTab;
      if (wanted) {
        const tab = document.querySelector('[role="tab"][data-tab="' + wanted + '"]');
        if (tab) tab.click();
      }
    });
    document.body.appendChild(element);
  }
});
</script>
</body>
</html>
`;
}

const server = createServer(async (request, response) => {
  const path = decodeURIComponent(request.url.split('?')[0]);
  if (path === '/' || path === '/preview.html') {
    response.writeHead(200, {'Content-Type': TYPES['.html']});
    response.end(harness());
    return;
  }
  // normalize() and then a prefix check: this serves a directory over HTTP, and
  // a request for "/../../.env" is the one thing it must refuse. The trailing
  // separator matters -- without it a sibling directory whose name merely
  // starts with the same characters would pass.
  const file = normalize(join(EXTENSION_DIR, path));
  if (!file.startsWith(EXTENSION_DIR + sep)) {
    response.writeHead(403).end('Outside the extension directory');
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {'Content-Type': TYPES[extname(file)] || 'application/octet-stream'});
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(0, '127.0.0.1', () => {
  const {port} = server.address();
  console.log('Scout Panel preview — Ctrl-C to stop\n');
  for (const state of Object.keys(FIXTURES)) {
    for (const theme of ['light', 'dark']) {
      console.log(`  ${state.padEnd(9)} ${theme.padEnd(5)}  ` +
          `http://127.0.0.1:${port}/preview.html?state=${state}&theme=${theme}`);
    }
  }
});
