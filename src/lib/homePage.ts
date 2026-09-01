// The local home page injected into every anonymous browser session: shared
// bookmarks, the automations pinned to start pages, and a panel saying whether
// the anti-detect proxy is actually working. Built as a string here because the
// browser renders it from a file the main process writes, not from this
// renderer.
//
// It paints with the launcher's own tokens (src/lib/palette.ts, checked against
// styles.css by scripts/verify-palette.mjs) and follows the launcher's theme, so
// a session opens looking like the app that opened it. It used to carry a warm
// paper palette of its own, from before the launcher went achromatic.
// The EasyDeck mark that sits above the search box, imported ?raw rather than as a
// URL so it can be inlined. Same constraint as the four icon constants below:
// this document is written to disk and opened from file://, with no bundler, no
// asset directory beside it and no network it is allowed to need, so an
// <img src="assets/…"> resolves to nothing.
//
// src/assets/monti-mark.svg is the *embeddable* cut -- currentColor rather than
// the canonical file's fill="black", and a namespaced clipPath id. Both matter
// here and nowhere else: black line art is invisible on the dark theme, and
// this is the only place the artwork lands inside a document that has ids of
// its own (#search, #suggest). See src/assets/README.md before swapping it.
//
// It is inlined once, as the page's own header above the search box, and costs
// ~20 KB in every generated home.html. Worth paying: the file is written to
// disk on each launch, never fetched, and already carries the whole palette and
// two scripts. It used to be inlined a second time beside the Automations
// label, for double the cost; that label now carries a workflow glyph, which is
// what the heading is actually about.
import montiMark from '../assets/monti-mark.svg?raw';
import {bookmarkInitial, faviconCache, normalizeBookmarkUrl} from './bookmarks';
import {AUTO_FROM_PROXY} from './fingerprintPresets';
import {FONT_STACK, MONO_STACK, paletteCss} from './palette';
import {expectedTimezoneFor, proxyLocationLabel, timezoneMismatch} from './proxyGeo';
import {escapeHtml} from './text';
import {defaultProfileStatus, statusToneClass} from '../data/statuses';
import type {SearchEngine} from './searchEngines';
import type {ThemePreference} from '../theme';
import type {MontiProfile, MontiProxy, SharedBookmark} from '../types';

// Where profile data lives, as the renderer states it: a bare relative path
// that the main process resolves against the app's userData directory (see
// resolveProfileUserDataDir in electron/main.cjs), which is the same default
// the monti:resolve-profile-root handler already falls back to.
//
// Deliberately relative on every platform. This used to return an absolute
// macOS path with a developer's own home directory baked into it, so every
// other Mac tried to launch profiles into /Users/<someone-else>/Library and
// died with EACCES before the browser ever started. The renderer cannot know
// the real home directory -- only the main process can -- so it must not try
// to name one.
//
// Split from profileDataDir so the General section of Settings can show exactly
// the root that launches use, rather than a second guess at it.
export function profilesRoot() {
  return 'MontiProfiles';
}

export function profileDataDir(profileId: string) {
  return `${profilesRoot()}/${profileId}`;
}

// Never send the browser back to the launcher's own UI, a loopback address or
// a blank tab -- the session has to start on the injected home page or a real
// site, or it is not recognisably an anonymous profile.
export function browserStartUrl(profile: MontiProfile) {
  const startUrl = profile.start_url?.trim();
  if (!startUrl ||
      startUrl === 'about:blank' ||
      startUrl.startsWith('chrome://') ||
      startUrl.includes('127.0.0.1') ||
      startUrl.includes('localhost') ||
      startUrl.includes('monti-launcher') ||
      startUrl.includes('/dist/index.html')) {
    return '';
  }
  return startUrl;
}

// How old the reading behind the Location row is, phrased the way a person
// would. Undated readings return '' rather than "unknown age", which would
// take a whole row's trailing slot to say nothing.
function checkAgeNote(checkedAt?: string | null): string {
  if (!checkedAt) return '';
  const at = Date.parse(checkedAt);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 2) return 'just checked';
  if (minutes < 60) return `checked ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `checked ${hours} h ago`;
  const days = Math.round(hours / 24);
  return `checked ${days} d ago`;
}

// One labelled row in the session panel. `note` is the quiet trailing value on
// the right of a row -- the exit's latency, the age of the reading, or the
// timezone's verdict -- and `noteTone` colours it, since "matches exit" and
// "≠ America/Chicago" are the same slot carrying opposite news. A note with no
// tone is neutral, which is what a fact rather than a verdict should be.
//
// `icon` names an entry in the side panel's own icon table
// (extensions/cookie-manager/icons.js), not a path -- this object is serialized
// into monti-session.json and handed to a document with no bundler, so the
// glyph has to be looked up on the other side. Optional because a panel loading
// a session snapshot written by an older launcher must still draw its rows.
export type SessionField = {
  label: string;
  value: string;
  icon?: string;
  mono?: boolean;
  note?: string;
  noteTone?: 'ok' | 'bad';
};

export type HomeProxyStatus = {
  ok: boolean;
  title: string;
  detail: string;
  fields?: SessionField[];
};

// The one place the proxy panel's wording is decided. Three surfaces read it:
// the start page's status pill, the browser side panel's Session card, and the
// re-check endpoint, which answers by re-running this against the fresh result
// rather than composing its own sentences. None of them can say one thing at
// launch and a differently worded version of the same thing a click later.
//
// A failing state returns `detail` and no fields: there is one sentence to say
// and nothing to tabulate. A working one returns `fields`, because then there
// are four facts whose *agreement* is the whole point.
export function homeProxyStatus(profile: MontiProfile, proxy: MontiProxy | null): HomeProxyStatus {
  const mode = profile.proxy_mode || 'assigned';
  if (mode !== 'assigned') {
    return {
      ok: false,
      title: mode === 'free_proxy' ? 'Anti-detect needs verified proxy' : 'Anti-detect proxy missing',
      detail: mode === 'free_proxy' ?
        'Free proxy fallback is active, but no verified assigned proxy is available.' :
        'Direct connection is active. Assign a checked proxy before using this profile.',
    };
  }
  if (!proxy?.host || !proxy.port) {
    return {
      ok: false,
      title: 'Anti-detect proxy missing',
      detail: 'No valid proxy is assigned to this profile.',
    };
  }
  const proxyLabel = `${proxy.host}:${proxy.port}`;
  if (proxy.check_error) {
    return {
      ok: false,
      title: 'Anti-detect proxy failed',
      detail: `${proxyLabel} failed its last check: ${proxy.check_error}`,
    };
  }
  if (!proxy.checked_at) {
    return {
      ok: false,
      title: 'Anti-detect proxy unverified',
      detail: `${proxyLabel} has not passed a proxy check yet.`,
    };
  }
  const egressIp = proxy.egress_ip && proxy.egress_ip !== proxy.host ? proxy.egress_ip : '';
  // What a coherence check actually needs: where the traffic comes out, what
  // clock the profile claims, and what machine it claims to be. Those are the
  // pair-wise comparisons detection sites run -- timezone against IP location,
  // platform against user agent -- so the panel shows them as labelled rows a
  // person can compare, rather than the single dot-separated run of values this
  // replaces. That line was also clipped to one ellipsised row by the panel's
  // own CSS, so the last two facts were never actually visible.
  const latency = typeof proxy.ping_ms === 'number' ? `${proxy.ping_ms} ms` : '';
  const chosenTimezone = profile.fingerprint?.timezone;
  const isAuto = !chosenTimezone || chosenTimezone === AUTO_FROM_PROXY;
  const effectiveTimezone = isAuto ? expectedTimezoneFor(proxy) : chosenTimezone;
  const mismatch = timezoneMismatch(chosenTimezone, proxy);
  const machine = [profile.fingerprint?.os, profile.fingerprint?.screen]
      .filter(Boolean)
      .join(' · ');

  // The timezone row's trailing note. It used to read "matches exit" whenever
  // there was no mismatch, which sounds like a verification and was not one:
  // timezoneMismatch() returns null for an AUTO_FROM_PROXY profile without
  // comparing anything, and AUTO_FROM_PROXY is the default. So the row printed
  // a green "matches exit" for essentially every profile, derived the timezone
  // from the proxy row, and then congratulated itself for agreeing with the row
  // it had just read. It could not fail.
  //
  // Three honest states instead, and only one of them is a claim:
  //
  //   - an explicitly chosen zone that disagrees with the exit -- a real
  //     comparison, and the one thing here allowed to be `bad`;
  //   - an explicitly chosen zone that agrees -- also a real comparison, and
  //     the only place "matches exit" is earned;
  //   - a zone derived from the exit -- says where it came from, in the neutral
  //     tone, because "this equals itself" is not news.
  //
  // Plus the state that was invisible before: auto with nothing to derive from,
  // which is a profile about to report the HOST machine's zone and is the most
  // actionable thing this panel can say.
  const timezoneNote = (() => {
    if (mismatch) return {note: `≠ ${mismatch.expected}`, noteTone: 'bad' as const};
    if (!isAuto) return {note: effectiveTimezone ? 'matches exit' : '', noteTone: 'ok' as const};
    if (effectiveTimezone) return {note: 'from exit IP'};
    return {note: 'not resolved — re-check', noteTone: 'bad' as const};
  })();

  // The glyphs are the four facts, not decoration: a globe for where the
  // traffic leaves, a pin for where that lands, a clock for the zone the
  // profile claims and a monitor for the machine it claims to be. Same job the
  // start page's rowIcon does one section down -- four rows of uppercase labels
  // in one weight are told apart by shape before they are read.
  const fields: SessionField[] = [
    {label: 'Exit', value: egressIp || proxyLabel, icon: 'globe', mono: true, note: latency},
    {
      label: 'Location',
      value: proxyLocationLabel(proxy) || 'Unknown',
      icon: 'mapPin',
      // When this reading was taken. The row is composed at launch from the
      // stored columns of whatever check ran last, which can be days old and
      // from a different exit if the proxy rotates -- and the panel gave no
      // way to tell a reading from a minute ago from one from last week.
      note: checkAgeNote(proxy.checked_at),
    },
    {
      label: 'Timezone',
      value: effectiveTimezone || 'Not set',
      icon: 'clock',
      mono: true,
      ...timezoneNote,
    },
    {label: 'Device', value: machine || 'Default', icon: 'monitor'},
  ];
  return {
    ok: true,
    title: 'Anti-detect proxy active',
    // Kept as the one-line form for anything that reads a status without
    // rendering rows -- the panel itself renders `fields`.
    detail: [proxyLabel, proxyLocationLabel(proxy), latency].filter(Boolean).join(' · '),
    fields,
  };
}

// Whether this profile can be re-checked at all. Direct and free-proxy modes
// have no assigned proxy to re-test, so the button would be a control with
// nothing behind it -- see House Rule 6, no phantom data.
export function canRecheckProxy(profile: MontiProfile, proxy: MontiProxy | null) {
  return (profile.proxy_mode || 'assigned') === 'assigned' &&
    Boolean(proxy?.host) && Boolean(proxy?.port);
}

const SEARCH_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>';

// Lucide's ExternalLink, Play, RefreshCw, Info and Workflow, inlined. The
// document has no icon font and no network it should depend on, and all of them
// are drawn with currentColor so each takes the colour of whatever state it sits
// in.
const EXTERNAL_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"></path><path d="M20 4l-9 9"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>';
const RUN_ICON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5.2v13.6l11.5-6.8z"></path></svg>';
const REFRESH_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>';
const INFO_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>';
// One per section heading, so the three blocks are told apart by shape before
// they are read -- the same job rowIcon does inside the session card, at the
// same weight.
//
// Workflow is the icon the launcher's sidebar rail already gives the Automations
// tab (src/data/tabs.ts); Shield is the mark the browser side panel wears in its
// header, and the panel is the surface that shows this same session in full.
// Neither collides with the four rowIcon glyphs inside the card below.
//
// All three copied path-for-path from node_modules/lucide-react/dist/esm/icons
// rather than redrawn, so the rail and the headings cannot drift into two
// different marks.
const WORKFLOW_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="3" y="3" rx="2"></rect><path d="M7 11v4a2 2 0 0 0 2 2h4"></path><rect width="8" height="8" x="13" y="13" rx="2"></rect></svg>';
const BOOKMARK_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path></svg>';
const SHIELD_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path></svg>';

// A section's one explanatory sentence, and the (i) that opens it. The same two
// sentences the launcher's Start page tab writes on the same two headings
// (SectionLabel in components/tabs/StartPageTab.tsx) -- these are one page in
// two places, and a note reworded on one surface alone is how the pair starts
// reading as two screens.
//
// The sentence lands in data-tip, which the stylesheet above pulls into the
// bubble through content:attr(). Escaped because it becomes an attribute value;
// both of these carry apostrophes.
const BOOKMARKS_NOTE =
  "Shared across the workspace. Added in the launcher's Start page tab, and " +
  "they appear on every profile's start page.";
const AUTOMATIONS_NOTE =
  "Pinned workflows appear on every profile's browser start page and run from " +
  "there in that profile's session.";

function labelInfo(note: string) {
  const safe = escapeHtml(note);
  return `<button type="button" class="label-info" data-tip="${safe}" aria-label="${safe}">${INFO_ICON}</button>`;
}

// One per session-card row, so the three facts are scannable by shape before
// they are read. Lucide's Globe, Monitor and Cookie, at the same 15px and the
// same stroke, drawn in --ink-faint beside their label.
//
// Activity used to be here as `status`. The status is now a chip in the card's
// head rather than a row in its grid -- it is a verdict on the session, not one
// of the facts being compared -- and the chip carries its own tone dot, so the
// glyph had nothing left to label.
//
// The launcher's Start page tab renders the same three as lucide-react
// components at the same size (StartPageTab.tsx). Two copies of one set, for
// the reason every icon in this file exists twice: a file:// document has no
// icon font and no module graph, so the paths have to travel inside it.
const ROW_ICONS: Record<string, string> = {
  proxy: '<circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path>',
  platform: '<rect width="20" height="14" x="2" y="3" rx="2"></rect><path d="M8 21h8"></path><path d="M12 17v4"></path>',
  cookies: '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"></path><path d="M8.5 8.5v.01"></path><path d="M16 15.5v.01"></path><path d="M12 12v.01"></path><path d="M11 17v.01"></path><path d="M7 14v.01"></path>',
};

function rowIcon(name: keyof typeof ROW_ICONS | string) {
  return `<svg class="field-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ROW_ICONS[name]}</svg>`;
}

// One automation as the start page needs it: enough to fill a card, and
// nothing more. Deliberately NOT the MontiAutomation row -- `steps` carries
// selectors, urls and typed values, and this object is serialized into a
// file:// document that goes on to visit arbitrary sites. The count is the one
// thing about the steps the page is allowed to know.
export type PageAutomation = {
  id: string;
  name: string;
  description?: string | null;
  stepCount?: number;
};

// Everything about *this launch*, as opposed to the profile and the bookmarks,
// which are just rows. Grouped rather than added to the positional list: these
// four arrive together from buildLaunchPayload, they are all "what this window
// may do", and a ninth positional argument is how the eighth gets passed in
// the seventh's place.
export type HomeLaunch = {
  // What this launch may run from its own start page. Empty (the default)
  // means no cards, which is what a launch with nothing attached and nothing
  // pinned gets.
  automations?: PageAutomation[];
  // This launch's page credential and the port to spend it on. Null means the
  // page can neither run an automation, nor open one in the launcher, nor
  // re-check its proxy -- it is a read-only document, exactly as it was before
  // any of those existed.
  run?: {port: number; token: string} | null;
  // The cookie set this launch seeded the browser with, as the launch payload
  // named it. Null renders "None". Passed in rather than resolved here because
  // the resolution needs the org's cookie rows, and a second lookup is how the
  // card ends up naming a set the browser did not actually get.
  cookieSetName?: string | null;
  // Whether the proxy can be re-checked at all -- canRecheckProxy(). False
  // hides the button rather than disabling it: there is no proxy behind it to
  // test, so it is not a control that is temporarily unavailable.
  recheckable?: boolean;
};


export function anonymousHomeHtml(
    profile: MontiProfile, bookmarks: SharedBookmark[],
    // Already composed by the caller, not derived here: the browser's side panel
    // paints the same object, and computing it twice is how the two surfaces
    // would end up describing one session in two different ways.
    proxyStatus: HomeProxyStatus,
    engine: SearchEngine,
    // The launcher's theme setting, not the resolved theme: 'system' has to
    // stay 'system' so prefers-color-scheme keeps deciding inside the browser,
    // which is a separate process on a machine whose appearance can change
    // while a session is open.
    theme: ThemePreference = 'system',
    // Everything about this particular launch. See HomeLaunch.
    launch: HomeLaunch = {}) {
  const {automations = [], run = null, cookieSetName = null, recheckable = false} = launch;
  const safeName = escapeHtml(profile.name || 'Profile');
  const bookmarkItems = bookmarks
      .map((bookmark) => {
        const url = normalizeBookmarkUrl(bookmark.url);
        if (!url) {
          return '';
        }
        const title = escapeHtml(bookmark.title || url);
        const safeUrl = escapeHtml(url);
        // Same resolution order as the launcher's bookmark tile: manual icon,
        // then whatever the favicon fetch already cached, then the monogram.
        const icon = bookmark.icon || faviconCache.get(url) || '';
        // The icon always sits in the same .mark box whether it holds a favicon
        // or a letter, so every tile is the same size regardless of which one
        // it got. The url is deliberately not printed under the title -- it is
        // in the title attribute for anyone who wants it, and a row of tiles
        // reads faster without it.
        const mark = icon ?
          `<span class="mark"><img class="favicon" alt="" src="${escapeHtml(icon)}"></span>` :
          `<span class="mark">${escapeHtml(bookmarkInitial(bookmark))}</span>`;
        return `<a class="bookmark" href="${safeUrl}" title="${safeUrl}">${mark}<strong>${title}</strong></a>`;
      })
      .join('');
  // Cards rather than tiles, and deliberately not the .bookmark box: a shortcut
  // takes you somewhere and a workflow does something to this profile, so the
  // two must not be the same object at the same size. Each card is about two
  // bookmarks wide and carries what you need to decide whether to press it --
  // what it is called, what it does, how long it is -- plus its own two
  // controls. data-state drives the tint; the id is an opaque handle the
  // launcher already knows.
  //
  // The card leads with the Run button. It used to lead with a decorative
  // .auto-mark carrying the same play glyph as the real Run button in the far
  // corner, which is two identical triangles on one card where only the far one
  // did anything -- so the obvious thing to press was the one that did nothing.
  // There is one triangle now and it is the button.
  //
  // The whole card is not clickable. There are two different actions on it, and
  // a card that runs when you click anywhere but the corner is a card that runs
  // when you meant to press the corner.
  const automationCards = run ? automations
      .map((automation) => {
        const name = escapeHtml(automation.name || 'Automation');
        // The description if there is one, else the length -- which is the only
        // other honest thing this page knows about a workflow. A card with a
        // blank second line reads as a card that failed to load.
        const steps = automation.stepCount || 0;
        const sub = automation.description?.trim() ?
          escapeHtml(automation.description.trim()) :
          `${steps} step${steps === 1 ? '' : 's'}`;
        return `<article class="auto-card" data-id="${escapeHtml(automation.id)}" data-state="idle">
<button type="button" class="auto-run" title="Run ${name} in this session" aria-label="Run ${name} in this session">${RUN_ICON}</button>
<div class="auto-text"><strong title="${name}">${name}</strong><small title="${sub}">${sub}</small></div>
<div class="auto-actions">
<button type="button" class="auto-open icon-button" title="Open ${name} in EasyDeck" aria-label="Open ${name} in EasyDeck">${EXTERNAL_ICON}</button>
</div>
</article>`;
      })
      .join('') : '';
  // ── The session card's four facts ──────────────────────────────────────────
  // Three of them are already on `profile`; only the cookie set had to be
  // passed in, because naming it needs the org's cookie rows. None of them is
  // re-derived from anything: the status is the stored one, the platform is the
  // fingerprint's own string, and the proxy sentence is homeProxyStatus's.
  const statusLabel = profile.status || defaultProfileStatus;
  const statusChip =
    `<span class="chip ${statusToneClass(statusLabel)}"><i></i>${escapeHtml(statusLabel)}</span>`;
  const platform = escapeHtml(profile.fingerprint?.os || 'Default');
  const cookieLabel = cookieSetName?.trim() ?
    escapeHtml(cookieSetName.trim()) :
    '<span class="muted">None</span>';
  return `<!doctype html>
<html data-theme="${escapeHtml(theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeName}</title>
<style>
${paletteCss()}
*{box-sizing:border-box}
/* The column is centred in the window rather than pinned near the top: this is
   a page you aim at, and 48px from the top of a 1000px window left it stranded
   in the upper third with the rest of the screen empty under it. min-height is
   a floor, not a height, so a long bookmark list grows the page and scrolls
   instead of being clipped at both ends the way flex centring would. */
body{margin:0;min-height:100vh;display:grid;align-content:center;justify-items:center;padding:64px 24px;background:var(--surface);color:var(--ink);font-family:${FONT_STACK};font-size:14px;-webkit-font-smoothing:antialiased}
/* 640px, the same cap the launcher's own Start page tab uses, so the two
   surfaces read as the same page. */
main{width:100%;max-width:640px}
h1{font-size:20px;letter-spacing:-0.01em;margin:0;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{margin:4px 0 0;color:var(--ink-soft);font-size:13px}
/* The EasyDeck mark, over the profile name and the search box. The launcher's own
   Start page tab puts the same mark in the same place (.start-brand in
   styles.css) -- the two are one page in two places, and a session that opens
   on an anonymous window is the half that most needs to say who opened it.
   It inherits --ink through currentColor rather than naming a colour, so it
   inverts with the theme the way the four icons below it do.

   Centred over the column, matching .start-brand in styles.css. It reads as the
   page's own header rather than as the first item of the left-aligned list
   under it -- and it is the one element on this page that belongs to the window
   rather than to the profile, so it is the one that should not sit in the
   column's text rhythm. Keep the two surfaces in step: this mark and that one
   are the same mark in the same place, and moving one alone is what makes the
   pair read as two different screens.

   The negative top margin lifts it clear of the block it heads rather than
   shrinking the gap under it: at 56px the mark is the first thing the eye
   lands on, and it wants air below it, not above. */
.brand{display:flex;justify-content:center;margin:-16px 0 30px;color:var(--ink)}
.brand svg{height:72px;width:auto;display:block}

/* ── Session card ───────────────────────────────────────────────────────────
   What this window actually is: what the profile is marked as, which proxy it
   is coming out of, what machine it claims to be, and which cookie set seeded
   it. Always on screen, the full width of the column.

   This replaces a card that was pinned to the top-right corner and only
   appeared when the proxy was failing. That was the right call while the page
   had nothing to say the side panel could not say better -- but a corner card
   is the wrong shape for four labelled facts, and the panel is behind a
   toolbar button, which is one click more than a fact you want at a glance
   deserves. The full exit/location/timezone/device readout still lives in the
   panel: that one changes while the session runs, and this one does not.

   The card carries a tone rather than appearing and disappearing. A healthy
   session is the neutral card; a failing proxy tints the whole thing and puts
   its sentence where the proxy line was, so there is exactly one place to look
   either way.

   Its heading sits above it rather than inside it, the way Bookmarks and
   Automations do -- so the page reads as three labelled blocks and not as two
   blocks and a card that names itself. 10px, matching .auto-grid: the 26px that
   separates one section from the last is on .section-label now.

   Two layers, not one, and the split is what the automation cards one section
   up already do with .auto-run's plate: a --paper surround holding a --raised
   card. The surround is where this session's CONTROLS live -- what it is
   (Status), how to take a fresh reading (Re-check), and where to check it
   against someone else's opinion (ip.me). The card inside is the READING. They
   used to share one box, which put a status chip in the same grid as the value
   it was a verdict on, and stranded the two controls up in the section heading
   several centimetres from the thing they act on.

   No border of its own, and 2px of side padding rather than 10. The card inside
   carries the only outline -- the same 1px --border on --raised that .auto-card
   one section up carries -- and what is left of the shell beside it reads as a
   thin grey frame around that card. At 10px with a border of its own it was a
   second box: two outlines a centimetre apart, drawn around one object. */
.session-shell{margin-top:10px;padding:0 2px 2px;border:0;border-radius:var(--radius-lg);background:var(--paper)}
/* Status on the left, the two controls hard right. min-height is the icon
   buttons' own, so a session that cannot be re-checked does not sit at a
   different height from one that can. Its own horizontal padding, because the
   shell has almost none: the controls need clearing from the edge, and the card
   below does not. */
.session-head{display:flex;align-items:center;gap:8px;min-height:26px;padding:6px 8px 8px}
.session-actions{margin-left:auto;display:flex;align-items:center;gap:4px}
/* No outline of its own. The shell behind it and its own fill already separate
   it from the page, and the 1px rule on top of that was a second edge 2px
   inside the first. The failure state still draws one, as an inset shadow
   rather than a border, so a card that goes bad gains a line instead of every
   card carrying one -- and the swap costs no layout shift. */
.session{padding:14px;border:0;border-radius:var(--radius);background:var(--raised);transition:box-shadow .12s var(--ease),background .12s var(--ease)}
.session[data-tone=bad]{box-shadow:inset 0 0 0 1px var(--danger);background:var(--danger-bg)}
/* One column, not two. It was a 1fr 1fr grid while Status shared it with the
   other three facts; with Status moved up to the head there are three rows
   left, and three in a two-column grid is two rows and an orphan. Full-width
   rows also let the values line up as one column, which is the comparison this
   block exists to make easy. */
.session-fields{display:grid;gap:9px;margin:0}
/* center, not baseline: every label now leads with a 15px glyph, and a
   baseline row hangs the icon off the text's baseline instead of centring it
   on the cap height. */
.field{display:flex;align-items:center;gap:10px;min-width:0}
.field.wide{align-items:flex-start}
/* A fixed label column, so the four values line up as a column rather than
   starting wherever their own label happened to end. */
.field dt{flex:0 0 88px;display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:var(--ink-faint)}
.field-icon{flex:0 0 auto}
/* The wide row's value wraps to two lines, so its label has to sit on the
   first of them rather than in the middle of the block. */
.field.wide dt{padding-top:1px}
.field dd{flex:1;min-width:0;margin:0;font-size:13px;line-height:1.35;color:var(--ink)}
/* Wraps, up to two lines: this is where what failed, or what to assign
   instead, gets said, and a sentence clipped to one line loses the half that
   says why. */
.field dd.sentence{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.session[data-tone=bad] .field dd.sentence{color:var(--danger)}
.session[data-tone=bad] .field dd.sentence strong{display:block;font-weight:700}
.muted{color:var(--ink-faint)}
/* The profiles table's status chip, rebuilt from the same tokens rather than
   re-decided here: statusToneClass() picks the class in both places, so a
   status that reads amber in the table cannot read grey in the browser. */
.chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px 2px 7px;border:1px solid var(--status-neutral-border);border-radius:999px;background:var(--status-neutral-bg);color:var(--status-neutral-ink);font-size:12px;font-weight:700;line-height:1.5}
.chip i{width:6px;height:6px;border-radius:999px;background:currentColor}
.chip.status-active{background:var(--status-active-bg);border-color:var(--status-active-border);color:var(--status-active-ink)}
.chip.status-warmup{background:var(--status-warmup-bg);border-color:var(--status-warmup-border);color:var(--status-warmup-ink)}
.chip.status-ban{background:var(--status-ban-bg);border-color:var(--status-ban-border);color:var(--status-ban-ink)}
.chip.status-review{background:var(--status-review-bg);border-color:var(--status-review-border);color:var(--status-review-ink)}

/* ── Buttons ────────────────────────────────────────────────────────────────
   Two shapes, shared by the session card and the automation cards: a labelled
   pill and a bare icon target. Colour-only transitions on the app's one curve;
   nothing moves on hover. */
.icon-button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--ink-soft);text-decoration:none;cursor:pointer;transition:background .12s var(--ease),color .12s var(--ease)}
.icon-button:hover{background:var(--hover);color:var(--ink)}
.pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--border);border-radius:999px;background:var(--paper);color:var(--ink-soft);font:inherit;font-size:12px;font-weight:700;cursor:pointer;transition:background .12s var(--ease),color .12s var(--ease),border-color .12s var(--ease)}
.pill:hover{background:var(--hover);color:var(--ink)}
.pill[disabled]{cursor:progress;opacity:0.6}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}

/* ── Search ─────────────────────────────────────────────────────────────────
   The suggestion list is positioned against .search-wrap, so it stays put while
   the input inside it grows or shrinks. */
.search-wrap{position:relative;margin-top:26px}
.search{display:flex;align-items:center;gap:8px;background:var(--raised);border:1px solid var(--border);border-radius:999px;padding:0 6px 0 16px;height:46px;box-shadow:var(--shadow-xs)}
.search:focus-within{border-color:var(--accent);box-shadow:var(--shadow-md)}
.search input{flex:1;min-width:0;border:0;outline:none;background:transparent;font:inherit;font-size:14px;color:inherit}
.search button{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:0;border-radius:999px;background:var(--paper);color:var(--ink-soft);cursor:pointer}
.search button:hover{background:var(--hover);color:var(--ink)}
.suggest{position:absolute;left:0;right:0;top:52px;background:var(--raised);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-md);padding:6px;z-index:5}
.suggest[hidden]{display:none}
.suggest div{padding:8px 12px;border-radius:var(--radius-sm);font-size:14px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.suggest div.on{background:var(--hover)}

/* ── Bookmark tiles ─────────────────────────────────────────────────────────
   Five to a row, matching the launcher's Start page tile grid. 10px under its
   heading, the same as .auto-grid and .session: the 26px that separates one
   section from the last belongs to .section-label, and this used to carry 28px
   of its own on top of it -- which read as the tiles drifting away from the
   word that names them once the other two sections got headings of their
   own. */
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:10px}
/* No card, no border: a shortcut is a target, and forty tiles of chrome read as
   noise. Hover paints a soft plate instead. */
.bookmark{display:grid;justify-items:center;gap:8px;padding:12px 8px 10px;border-radius:var(--radius);text-decoration:none;color:inherit;background:transparent;transition:background .12s var(--ease)}
.bookmark:hover{background:var(--hover)}
/* The site's own logo is the tile -- no plate behind it, no border around it.
   The frame it used to sit in was a second rectangle inside a rectangle that
   already appears on hover, and it shrank the one part of the tile a person
   actually recognises. Losing it buys 14px of logo.

   The box stays a fixed square so a favicon and a monogram produce identically
   sized tiles, which is the whole reason it exists. */
.mark{width:56px;height:56px;border-radius:var(--radius);color:var(--ink-soft);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800}
.bookmark .favicon{width:40px;height:40px;border-radius:var(--radius-sm);object-fit:contain}
/* 700, the app's own weight for a label: at 12px on a tile the browser's
   default bold on <strong> made a row of five titles look like five headings. */
.bookmark strong{max-width:100%;font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{margin-top:28px;color:var(--ink-soft);font-size:13px}

/* ── Section labels ─────────────────────────────────────────────────────────
   The mark rides the Automations label: the workflow glyph the launcher's
   sidebar rail gives its Automations tab, so the heading here and the tab there
   are recognisably the same thing.

   It used to be the EasyDeck helmet, at 18px, which was the header mark from 30px
   above saying the same sentence twice -- and saying it about the wrong noun. A
   heading's mark should name what is under it, not who drew the window.

   All three headings are a mark, a word and an (i), and nothing else. Session
   used to carry Re-check and the ip.me link out here on a trailing
   .section-actions slot; they now sit in the session shell's own head row,
   inside the block they act on. */
.section-label{display:flex;align-items:center;gap:8px;margin:26px 0 0;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--ink-soft)}
.label-mark{display:flex;color:var(--ink-soft)}
/* The rounded (i) that carries a section's one explanatory sentence, and the
   bubble it opens on hover or keyboard focus.

   The sentence used to live in title= and be drawn by the browser. On this page
   it never appeared: the cursor turned to help and nothing followed, on a
   document the browser loads from file:// inside a fork whose chrome we do not
   control. So the page draws its own -- a rule this page can be held to, and
   one a screenshot can prove. A <button> rather than a <span> so it is
   reachable without a mouse; aria-label carries the same sentence for anyone
   who cannot see the bubble.

   Anchored to the (i)'s left edge rather than centred on it: the Bookmarks
   label sits at the left edge of a 640px column, and a centred 260px bubble
   there hangs off the page. */
.label-info{position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:999px;background:none;font:inherit;color:var(--ink-faint);cursor:help;transition:color .12s var(--ease)}
.label-info:hover{color:var(--ink)}
.label-info::after{content:attr(data-tip);position:absolute;top:calc(100% + 7px);left:-7px;z-index:10;width:max-content;max-width:260px;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--raised);box-shadow:var(--shadow-md);color:var(--ink);font-size:12px;font-weight:400;line-height:1.4;letter-spacing:0;text-transform:none;text-align:left;white-space:normal;opacity:0;pointer-events:none;transition:opacity .12s var(--ease)}
.label-info:hover::after,.label-info:focus-visible::after{opacity:1}

/* ── Automation cards ───────────────────────────────────────────────────────
   Roughly two bookmark tiles wide, two to a row. A shortcut takes you
   somewhere and a workflow does something to this profile, so they are not the
   same object at the same size -- these were identical tiles under a different
   heading, which said the two were the same kind of thing and left no room for
   what a workflow is or what it costs to press.

   data-state says what happened without a toast this page has no room for; it
   tints the border and the mark and reverts on its own.

   One row: Run, text, controls. The same three-slot card the launcher's Start
   page tab draws (.start-card in styles.css), so a workflow is one object with
   one shape wherever it appears -- the two used to differ by a whole second
   row, which made the browser's card the taller cousin of the launcher's
   rather than the same card. The launcher's first slot is the same box holding
   the same glyph, inert (there is nothing to run there); this one is the
   button. */
.auto-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:10px}
.auto-card{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:12px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--raised);transition:border-color .12s var(--ease)}
.auto-card[data-state=running]{border-color:var(--accent)}
.auto-card[data-state=done]{border-color:var(--status-active-border)}
.auto-card[data-state=failed]{border-color:var(--danger)}
/* The card's first slot and its only run control: the 40px plate that used to
   be decoration, now the button. It keeps the plate's shape rather than the
   30px accent circle that used to sit in the far corner -- at two cards to a
   row this is the biggest target on the card, and the state tint it already
   carried is what says how the run went. */
.auto-run{width:40px;height:40px;padding:0;border:0;border-radius:var(--radius);background:var(--paper);color:var(--ink-soft);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .12s var(--ease),color .12s var(--ease)}
.auto-run:hover{background:var(--hover);color:var(--ink)}
.auto-card[data-state=done] .auto-run{background:var(--status-active-bg);color:var(--status-active-ink)}
.auto-card[data-state=failed] .auto-run{background:var(--danger-bg);color:var(--danger)}
.auto-card[data-state=running] .auto-run{cursor:progress;opacity:0.6}
/* min-width:0 because a grid item defaults to min-width:auto, and without it a
   long unbreakable name widens its own column and skews the row. */
.auto-text{min-width:0;display:grid;gap:2px}
.auto-text strong{font-size:13px;font-weight:700;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.auto-text small{font-size:12px;line-height:1.35;color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The third slot: open-in-launcher, and nothing else. Run used to sit here too,
   as a 30px accent circle beside it -- which put a second play triangle on a
   card that already led with one, three pixels of gap apart from the control
   that opens a different window. Both controls name themselves in title and
   aria-label.

   Quotes, not backticks, in these comments: this CSS lives inside a template
   literal, and a backtick here closes the string. */
.auto-actions{flex:0 0 auto;display:flex;align-items:center;gap:2px}
</style>
</head>
<body>
<main>
<div class="brand">${montiMark}</div>
<h1>${safeName}</h1>
<p class="sub">Anonymous EasyDeck Browser session</p>
<div class="search-wrap">
<form class="search" id="search" autocomplete="off">
<input type="text" aria-label="Search or enter address" placeholder="Search ${escapeHtml(engine.name)} or enter address" autofocus>
<button type="submit" aria-label="Search">${SEARCH_ICON}</button>
</form>
<div class="suggest" id="suggest" hidden></div>
</div>
${bookmarkItems ? `<h2 class="section-label"><span class="label-mark">${BOOKMARK_ICON}</span>Bookmarks${labelInfo(BOOKMARKS_NOTE)}</h2>
<section class="grid">${bookmarkItems}</section>` : '<p class="empty">No shared bookmarks yet.</p>'}
${automationCards ? `<h2 class="section-label"><span class="label-mark">${WORKFLOW_ICON}</span>Automations${labelInfo(AUTOMATIONS_NOTE)}</h2>
<section class="auto-grid">${automationCards}</section>` : ''}
<h2 class="section-label"><span class="label-mark">${SHIELD_ICON}</span>Session</h2>
<section class="session-shell">
<div class="session-head">${statusChip}<span class="session-actions">${run && recheckable ?
  `<button type="button" class="pill" id="recheck">${REFRESH_ICON}<span id="recheck-label">Re-check</span></button>` :
  ''}<a class="icon-button" href="https://ip.me/" title="Check this session on ip.me" aria-label="Check this session on ip.me">${EXTERNAL_ICON}</a></span></div>
<div class="session" id="session" data-tone="${proxyStatus.ok ? 'ok' : 'bad'}">
<dl class="session-fields">
<div class="field wide"><dt>${rowIcon('proxy')}Proxy</dt><dd class="sentence" id="proxy-line">${proxyStatus.ok ?
  escapeHtml(proxyStatus.detail) :
  `<strong>${escapeHtml(proxyStatus.title)}</strong>${escapeHtml(proxyStatus.detail)}`}</dd></div>
<div class="field"><dt>${rowIcon('platform')}Platform</dt><dd>${platform}</dd></div>
<div class="field wide"><dt>${rowIcon('cookies')}Cookies</dt><dd>${cookieLabel}</dd></div>
</dl>
</div>
</section>
</main>
<script>
/* The page's calls back to the launcher. Same constraint as the search logic
   below: this document is written to disk and loaded from file://, so the
   behaviour has to travel inside it.

   RUN.token authorizes exactly three things -- run one of the automations
   listed above against this profile, open one of those same automations in the
   launcher window, and re-check this profile's assigned proxy. It cannot
   create, edit or delete anything, cannot read another run, cannot mint keys
   and cannot supply its own steps or its own proxy: every request carries
   nothing but an id the launcher already knows.

   It is a plain constant on purpose: not in the URL, not in localStorage, not
   in a <meta> tag. Those are the three places a later navigation to a hostile
   page could plausibly reach; a closure variable in a file:// document is not
   readable across origins, and the browser does not run with
   --allow-file-access-from-files (checked before this shipped). */
${run ? `(function () {
  var RUN = ${JSON.stringify(run)};

  /* Required by the launcher on every one of these routes: a cross-origin
     <form> POST cannot set this header, so a hostile page has to send a
     preflight that is never answered. */
  function post(path, body) {
    return fetch('http://127.0.0.1:' + RUN.port + path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (d) { return {ok: r.ok, body: d}; });
    });
  }

  /* The card's state, and the timer that clears it. Held per card so two cards
     settling at different times cannot cancel each other's revert. */
  function settle(card, state) {
    card.dataset.state = state;
    if (card.revertTimer) { clearTimeout(card.revertTimer); }
    card.revertTimer = setTimeout(function () {
      card.revertTimer = 0;
      card.dataset.state = 'idle';
    }, 4000);
  }

  var cards = document.querySelectorAll('.auto-card');
  Array.prototype.forEach.call(cards, function (card) {
    card.querySelector('.auto-run').addEventListener('click', function () {
      if (card.dataset.state === 'running') { return; }
      if (card.revertTimer) { clearTimeout(card.revertTimer); card.revertTimer = 0; }
      card.dataset.state = 'running';
      post('/v1/automations/run-from-page', {runToken: RUN.token, automationId: card.dataset.id})
        .then(function (result) {
          /* The launcher answers identically for every refusal, so there is
             nothing more specific to say here than that it did not start. */
          settle(card, result.ok && result.body.status ? 'done' : 'failed');
        })
        .catch(function () { settle(card, 'failed'); });
    });

    /* Raises the launcher window with this workflow open, for when the answer
       to "what does this actually do" is a thing only the editor can show. It
       changes nothing here, so the card keeps its state either way -- and a
       failure is silent because the only visible consequence of success is a
       different window coming to the front, which the user is about to notice
       or not regardless of what this card says. */
    card.querySelector('.auto-open').addEventListener('click', function () {
      post('/v1/automations/open-in-launcher',
          {runToken: RUN.token, automationId: card.dataset.id})
        .catch(function () {});
    });
  });

  /* Re-checking the proxy. The launcher answers with the same
     {title, detail} homeProxyStatus composed at launch, re-run against the
     fresh result -- so this repaints the line the page opened with rather than
     wording a second opinion of its own. The four-row exit/location/timezone/
     device readout that comes back with it is the side panel's to draw; this
     card shows the sentence. */
  var recheck = document.getElementById('recheck');
  if (recheck) {
    var label = document.getElementById('recheck-label');
    var line = document.getElementById('proxy-line');
    var sessionCard = document.getElementById('session');
    recheck.addEventListener('click', function () {
      if (recheck.disabled) { return; }
      recheck.disabled = true;
      label.textContent = 'Checking';
      post('/v1/proxies/recheck-from-page', {runToken: RUN.token})
        .then(function (result) {
          if (!result.ok || !result.body.status) {
            /* The launcher's own words, not a sentence invented here. Every
               refusal on this route already carries one -- "EasyDeck Launcher is
               not open", "Too many requests", "That profile is no longer in
               this workspace" -- and each names something the person reading
               this page can act on. They used to be thrown away and replaced
               with the generic line below, which is why a re-check that failed
               for a knowable reason looked exactly like one that failed for an
               unknowable one. */
            var refusal = new Error(result.body.msg ||
                'The launcher refused the check without saying why.');
            /* Marks this as an answer rather than a transport failure. Without
               it the catch below cannot tell our sentence from fetch()'s own
               "Failed to fetch", and would print that at the reader. */
            refusal.fromLauncher = true;
            throw refusal;
          }
          sessionCard.dataset.tone = result.body.proxyOk ? 'ok' : 'bad';
          line.textContent = '';
          if (!result.body.proxyOk) {
            var title = document.createElement('strong');
            title.textContent = result.body.title || '';
            line.appendChild(title);
          }
          line.appendChild(document.createTextNode(result.body.detail || ''));
        })
        .catch(function (error) {
          /* Deliberately not painted as a failing proxy: the check did not
             finish, which is not the same as the proxy being dead, and saying
             so would be the page inventing a verdict.

             The fallback sentence is for the one case with nothing to report --
             fetch() itself rejecting, i.e. the launcher's server not answering
             at all. It used to cover every failure here, including ones the
             launcher had explained in full. */
          sessionCard.dataset.tone = 'bad';
          line.textContent = error && error.fromLauncher ? error.message :
            'The check did not complete. Try again from the EasyDeck panel.';
        })
        .then(function () {
          recheck.disabled = false;
          label.textContent = 'Re-check';
        });
    });
  }
}());` : ''}
/* A copy of looksLikeUrl/resolveQuery from lib/searchEngines.ts, not an import.
   This document is written to disk and loaded from file:// -- it has no module
   graph and no bundler, so the logic has to travel inside it. If the heuristic
   below changes, change it in both places.

   The engine is baked in at generation time from the choice made in the
   launcher; there is no picker here on purpose. The only values interpolated
   into this script are that fixed engine record and constants, and the typed
   query is encoded before it is used. */
(function () {
  var ENGINE = ${JSON.stringify(engine)};
  var SUGGEST = ${JSON.stringify(engine.id === 'google')};
  var form = document.getElementById('search');
  var input = form.querySelector('input');
  var box = document.getElementById('suggest');
  /* The suggestion list, which of its rows is highlighted, the input debounce
     and a request counter. Declared up here because the submit handler below
     reads the first two. */
  var items = [], active = -1, timer = null, seq = 0;
  /* host:port is not a scheme -- see normalizeBookmarkUrl in lib/bookmarks.ts. */
  function hasScheme(text) {
    return /^[a-z][a-z0-9+.-]*:/i.test(text) &&
        !/^[a-z0-9.-]+:\\d+([/?#]|$)/i.test(text);
  }
  function looksLikeUrl(text) {
    if (hasScheme(text)) return true;
    if (/\\s/.test(text)) return false;
    if (/^localhost(:\\d+)?([/?#]|$)/i.test(text)) return true;
    if (/^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?([/?#]|$)/.test(text)) return true;
    return /^[^\\s/?#@]+\\.[a-z]{2,}(:\\d+)?([/?#]|$)/i.test(text);
  }
  function go(text) {
    text = text.trim();
    if (!text) return;
    if (looksLikeUrl(text)) {
      location.href = hasScheme(text) ? text : 'https://' + text;
      return;
    }
    location.href = ENGINE.searchUrl.replace('%s', encodeURIComponent(text));
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    go(active >= 0 && items[active] ? items[active] : input.value);
  });

  /* ---- Suggestions ----------------------------------------------------
     Google's completion endpoint sends no CORS header, so fetch() from a
     file:// page is refused. It does honour ?callback=, so the request goes out
     as an injected script element instead -- the one cross-origin read a file://
     document is allowed. (Never write a closing script tag in this file: it
     would end the block early.) It is an undocumented endpoint and may change,
     which is why every failure here is silent: no suggestions is a fine state,
     and the search box works exactly the same without them.

     Only for Google. Sending what you type to Google while DuckDuckGo is the
     selected engine would be a surprise, so the other engines get no
     suggestions rather than the wrong provider's. */
  function render() {
    if (!items.length) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.textContent = '';
    items.forEach(function (text, index) {
      var row = document.createElement('div');
      row.textContent = text;
      if (index === active) row.className = 'on';
      /* mousedown, not click: the input's blur fires first on click and would
         have already hidden the list. */
      row.addEventListener('mousedown', function (event) {
        event.preventDefault();
        go(text);
      });
      box.appendChild(row);
    });
    box.hidden = false;
  }

  function close() {
    items = [];
    active = -1;
    render();
  }

  function request(query) {
    var id = ++seq;
    var name = '__montiSuggest' + id;
    var script = document.createElement('script');
    window[name] = function (data) {
      /* A slower earlier request can land after a faster later one; only the
         newest query may paint. */
      if (id === seq) {
        items = (data && data[1] ? data[1] : []).slice(0, 8);
        active = -1;
        render();
      }
    };
    function cleanup() {
      delete window[name];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    script.onload = cleanup;
    script.onerror = cleanup;
    script.src = 'https://suggestqueries.google.com/complete/search?client=chrome&callback=' +
        name + '&q=' + encodeURIComponent(query);
    document.head.appendChild(script);
  }

  input.addEventListener('input', function () {
    if (!SUGGEST) return;
    var text = input.value.trim();
    if (timer) clearTimeout(timer);
    /* Nothing to complete for a url the user is typing out in full, and no
       reason to hand it to Google either. */
    if (!text || looksLikeUrl(text)) {
      close();
      return;
    }
    timer = setTimeout(function () { request(text); }, 120);
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (!items.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      var step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + items.length + 1) % (items.length + 1);
      /* The extra slot is "no selection", so arrowing past either end returns
         the user to what they actually typed. */
      if (active === items.length) active = -1;
      render();
    }
  });

  input.addEventListener('blur', close);
})();
</script>
</body>
</html>`;
}
