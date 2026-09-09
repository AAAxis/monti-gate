// The Scout Panel: one side panel describing one browser session.
//
// Replaces the toolbar popup this extension used to open. Everything that popup
// could do is still here, plus the proxy readout the generated start page used
// to carry alone and the automations this launch may run.
//
// Two sources of truth, both owned elsewhere:
//   - background.js's message API (get-status, get-session, sync-now,
//     set-paused, pull-from-launcher, save-as-set, export-cookies,
//     import-cookies, recheck-proxy, run-automation). See that file's SyncState
//     comments for the authoritative field contract.
//   - scout-session.json, written per launch by the launcher's
//     built-in-extensions.cjs from its own homeProxyStatus() output. The panel
//     renders that object; it never composes proxy wording of its own, so the
//     panel and the start page cannot describe one session two ways.
//
// The one thing this must do that the popup did not: stay honest while it is
// open. A popup lived for seconds and could read once; a panel is open for
// hours beside a working session, and every count and every state in it would
// otherwise go stale without ever looking stale.
const $ = (selector) => document.querySelector(selector);

// send() never lets a thrown/rejected sendMessage (the background worker being
// evicted mid-call, or "Extension context invalidated" during a reload) leave a
// caller awaiting forever -- every caller gets a {ok:false, error} shape back
// either way, which is what makes "no action may leave a spinner running"
// enforceable.
async function send(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response || {ok: false, error: 'No response from the extension background.'};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
}

function setStatus(text, isError) {
  $('#status').textContent = text || '';
  $('#status').className = isError ? 'status error' : 'status';
}

// Both live in sync-status.js so the branch ordering below can be tested; see
// that file's header for why it is a separate script.
const {classifySync, relativeTime} = ScoutSyncStatus;

// Why a launcher-backed read came back empty, in words, every time.
//
// The two workspace lists (automations, cookie sets) both went in reporting
// their failures as "there is nothing here", which is the single worst thing a
// list can do: an unreachable launcher, a background script from a previous
// build and a genuinely empty workspace all painted the same empty state, and
// the only one of the three the user can act on is the one they could not tell
// apart from the others.
//
// 'Unknown message' is background.js's own answer for a message type its switch
// does not have, which means exactly one thing: this profile is running a
// background.js from before these routes existed. Chrome caches an unpacked
// extension's service worker script against its directory path
// (built-in-extensions.cjs says so at length), so a profile that has already
// launched can keep running the old worker even after the launcher ships a new
// one. It is the single most likely reason either list is empty right after an
// upgrade, and it is fixed by relaunching the profile -- which nothing on
// screen would have told anyone.
const STALE_WORKER_REASON =
  'This window is running an older version of the Monti Helper background ' +
  'script, which does not have this feature yet. Close the profile and launch ' +
  'it again from Scout Web.';

function failureReason(result) {
  const error = (result && result.error) || '';
  if (error === 'Unknown message') {
    return STALE_WORKER_REASON;
  }
  if (result && result.available === false) {
    return 'This window was not launched from Scout Web.';
  }
  return error || 'Scout Web did not answer.';
}

ScoutIcons.hydrate(document, 14);

// The tab strip. Created before any render function runs -- renderSync and
// renderProxy publish their tone to it, and renderAutomations decides whether
// its tab exists at all, so it has to be here rather than beside the first
// paint at the bottom of this file. See tabs.js for why the tone is passed in
// rather than computed there.
const tabs = ScoutTabs.create({strip: $('[role="tablist"]')});

// ── Session ────────────────────────────────────────────────────────────────────
// The launch snapshot: profile, theme, proxy verdict, automations. Null when the
// extension is running outside a profile launch, which is the panel's cue to say
// so rather than to invent a session.
let session = null;

// Rebuilt wholesale on every paint rather than patched in place: a re-check that
// moves the exit moves the location, the timezone and the verdict with it, and
// rows still describing the previous answer are worse than no rows.
//
// textContent per cell, never innerHTML -- these values come off a proxy row and
// a fingerprint, both user-supplied, and this page has no framework escaping
// them for it.
function renderProxyFields(fields) {
  const list = $('#proxy-fields');
  list.replaceChildren();
  list.hidden = !fields || !fields.length;
  // The frame follows the rows, for the reason the automations group does: a
  // heading over an empty inset reads as a load that failed. A failed re-check
  // has a sentence and no rows, and the card above is where that sentence goes.
  $('#proxy-fields-group').hidden = list.hidden;
  for (const field of fields || []) {
    const row = document.createElement('div');
    row.className = field.mono ? 'field mono' : 'field';

    const label = document.createElement('dt');
    // The glyph is looked up by the name the launcher put on the field, never
    // built from it -- ScoutIcons.make() indexes a fixed table and falls back to
    // a circle, so a field naming an icon this panel does not carry draws a
    // placeholder rather than nothing. Guarded on presence because a session
    // snapshot written by an older launcher has no `icon` at all, and those rows
    // still have to render.
    if (field.icon) {
      label.appendChild(ScoutIcons.make(field.icon, 13));
    }
    label.appendChild(document.createTextNode(field.label));

    const value = document.createElement('dd');
    const text = document.createElement('span');
    text.className = 'v';
    text.textContent = field.value;
    text.title = field.value;
    value.appendChild(text);

    if (field.note) {
      const note = document.createElement('span');
      note.className = 'note';
      // No data-tone unless the field asked for one: a latency is a neutral
      // trailing value, and toning it would paint every session's ping green.
      if (field.noteTone) note.setAttribute('data-tone', field.noteTone);
      note.textContent = field.note;
      value.appendChild(note);
    }

    row.append(label, value);
    list.appendChild(row);
  }
}

// `status` is a homeProxyStatus() result: {ok, title, detail, fields?}.
//
// Three tones from two facts. `ok` is about the proxy itself -- it answered its
// last check -- but a row can still carry a verdict of its own, and today
// exactly one does: a timezone that disagrees with the exit's location. A
// session can have a perfectly healthy proxy and still be trivially detectable
// because of it, so a green card reading "Anti-detect proxy active" directly
// above a red "≠ Europe/Berlin" was the panel contradicting itself at a glance.
// Amber is the honest middle: the connection works, and something below needs
// looking at.
//
// The card is not allowed to call this a failure. Whether the proxy is up is
// homeProxyStatus()'s judgement, made in the launcher against a real check, and
// the panel must not overrule it from a note.
function renderProxy(status) {
  const flagged = (status.fields || []).some((field) => field.noteTone === 'bad');
  const tone = !status.ok ? 'bad' : (flagged ? 'warn' : 'ok');
  $('#proxy-card').className = `card tone-${tone}`;
  // The same verdict on the tab, because behind a tab this card is invisible.
  tabs.setTone('session', tone);
  $('#proxy-icon').replaceChildren(
      ScoutIcons.make(tone === 'ok' ? 'checkCircle' : 'alertTriangle', 16));
  $('#proxy-icon').classList.remove('spin');
  $('#proxy-title').textContent = status.title;
  // The rows say everything `detail` says, better -- it is the one-line form
  // kept for surfaces that render no rows at all. Hidden rather than blanked so
  // a failing re-check, which has a sentence and no rows, gets it straight back.
  const detail = $('#proxy-detail');
  detail.textContent = status.detail;
  detail.hidden = Boolean(status.fields && status.fields.length);
  renderProxyFields(status.fields);
}

// Nothing was launched: no proxy verdict exists to show, and inventing "no
// proxy" would be a claim about the session rather than about this window.
function renderProxyUnavailable() {
  $('#proxy-card').className = 'card';
  // Mirrors the bare className above: no session to report on is an absence of
  // signal, not a fault, so the tab stays unmarked.
  tabs.setTone('session', 'off');
  $('#proxy-icon').replaceChildren(ScoutIcons.make('circle', 16));
  $('#proxy-icon').classList.remove('spin');
  $('#proxy-title').textContent = 'No session details';
  $('#proxy-detail').textContent =
      'This window was not launched from Scout Web, so there is no proxy to report on.';
  renderProxyFields(null);
  $('#recheck').disabled = true;
  $('#recheck').title = 'Relaunch this profile from Scout Web to re-check its proxy.';
}

$('#recheck').addEventListener('click', () => {
  const button = $('#recheck');
  if (button.disabled) return;
  const icon = button.querySelector('.icon');
  button.disabled = true;
  icon.classList.add('spin');
  $('#proxy-icon').replaceChildren(ScoutIcons.make('loader', 16));
  $('#proxy-icon').classList.add('spin');
  $('#proxy-title').textContent = 'Checking proxy…';

  void (async () => {
    const result = await send({type: 'recheck-proxy'});
    button.disabled = false;
    icon.classList.remove('spin');
    if (!result.ok) {
      // A refused or unanswered request says nothing about the proxy itself, so
      // the panel goes back to what it knew rather than inventing a verdict it
      // does not have.
      if (session) renderProxy(session.proxy);
      setStatus(result.error || 'Could not re-check this proxy', true);
      return;
    }
    // The launcher recorded this check against the proxy row before answering,
    // so the Proxies tab and every other profile on it now agree with what the
    // panel is about to say. Kept on `session` so a later failed re-check falls
    // back to the fresh answer rather than to the launch-time one.
    const status = {
      ok: result.proxyOk, title: result.title, detail: result.detail, fields: result.fields,
    };
    if (session) session.proxy = status;
    renderProxy(status);
    setStatus(result.proxyOk ? 'Proxy re-checked' : 'Proxy re-checked — it is not working');
  })();
});

// ── Automations ────────────────────────────────────────────────────────────────
// Two independent things share this tab, and the split matters:
//
//   the LIST -- every automation in this window's WORKSPACE, not only the ones
//   this launch was handed. It was the latter for as long as the run token
//   authorized only what the launcher put in it; the panel now asks the
//   launcher for the workspace's own list and can start any of it, so a
//   teammate's workflow is reachable from inside the browser. Painted twice:
//   once from the launch snapshot, which needs no launcher, then again from the
//   live answer. Assigned and pinned rows sort first and say so.
//
//   the CARD -- what is running against this profile right now, wherever it was
//   started from: this panel, the launcher's own Run button, a schedule, an MCP
//   tool. Polled, and deliberately not scoped to the list -- a profile with
//   nothing pinned can still have a live run worth watching.
//
// The tab itself is always on screen. Hiding it when the list was empty meant
// someone who had never pinned a workflow could not discover the tab existed, so
// could not find out how to get one -- and a run started from the launcher had
// nowhere here to report.

// The last answer from the status poll. Held so a failed poll can leave the card
// exactly as it was rather than blanking it -- a launcher being restarted should
// not look like a run disappearing.
//
// Declared above renderAutomations, which paints from it: `let` is not hoisted
// past its initializer, and renderAutomations runs from loadSession() at the
// bottom of this file.
let runState = {run: null, last: null};
// Set while this panel is waiting on its own run-automation call, before the
// first poll has had a chance to see it. Without it the row springs back to
// "Run" for up to a second after the click and reads as a button that did
// nothing.
let startingId = '';

// The six colour KEYS an automation can carry, and nothing else.
//
// A stored colour is one of these or a custom hex. Keys resolve through
// --profile-*-ink in sidepanel.css, which exists in both themes; a hex needs no
// resolution and is applied inline. Anything that is neither -- a key this
// build does not know, a malformed string -- draws in the inherited ink rather
// than being interpolated into a style, which is the whole reason this list is
// a fixed allowlist and not a passthrough.
const COLOR_KEYS = new Set(['slate', 'blue', 'green', 'violet', 'red', 'amber']);
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

// Assigned first, then pinned, then everything else; alphabetical inside each
// group.
//
// The list is the whole workspace now, which for a real team is dozens of rows.
// The two this launch would have offered on its own are the ones the person in
// front of this window is most likely to want, so they go to the top -- and
// they carry a badge as well, because after two scrolls "it was near the top"
// is not something anyone can see.
function automationRank(automation) {
  if (automation.assigned) return 0;
  if (automation.pinned) return 1;
  return 2;
}

function sortAutomations(automations) {
  return [...automations].sort((a, b) =>
    automationRank(a) - automationRank(b) ||
    String(a.name || '').localeCompare(String(b.name || '')));
}

// Rows, not the start page's tiles: a 320px column fits one tile across, which
// is a list with extra steps.
//
// `automations` is either the launch snapshot ({id, name} only, painted first
// because it works with the launcher closed) or the live workspace list, which
// adds pinned/assigned/colour. Both shapes render; the snapshot simply produces
// rows with no badge and no tint, which is what it has always looked like.
function renderAutomations(automations) {
  const list = $('#automation-list');
  list.replaceChildren();
  const offered = sortAutomations(automations || []);
  // The empty state stands in for the list, not for the tab. The card above it is
  // independent and may still have something to show.
  $('#automations-empty').hidden = offered.length > 0;
  // The frame goes with the list, not with the tab: an empty group is a grey
  // box with a heading and nothing under it, which reads as something that
  // failed to load rather than as an absence the empty state below already
  // explains in words.
  $('#automation-group').hidden = offered.length === 0;
  // How many, and how many of those are this launch's own. The count answers
  // "is this everything?" -- the question a list that used to hold two rows and
  // now holds forty invites, and the one the rows cannot answer between them.
  const mine = offered.filter((item) => item.assigned || item.pinned).length;
  $('#automation-count').textContent = offered.length ?
    `${offered.length} in this workspace${mine ? ` · ${mine} for this profile` : ''}` :
    '';
  // And it says WHICH empty this is. "No automations in this workspace" is a
  // claim about the workspace, and it is only ours to make when the launcher
  // actually answered; otherwise the honest statement is that we could not ask.
  if (!offered.length) {
    const failed = Boolean(automationsError);
    $('#automations-empty-title').textContent = failed ?
      'Could not read this workspace' :
      'No automations in this workspace';
    $('#automations-empty-detail').textContent = failed ?
      automationsError :
      'Build a workflow in Scout Web and it will show up here. Anything your ' +
        'team creates appears in this list too — pinning one, or setting it as ' +
        'this profile’s own, just moves it to the top.';
  }
  for (const automation of offered) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'automation';
    row.dataset.id = automation.id;
    row.dataset.state = 'idle';
    row.title = `Run ${automation.name}`;

    const icon = document.createElement('span');
    icon.className = 'icon';
    ScoutIcons.set(icon, 'play', 14);
    // Two spellings of the same field, because the launcher stores both. A key
    // becomes an attribute the stylesheet matches; a hex is set directly. Note
    // what is NOT done: an unrecognized value is dropped rather than written
    // into style.color, so nothing off an automation row reaches CSS.
    const color = String(automation.color || '').trim();
    if (COLOR_KEYS.has(color)) {
      row.dataset.color = color;
    } else if (HEX_COLOR.test(color)) {
      icon.style.color = color;
    }

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = automation.name;

    row.append(icon, label);

    // Only for the two that mean something. "Assigned" is what this profile
    // runs on launch; "Pinned" is what the workspace put on every start page.
    // A row that is both says assigned, which is the stronger and more specific
    // of the two -- and the sort has already put it above the merely pinned.
    const kind = automation.assigned ? 'assigned' : (automation.pinned ? 'pinned' : '');
    if (kind) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset.kind = kind;
      badge.textContent = kind === 'assigned' ? 'Assigned' : 'Pinned';
      row.append(badge);
      row.title = kind === 'assigned' ?
        `Run ${automation.name} — this profile's own automation` :
        `Run ${automation.name} — pinned for this workspace`;
    }
    // The description is not drawn -- there is no room for a second line at
    // 320px -- but it is worth having on hover for a list of forty workflows
    // whose names are all four words long.
    if (automation.description) {
      row.title = `${row.title}\n\n${automation.description}`;
    }
    list.appendChild(row);
  }
  // A row for a run already in flight has to look like one the moment it is
  // drawn, not one poll later: loadSession() builds this list while a run may
  // already be going.
  paintRunCard();
}

// The live list, replacing the launch snapshot's.
//
// Quiet on failure, deliberately. The snapshot is already on screen and is
// perfectly usable -- it is what this panel showed for its entire life before
// this route existed -- so a closed launcher or a refused token leaves it
// standing rather than blanking the tab or painting an error over a list that
// works. The only visible consequence is that a teammate's workflow is missing,
// which is the state the panel was permanently in before.
let liveAutomations = null;
// Why the live list is not on screen, or '' when it is. Read by the empty
// state, which must not say "this workspace has no automations" on the strength
// of a request that never arrived.
let automationsError = '';

async function loadAutomations() {
  const result = await send({type: 'list-automations'});
  if (!result.ok || !Array.isArray(result.automations)) {
    automationsError = failureReason(result);
    // The snapshot's rows, if there were any, stay exactly where they are --
    // they work with the launcher closed and are still true. Only the empty
    // state changes, and only to stop claiming something it cannot know.
    renderAutomations(liveAutomations || (session && session.automations) || []);
    return;
  }
  automationsError = '';
  liveAutomations = result.automations;
  renderAutomations(liveAutomations);
}

function paintRunCard() {
  const view = ScoutRunView.describe(runState.run || runState.last, Date.now());
  const card = $('#run-card');
  card.hidden = !view;
  // The tab's dot, from the same tone the card is painted in -- so a run that
  // fails while the reader is on Cookies still says so. Cleared to 'off' with no
  // card, since tabs.js only marks warn and bad.
  tabs.setTone('automations', view ? view.tone : 'off');
  // Rows reflect the live run only: a finished one is reported by the card, and
  // leaving its row spinning would say it was still going.
  for (const row of $('#automation-list').querySelectorAll('button.automation')) {
    const live = Boolean(runState.run) && runState.run.automationId === row.dataset.id;
    const running = live || row.dataset.id === startingId;
    row.dataset.state = running ? 'running' : 'idle';
    const icon = row.querySelector('.icon');
    if (running && icon.dataset.icon !== 'loader') {
      ScoutIcons.set(icon, 'loader', 14);
      icon.classList.add('spin');
    } else if (!running && icon.dataset.icon !== 'play') {
      ScoutIcons.set(icon, 'play', 14);
      icon.classList.remove('spin');
    }
    // A second run against the same profile is refused by the runner (409), so
    // offering the button would be offering a click that cannot succeed.
    row.disabled = Boolean(runState.run) || Boolean(startingId);
  }
  if (!view) {
    return;
  }
  card.className = `card run-card tone-${view.tone}`;
  const icon = $('#run-icon');
  icon.replaceChildren(ScoutIcons.make(view.icon, 16));
  icon.classList.toggle('spin', view.spin);
  $('#run-title').textContent = view.title;
  $('#run-step').textContent = view.step;
  $('#run-meta').textContent = view.meta;
  // Only a live run can be stopped. The button goes away rather than greying out:
  // a disabled Stop under a card reading "finished" is a control with nothing
  // left to do.
  $('#run-stop').hidden = !view.live;

  const bar = $('#run-bar');
  bar.dataset.indeterminate = view.bar.indeterminate ? 'true' : 'false';
  $('#run-bar-fill').style.width = view.bar.indeterminate ? '' : `${view.bar.percent}%`;
  if (view.bar.indeterminate) {
    bar.removeAttribute('aria-valuenow');
  } else {
    bar.setAttribute('aria-valuenow', String(view.bar.percent));
  }
  // The bar is decoration for a sighted reader and a duplicate for everyone else
  // -- the title and the meta line already say all of this in words. Naming it
  // keeps a screen reader from announcing a bare percentage with no subject.
  bar.setAttribute('aria-label', view.title);
}

// ~1s while something is live, and that cadence is what STATUS_RATE in
// run-token.cjs is sized for. The panel goes quiet when there is nothing moving:
// a poll every second for the hours this panel sits open beside an idle session
// would be a loopback request per second forever, to learn nothing.
//
// Two things wake it back up: this panel starting a run, and the tab being
// opened. Neither is the whole story -- a run started from the launcher while
// this panel sits on the Cookies tab is invisible until something asks -- so the
// idle cadence is slow rather than absent.
const POLL_LIVE_MS = 1000;
const POLL_IDLE_MS = 15000;
let pollTimer = 0;

async function pollRun() {
  const result = await send({type: 'automation-status'});
  // A failed poll leaves the last answer standing. `available: false` is the one
  // failure that is really an answer: this window has no launch credential, so
  // there will never be a run to report and the card should stay away.
  if (result.ok) {
    runState = {run: result.run || null, last: result.last || null};
    // The poll has caught up with our own click, so the optimistic row state can
    // stop standing in for it. Also cleared when the run has already finished by
    // the time the first poll lands, which is why this is not conditional on
    // seeing it live.
    startingId = '';
    paintRunCard();
  } else if (result.available === false) {
    runState = {run: null, last: null};
    startingId = '';
    paintRunCard();
  }
  schedulePoll();
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const live = Boolean(runState.run) || Boolean(startingId);
  pollTimer = setTimeout(() => { pollTimer = 0; void pollRun(); },
      live ? POLL_LIVE_MS : POLL_IDLE_MS);
}

// Opening the tab is the other thing that earns an immediate poll: it is the
// moment someone asks the question, and the slow idle cadence means the answer on
// screen could be fifteen seconds stale. Bound on the strip rather than through
// tabs.js, which deliberately publishes no selection event -- one listener here
// is smaller than a callback tabs.js would have to thread to a single caller.
$('[role="tablist"]').addEventListener('click', (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (!tab) return;
  if (tab.dataset.tab === 'automations') {
    void pollRun();
    // And the list, for the same reason. It is no longer a launch-time constant
    // -- a teammate can create a workflow while this window sits open, and
    // opening the tab is exactly the moment someone asks what exists.
    void loadAutomations();
  }
  if (tab.dataset.tab === 'cookies') {
    // Same argument, one tab over: the library is shared, and a set saved by
    // someone else five minutes ago should be in the picker.
    void loadCookieSets();
  }
});

// The clock in the meta line has to move between polls, or a run whose step takes
// thirty seconds looks stalled at "0:04" for all of them. Repaints from the state
// already held -- no request.
setInterval(() => {
  if (runState.run) paintRunCard();
}, 1000);

$('#automation-list').addEventListener('click', (event) => {
  const row = event.target.closest('button.automation');
  if (!row || row.disabled) return;
  startingId = row.dataset.id;
  paintRunCard();
  setStatus(`Starting ${row.querySelector('.label').textContent}…`);

  void (async () => {
    const result = await send({type: 'run-automation', automationId: row.dataset.id});
    if (result.ok) {
      setStatus(`Started ${row.querySelector('.label').textContent}`);
      // Straight to the live cadence rather than waiting out the idle one: the
      // card is what the user is now looking at.
      void pollRun();
      return;
    }
    startingId = '';
    paintRunCard();
    setStatus(result.error || 'The launcher would not start that automation', true);
  })();
});

$('#run-stop').addEventListener('click', () => withBusy($('#run-stop'), async () => {
  setStatus('Stopping…');
  const result = await send({type: 'cancel-automation'});
  if (!result.ok) {
    setStatus(result.error || 'The launcher would not stop that run', true);
    return;
  }
  // Cancelling is cooperative -- the runner notices at its next step boundary --
  // so this reports that the ask landed, not that the run has ended. The card
  // says when it has.
  setStatus(result.cancelled ?
    'Stopping the run…' :
    'That run had already finished');
  void pollRun();
}));

$('#open-automations').addEventListener('click', () => withBusy($('#open-automations'), async () => {
  const result = await send({type: 'open-automations'});
  if (!result.ok) {
    setStatus(result.error || 'Could not reach Scout Web', true);
  }
}));

// Why every launcher-backed control is off, in one sentence naming the fix. A
// disabled button that does not say why reads as a broken button: three of them
// greyed out at once, with the card above saying only "Sync unavailable", left
// no way to tell a missing feature from a missing launcher.
const SYNC_BLOCKED_REASON =
  'Relaunch this profile from Scout Web to enable these. ' +
  'They each need a credential the Launcher hands out at launch, and this window did not get one.';

// The set this window loaded that it is not assigned to, held so the two
// suppressed-state buttons can name it and target it by id.
let suppressedSetId = '';
let suppressedSetName = '';

function renderSync(sync) {
  const state = classifySync(sync);
  $('#sync-card').className = `card tone-${state.tone}`;
  // classifySync is the sole author of this tone, and now of this tab's dot too.
  tabs.setTone('cookies', state.tone);
  const icon = $('#sync-icon');
  icon.replaceChildren(ScoutIcons.make(state.icon, 16));
  icon.classList.toggle('spin', Boolean(state.spin));
  $('#sync-title').textContent = state.title;
  $('#sync-detail').textContent = state.detail;
  $('#sync-toggle').checked = !sync.paused;
  $('#sync-toggle').disabled = !sync.available;
  $('#sync-now').disabled = !sync.available;
  // Load, Overwrite and the read-only list all act on the picker's selection,
  // so they need BOTH a launcher credential and a picker with something in it.
  // Setting #pull straight from sync.available here is what let a refresh
  // re-enable a Load button over an empty select.
  syncAvailable = Boolean(sync.available);
  applyPickerEnabled();

  // While the push loop is suppressed, "Save to Launcher now" is not a control
  // with nothing to do -- it is a control that would do the WRONG thing, since
  // the assigned set is exactly where these cookies must not go. Hidden behind
  // the two explicit choices instead.
  suppressedSetId = sync.pushSuppressed ? (sync.loadedSetId || '') : '';
  suppressedSetName = sync.pushSuppressed ? (sync.loadedSetName || '') : '';
  const suppressed = Boolean(sync.pushSuppressed) && Boolean(sync.available);
  $('#sync-suppressed').hidden = !suppressed;
  $('#sync-now').hidden = suppressed;
  // The overwrite control is only offered once there is a launcher to overwrite
  // into. It stays available outside the suppressed state too -- "save this
  // session over that set" is a reasonable thing to want at any time -- but it
  // is the only way out of the suppressed one, which is why it is beside it.
  $('#overwrite-wrap').hidden = !sync.available;
  if (suppressed) {
    $('#save-to-loaded').disabled = !suppressedSetId;
    $('#save-to-loaded-label').textContent = suppressedSetName ?
      `Save this session to “${suppressedSetName}”` :
      'Save this session to the loaded set';
    $('#resume-sync-label').textContent = 'Resume syncing to the assigned set';
    // Named on the button AND explained on hover: pressing this overwrites the
    // set the profile launches with, using the jar currently on screen, and
    // there is no undo for either half.
    $('#resume-sync').title =
        'Sends this browser’s current cookies to the set assigned to this profile, ' +
        'replacing what is stored there, and starts syncing again.';
    $('#save-to-loaded').title = suppressedSetName ?
      `Replaces the stored contents of “${suppressedSetName}” with this browser’s cookies.` :
      '';
    syncPickerToSuppressed();
  }
  // Save-as goes over the same run-token route as sync, so it needs the same
  // "was this window launched from Scout Web" precondition -- unlike
  // sync-now/pull it does not also need inSync/paused, since it is not part of
  // the automatic loop.
  $('#save-as-toggle').disabled = !sync.available;

  const blocked = $('#sync-blocked');
  blocked.textContent = sync.available ? '' : SYNC_BLOCKED_REASON;
  blocked.hidden = Boolean(sync.available);
  // Also on the controls themselves: the note sits in the card at the top of
  // the section, and the buttons it explains are most of a screen away.
  const tip = sync.available ? '' : SYNC_BLOCKED_REASON;
  for (const id of ['#sync-now', '#pull', '#save-as-toggle']) {
    $(id).title = tip;
  }
  // The form can be left open across a refresh that revokes sync; collapsing it
  // keeps the panel from offering a Save that cannot succeed.
  if (!sync.available) closeSaveAsForm();
}

function renderSeed(seed) {
  const container = $('#seed-status');
  if (seed.imported) {
    ScoutIcons.set($('#seed-icon'), 'checkCircle', 14);
    const when = seed.seededAt ? ` on ${new Date(seed.seededAt).toLocaleDateString()}` : '';
    $('#seed-text').textContent =
        `${seed.seededCount} cookie${seed.seededCount === 1 ? '' : 's'} auto-imported${when}`;
    container.className = 'note-line seeded';
  } else {
    ScoutIcons.set($('#seed-icon'), 'circle', 14);
    $('#seed-text').textContent = 'No seed cookies for this profile';
    container.className = 'note-line';
  }
}

// The outcome of the last manual file import, named and kept on screen.
//
// As transient status-bar text this only ever said "Imported 7 of 7 cookies",
// which never named the file it came from and was gone the moment anything else
// set a status. Picking a file and getting no durable acknowledgement that names
// it is the difference between "it worked" and "did that do anything?".
function renderImportResult(result) {
  const container = $('#import-result');
  if (!result) {
    container.hidden = true;
    return;
  }
  const {fileName, imported, total, failed} = result;
  const ok = imported > 0 && !failed;
  ScoutIcons.set($('#import-result-icon'),
      ok ? 'checkCircle' : (imported ? 'alertTriangle' : 'xCircle'), 14);
  const counted = `${imported} of ${total} cookie${total === 1 ? '' : 's'}`;
  $('#import-result-text').textContent = failed ?
    `Imported ${counted} from “${fileName}” — ${failed} rejected` :
    `Imported ${counted} from “${fileName}”`;
  container.className = `note-line ${ok ? 'seeded' : 'failed'}`;
  container.hidden = false;
}

function renderCounts(counts) {
  $('#total-count').textContent = String(counts.total);
  // No siteDomain means the active tab isn't a real http(s) site (an internal
  // chrome:// or extension page) -- "0" there reads as "zero cookies on this
  // site", which overstates what is known. An em-dash says the count does not
  // apply, the same idea as background.js's empty-domain contract for this state.
  $('#site-count').textContent = counts.siteDomain ? String(counts.site) : '—';
  $('#site-label').textContent = counts.siteDomain || 'This site';
}

// Read by openSaveAsForm() for the prefilled default name.
let currentProfileName = '';

// The last manual import this panel performed, or null. Survives refresh()
// (which repaints everything) for as long as the panel is open.
let lastImport = null;

async function refresh() {
  const status = await send({type: 'get-status'});
  if (!status || !status.sync) {
    renderSync({
      available: false, reachable: false, paused: false, inSync: false, pushPending: false,
      lastError: (status && status.error) || 'Could not load status from the extension background.',
      lastErrorKind: 'internal', pushedAt: 0, pushedCount: 0, lastSet: '',
    });
    renderSeed({imported: false});
    renderCounts({total: 0, site: 0, siteDomain: ''});
    renderImportResult(lastImport);
    return;
  }
  currentProfileName = (status.profile && status.profile.name) || '';
  renderSync(status.sync);
  renderSeed(status.seed);
  renderCounts(status.counts);
  renderImportResult(lastImport);
}

// The launch snapshot, read once: nothing in it changes while the window lives.
// The proxy verdict inside it does change, but only because the user asked for a
// re-check, which updates `session` in place.
async function loadSession() {
  const result = await send({type: 'get-session'});
  session = (result && result.session) || null;
  if (!session) {
    renderProxyUnavailable();
    renderAutomations([]);
    return;
  }
  // Unresolved on purpose: 'system' has to stay 'system' so prefers-color-scheme
  // keeps deciding, on a machine whose appearance can change while this panel is
  // open. See sidepanel.css's note on the two :root blocks.
  document.documentElement.dataset.theme = session.theme || 'system';
  if (session.profile && session.profile.name) {
    $('#profile-name').textContent = session.profile.name;
    document.title = `${session.profile.name} — Monti Helper`;
    // And the id, on the Session card. Not the name again -- the heading three
    // lines above already says that, and a second copy would be decoration.
    // The id is what a person needs when two profiles share a name, which is
    // legal and happens: it is the directory this window runs out of and the
    // string an MCP call or a support question names.
    if (session.profile.id) {
      $('#session-profile-id').textContent = session.profile.id;
      $('#session-profile').hidden = false;
    }
  }
  renderProxy(session.proxy);
  // Direct and free-proxy profiles have no assigned proxy to re-test, so the
  // button would be a control with nothing behind it.
  $('#recheck').disabled = !session.recheckable;
  if (!session.recheckable) {
    $('#recheck').title = 'This profile has no assigned proxy to re-check.';
  }
  renderAutomations(session.automations);
}

// ── Toolbar icon ────────────────────────────────────────────────────────────────
// The action icon is a bitmap Chrome will not re-tint, so background.js keeps
// two inks and picks one. Before the panel is ever opened it can only go on the
// appearance the launcher resolved at launch; this is the better answer, because
// prefers-color-scheme here is this browser's own, evaluated by the engine that
// paints the toolbar.
//
// Reported on open and on every flip, so an OS appearance change mid-session
// does not leave the button inked for the theme before it. Fire-and-forget: a
// worker that was evicted mid-send costs a mismatched icon until the next open,
// which is not worth surfacing to the user.
function reportToolbarTheme(dark) {
  void send({type: 'toolbar-theme', dark});
}
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
reportToolbarTheme(darkQuery.matches);
darkQuery.addEventListener('change', (event) => reportToolbarTheme(event.matches));

// ── Staying honest while open ───────────────────────────────────────────────────
// The panel outlives every event that used to justify a re-read. These three
// subscriptions are what keep a card from quietly describing a session that
// moved on hours ago.

// The sync engine persists every state transition through setSyncState, so this
// repaints off writes that already happen -- no polling, and no second copy of
// the state to keep level with the first.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.scoutSyncState) void refresh();
});

// Debounced for the reason background.js documents: an idle jar fires two
// onChanged events per imported cookie, and a pull of a real set would otherwise
// repaint the counts several hundred times.
let countsTimer = 0;
chrome.cookies.onChanged.addListener(() => {
  if (countsTimer) clearTimeout(countsTimer);
  countsTimer = setTimeout(() => { countsTimer = 0; void refresh(); }, 400);
});

// "This site" is a property of the active tab, and this panel is global to the
// window: it outlives every tab the user opens under it.
chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) void refresh();
});

// ── Actions ─────────────────────────────────────────────────────────────────────
// Disables the button, swaps its icon for a spinner, and always restores both --
// even if `work` throws -- so a message-handler failure can never leave the panel
// with a stuck spinner.
async function withBusy(button, work) {
  const icon = button.querySelector('.icon');
  const original = icon ? icon.dataset.icon : null;
  button.disabled = true;
  if (icon) { ScoutIcons.set(icon, 'loader', 14); icon.classList.add('spin'); }
  try {
    await work();
  } finally {
    button.disabled = false;
    if (icon && original) { ScoutIcons.set(icon, original, 14); icon.classList.remove('spin'); }
  }
}

$('#sync-now').addEventListener('click', () => withBusy($('#sync-now'), async () => {
  setStatus('Saving to Launcher…');
  const result = await send({type: 'sync-now'});
  if (result.ok) {
    setStatus(result.unchanged ?
      'Already in sync with Launcher' :
      `Saved ${result.count ?? 0} cookies to Launcher${result.set ? ` ("${result.set}")` : ''}`);
  } else {
    setStatus(result.error || 'Could not save to Launcher', true);
  }
  await refresh();
}));

$('#sync-toggle').addEventListener('change', async (event) => {
  const resume = event.target.checked;
  event.target.disabled = true;
  try {
    await send({type: 'set-paused', paused: !resume});
    setStatus(resume ? 'Auto-sync resumed' : 'Auto-sync paused');
  } finally {
    await refresh();
  }
});

// ---- the cookie-set picker -------------------------------------------------
// Every set in the workspace, not just the one this profile is assigned.
//
// The single "Load from Launcher" button could only ever apply `cookie_id`,
// which meant a team's whole cookie library was invisible from inside the
// browser -- you could see that a set existed only by switching to the launcher
// and looking. Loading one from here is one-shot: it does NOT re-assign the
// profile, so what this profile launches with next time is unchanged, and the
// hint under the button says so in those words.
//
// Keyed on id, never on name. Two sets can legally share a name (cookie_sets
// has no uniqueness constraint), and cookieSync.ts carries a warning about
// exactly this: a name match is how one profile's action reaches a different
// profile's set.
let cookieSets = [];
let assignedSetId = '';
// Whether the picker has anything in it. Load and Overwrite both act on the
// picker's selection, so both are meaningless without one -- and two enabled
// buttons over an empty select is a panel offering clicks it knows cannot work.
let cookieSetsUsable = false;
// Set by renderSync, read here. The two paints are independent round trips and
// either can land first, so neither can own the enabled state alone: renderSync
// would re-enable Load after renderCookieSets had just found nothing to load.
let syncAvailable = false;

function applyPickerEnabled() {
  const usable = syncAvailable && cookieSetsUsable;
  $('#pull').disabled = !usable;
  $('#overwrite-toggle').disabled = !usable;
  $('#launcher-list-toggle').disabled = !usable;
}

function renderCookieSets(result) {
  const picker = $('#set-picker');
  const line = $('#assigned-set-line');
  const previous = picker.value;
  picker.replaceChildren();

  if (!result || !result.ok) {
    picker.disabled = true;
    // The REASON, not just the fact. This line used to read "Could not read
    // this workspace's cookie sets." for every failure alike -- a timed-out
    // renderer round trip, a launcher that is closed, and a background script
    // from a previous build all produced the same sentence, and none of them
    // told anyone what to do next. The one thing a failed read owes the reader
    // is which of those it was.
    line.textContent = result && result.available === false ?
      '' :
      failureReason(result);
    cookieSets = [];
    cookieSetsUsable = false;
    applyPickerEnabled();
    // The hint under a dead Load button must not go on describing what a
    // working one would do.
    $('#pull-hint').textContent = '';
    return;
  }

  cookieSets = result.sets || [];
  assignedSetId = result.assignedId || '';
  const assigned = cookieSets.find((item) => item.id === assignedSetId);
  line.textContent = assigned ?
    `Launches with “${assigned.name}”` :
    'No cookie set is assigned to this profile.';

  if (!cookieSets.length) {
    picker.disabled = true;
    cookieSetsUsable = false;
    applyPickerEnabled();
    const option = document.createElement('option');
    option.textContent = 'No cookie sets in this workspace';
    picker.appendChild(option);
    $('#pull-hint').textContent =
        'Save this session with “Save to Cookies tab…” to create the first one.';
    return;
  }

  // Assigned first, then alphabetical -- the same ranking the automations list
  // uses, for the same reason: the one this window is actually about should not
  // need looking for.
  const sorted = [...cookieSets].sort((a, b) =>
    (a.id === assignedSetId ? 0 : 1) - (b.id === assignedSetId ? 0 : 1) ||
    String(a.name || '').localeCompare(String(b.name || '')));
  for (const set of sorted) {
    const option = document.createElement('option');
    option.value = set.id;
    const count = `${set.count} cookie${set.count === 1 ? '' : 's'}`;
    // textContent, never innerHTML: a set name is user-supplied and this page
    // has no framework escaping it.
    option.textContent = set.id === assignedSetId ?
      `${set.name} · ${count} · assigned` :
      `${set.name} · ${count}`;
    picker.appendChild(option);
  }
  picker.disabled = false;
  // Keep whatever was selected across a refresh; otherwise start on the set
  // this window is actually holding, and only then on the assigned one.
  //
  // The order matters more than it looks. "Overwrite a cookie set…" targets the
  // picker's selection, so a suppressed window whose picker still pointed at
  // the ASSIGNED set offered a one-click way to write the loaded set's cookies
  // into the assigned one -- precisely the destruction the suppression exists
  // to prevent, reached through a different control. The picker has to name the
  // set the jar came from.
  const keep = cookieSets.some((item) => item.id === previous) ? previous : '';
  picker.value = keep || suppressedSetId || assignedSetId || sorted[0].id;
  cookieSetsUsable = true;
  applyPickerEnabled();
  updatePullHint();
}

// Called when renderSync learns this window is holding a foreign set, because
// the two paints are independent: refresh() and loadCookieSets() are separate
// round trips and either can land first.
function syncPickerToSuppressed() {
  if (!suppressedSetId) return;
  const picker = $('#set-picker');
  if (!cookieSets.some((item) => item.id === suppressedSetId)) return;
  if (picker.value === suppressedSetId) return;
  picker.value = suppressedSetId;
  updatePullHint();
}

// The hint has to change with the selection, because the two cases are
// genuinely different actions. Loading the assigned set restores this window to
// what it launched with; loading any other one leaves the jar and the launcher
// disagreeing, which is why the push loop stops afterwards. Saying "replaces
// this browser's cookies" for both would hide the part that surprises people.
function updatePullHint() {
  const picker = $('#set-picker');
  const chosen = picker.value;
  const hint = $('#pull-hint');
  if (!chosen || chosen === assignedSetId) {
    hint.textContent = 'Replaces this browser’s cookies with the set assigned to this profile.';
    return;
  }
  const set = cookieSets.find((item) => item.id === chosen);
  hint.textContent = set ?
    `Replaces this browser’s cookies with “${set.name}”. One-shot — this profile ` +
        'still launches with its assigned set, and syncing stops until you say where ' +
        'changes should go.' :
    'Replaces this browser’s cookies with the selected set.';
}

$('#set-picker').addEventListener('change', () => {
  updatePullHint();
  // The read-only list is about a specific set, so it follows the picker rather
  // than staying on whatever was expanded first.
  if (launcherListLoaded) void loadLauncherList();
});

async function loadCookieSets() {
  renderCookieSets(await send({type: 'list-launcher-cookie-sets'}));
}

$('#pull').addEventListener('click', () => withBusy($('#pull'), async () => {
  const chosen = $('#set-picker').value;
  setStatus('Loading from Launcher…');
  // No setId for the assigned set: the route reads its absence as "the assigned
  // one", which is the only thing this button could ever do before a picker
  // existed, and keeps that path byte-identical.
  const result = await send({
    type: 'pull-from-launcher',
    ...(chosen && chosen !== assignedSetId ? {setId: chosen} : {}),
  });
  const setName = result.set || 'Launcher';
  if (!result.ok) {
    setStatus(result.error || 'Could not load from Launcher', true);
  } else if (!result.count) {
    setStatus(result.set ? `"${result.set}" has no cookies to load` : 'No cookie set is assigned to this profile');
  } else if (result.failed) {
    // Partial import: substantial progress was made, so this is not styled as a
    // hard error, but the failed count must still be visible -- silently
    // rounding a partial pull up to a full success is exactly the kind of
    // swallowed failure the sync rewrite exists to close.
    setStatus(`Loaded ${result.count} of ${result.count + result.failed} cookies from "${setName}" ` +
        `— ${result.failed} failed to import`);
  } else if (result.clearFailed) {
    // The clear half of "replace", reported on the same principle. Cookies that
    // would not delete are still in the jar, so this is genuinely not the clean
    // replacement the hint promised.
    setStatus(`Loaded ${result.count} cookies from "${setName}" — ${result.clearFailed} ` +
        'old cookie(s) could not be removed first');
  } else {
    setStatus(`Loaded ${result.count} cookies from "${setName}"`);
  }
  await refresh();
  // The "not in this browser yet" marks are now stale by definition -- a pull
  // is exactly the thing that changes them.
  if (launcherListLoaded) void loadLauncherList();
}));

// ---- the two ways out of a suppressed sync ---------------------------------
// Both are shown only while the engine is refusing to push, and each says where
// the cookies would land. Neither is reachable from the automatic loop.
$('#save-to-loaded').addEventListener('click', () => withBusy($('#save-to-loaded'), async () => {
  const setId = suppressedSetId;
  const setName = suppressedSetName;
  if (!setId) {
    setStatus('There is no loaded set to save to', true);
    return;
  }
  setStatus(`Saving to "${setName}"…`);
  const result = await send({type: 'overwrite-set', setId});
  setStatus(result.ok ?
    `Saved ${result.saved} cookies to "${result.set || setName}"` :
    (result.error || 'Could not save to that cookie set'), !result.ok);
  await refresh();
}));

$('#resume-sync').addEventListener('click', () => withBusy($('#resume-sync'), async () => {
  setStatus('Resuming sync…');
  const result = await send({type: 'resume-sync'});
  setStatus(result.ok ?
    `Syncing again — saved ${result.count ?? 0} cookies${result.set ? ` to "${result.set}"` : ''}` :
    (result.error || 'Could not resume syncing'), !result.ok);
  await refresh();
}));

// ---- what the launcher holds, read-only ----------------------------------------
// The counterpart to "Load from Launcher": that button replaces the whole jar,
// and this is the only way to see what it would replace it with before pressing
// it.
//
// Deliberately not part of refresh(). It costs a launcher round trip and the
// answer only changes when someone edits the set in the Cookies tab, so it is
// fetched when opened and re-fetched after a pull -- not on every cookie change
// in the browser, which would be several requests a second on a busy page.
let launcherListLoaded = false;

function launcherListRow(cookie, presentDomains) {
  const row = document.createElement('div');
  row.className = 'lc-row';

  const name = document.createElement('span');
  name.className = 'lc-name';
  name.textContent = cookie.name;
  name.title = `${cookie.name} · ${cookie.path || '/'}`;

  const domain = document.createElement('span');
  domain.className = 'lc-domain';
  domain.textContent = cookie.domain;
  domain.title = cookie.domain;
  // Whether this site already has cookies in THIS browser. The useful thing a
  // list can add over a count: it turns "Load from Launcher" from a leap into a
  // decision, because the sites about to be overwritten are the ones marked
  // here.
  if (!presentDomains.has(cookie.domain.replace(/^\./, ''))) {
    domain.dataset.state = 'absent';
    domain.title = `${cookie.domain} — not in this browser yet`;
  }

  const expiry = document.createElement('span');
  expiry.className = 'lc-expiry';
  // A session cookie is a different thing from one expiring at the epoch, and
  // the panel says which rather than printing 1970.
  expiry.textContent = cookie.expires ?
    new Date(cookie.expires * 1000).toLocaleDateString() :
    'session';

  row.append(domain, name, expiry);
  return row;
}

function renderLauncherList(result, jarDomains) {
  const list = $('#launcher-list');
  list.replaceChildren();
  if (!result.ok) {
    const note = document.createElement('p');
    note.className = 'lc-note';
    note.textContent = result.error || 'Could not read this profile’s cookies from the Launcher.';
    list.appendChild(note);
    return;
  }
  if (!result.set) {
    const note = document.createElement('p');
    note.className = 'lc-note';
    // An ordinary state, not a failure: say what is true and what would change
    // it, the same way SYNC_BLOCKED_REASON does.
    note.textContent =
        'No cookie set is assigned to this profile. Assign one from the Cookies tab in ' +
        'Scout Web, or use "Save to Cookies tab…" above to create one from this session.';
    list.appendChild(note);
    return;
  }

  const head = document.createElement('p');
  head.className = 'lc-head';
  head.textContent =
      `“${result.set}” · ${result.count} cookie${result.count === 1 ? '' : 's'}`;
  list.appendChild(head);

  // Sorted by domain so the same site's cookies sit together; the list is read
  // to answer "which sites", not "which cookie".
  const sorted = [...result.cookies].sort((a, b) =>
    (a.domain || '').localeCompare(b.domain || '') || (a.name || '').localeCompare(b.name || ''));
  for (const cookie of sorted) {
    list.appendChild(launcherListRow(cookie, jarDomains));
  }
}

async function loadLauncherList() {
  const list = $('#launcher-list');
  list.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'lc-note';
  loading.textContent = 'Reading from Launcher…';
  list.appendChild(loading);

  // Follows the picker: the question this list answers is "what am I about to
  // load", and after a picker existed that stopped always meaning the assigned
  // set. Omitted for the assigned one so the request stays the bare
  // {runToken} it has always been.
  const chosen = $('#set-picker').value;
  const [result, jar] = await Promise.all([
    send({
      type: 'list-launcher-cookies',
      ...(chosen && chosen !== assignedSetId ? {setId: chosen} : {}),
    }),
    // The live jar, for the "not in this browser yet" marks. Read here rather
    // than taken from the counts already on screen because those are numbers,
    // and this needs the domains.
    chrome.cookies.getAll({}).catch(() => []),
  ]);
  const jarDomains = new Set(jar.map((cookie) => String(cookie.domain || '').replace(/^\./, '')));
  renderLauncherList(result, jarDomains);
  launcherListLoaded = result.ok;
}

$('#launcher-list-toggle').addEventListener('click', () => {
  const button = $('#launcher-list-toggle');
  const list = $('#launcher-list');
  const open = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', open ? 'false' : 'true');
  list.hidden = open;
  if (!open && !launcherListLoaded) {
    void loadLauncherList();
  }
});

// ---- overwrite an existing set: confirm, in place ---------------------------
// The one control in this panel that can destroy something a teammate stored.
//
// Confirmation is required and it names both counts, because the two numbers
// are the whole decision: replacing a 214-cookie set with 189 is ordinary,
// replacing it with 3 means this session has not restored yet and the press is
// a mistake. window.confirm() is unreliable in an extension page (the same
// reason the save-as form expands inline rather than prompting), so the
// confirmation is markup.
//
// It targets whatever the picker has selected, which is deliberate: the set you
// are looking at in the picker and the set you would overwrite must be the same
// one, or this becomes a second, invisible selection to get wrong.
function closeOverwriteForm() {
  $('#overwrite-form').hidden = true;
  $('#overwrite-toggle').hidden = false;
  $('#overwrite-hint').hidden = false;
}

$('#overwrite-toggle').addEventListener('click', () => {
  void (async () => {
    const chosen = $('#set-picker').value;
    const set = cookieSets.find((item) => item.id === chosen);
    if (!set) {
      setStatus('Pick a cookie set to overwrite first', true);
      return;
    }
    const jar = await chrome.cookies.getAll({}).catch(() => []);
    const stored = `${set.count} cookie${set.count === 1 ? '' : 's'}`;
    const live = `${jar.length} cookie${jar.length === 1 ? '' : 's'}`;
    $('#overwrite-warning').textContent =
        `Replace the stored contents of “${set.name}” (${stored}) with this browser’s ` +
        `${live}? This cannot be undone.` +
        (set.id === assignedSetId ? ' This is the set this profile launches with.' : '');
    // The hint goes with the button, the way save-as does it: it describes what
    // pressing that button opens, and leaving it above a confirmation that has
    // already said the specific, harder version of the same thing is two
    // sentences competing to explain one action.
    $('#overwrite-toggle').hidden = true;
    $('#overwrite-hint').hidden = true;
    $('#overwrite-form').hidden = false;
    $('#overwrite-cancel').focus();
  })();
});

$('#overwrite-cancel').addEventListener('click', () => closeOverwriteForm());
$('#overwrite-form').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeOverwriteForm();
  }
});

$('#overwrite-confirm').addEventListener('click', () => withBusy($('#overwrite-confirm'), async () => {
  const chosen = $('#set-picker').value;
  const set = cookieSets.find((item) => item.id === chosen);
  if (!set) {
    setStatus('That cookie set is no longer in the list', true);
    closeOverwriteForm();
    return;
  }
  setStatus(`Overwriting "${set.name}"…`);
  const result = await send({type: 'overwrite-set', setId: set.id});
  closeOverwriteForm();
  setStatus(result.ok ?
    `Overwrote "${result.set || set.name}" with ${result.saved} cookies` :
    (result.error || 'Could not overwrite that cookie set'), !result.ok);
  // The set's stored count has changed, and so has what the read-only list
  // would show for it.
  await loadCookieSets();
  if (launcherListLoaded) void loadLauncherList();
}));

// ---- save-as: inline expanding name field --------------------------------------
function defaultSaveAsName() {
  const date = new Date().toISOString().slice(0, 10);
  return currentProfileName ? `${currentProfileName} ${date}` : `Cookies ${date}`;
}

function openSaveAsForm() {
  $('#save-as-toggle').hidden = true;
  $('#save-as-hint').hidden = true;
  $('#save-as-form').hidden = false;
  const input = $('#save-as-name');
  input.value = defaultSaveAsName();
  input.focus();
  input.select();
}

function closeSaveAsForm() {
  $('#save-as-form').hidden = true;
  $('#save-as-toggle').hidden = false;
  $('#save-as-hint').hidden = false;
}

$('#save-as-toggle').addEventListener('click', openSaveAsForm);
$('#save-as-cancel').addEventListener('click', () => closeSaveAsForm());
$('#save-as-form').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSaveAsForm();
  }
});
// The name input's Enter submits the form natively; this only handles the async
// work and reporting, the same withBusy/setStatus contract every other action
// here follows -- no action may leave the form stuck mid-request with nothing
// said.
$('#save-as-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void withBusy($('#save-as-confirm'), async () => {
    const name = $('#save-as-name').value.trim();
    // Answered here rather than by a round trip, so the one failure the user can
    // actually fix says so immediately and points at the field.
    if (!name) {
      setStatus('Enter a name for this cookie set first.', true);
      $('#save-as-name').focus();
      return;
    }
    setStatus('Saving to Cookies tab…');
    const result = await send({type: 'save-as-set', name});
    if (result.ok) {
      setStatus(`Saved ${result.saved} cookies to "${result.set}"`);
      closeSaveAsForm();
    } else {
      // Left open on failure (an unreachable launcher, a jar the launcher did
      // not recognize) so the user can retry without re-opening the form and
      // losing what they typed. background.js's saveAsSet returns a specific
      // reason for every failure it can produce; the fallback only covers a
      // reply that somehow carried none, and still says what to try.
      setStatus(result.error ||
          'Could not save to the Cookies tab. Relaunch this profile from Scout Web and try again.',
      true);
    }
  });
});

$('#open-editor').addEventListener('click', () => {
  void chrome.tabs.create({url: chrome.runtime.getURL('editor.html')});
});

function closeExportMenu() {
  $('#export-menu').hidden = true;
  $('#export-menu-button').setAttribute('aria-expanded', 'false');
}

$('#export-menu-button').addEventListener('click', () => {
  const willOpen = $('#export-menu').hidden;
  $('#export-menu').hidden = !willOpen;
  $('#export-menu-button').setAttribute('aria-expanded', String(willOpen));
});

$('#export-menu').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-format]');
  if (!button) return;
  closeExportMenu();
  void withBusy($('#export-menu-button'), async () => {
    const {scope, format} = button.dataset;
    try {
      if (format === 'clipboard') {
        setStatus('Copying…');
        const cookies = await chrome.cookies.getAll({});
        if (!cookies.length) { setStatus('No cookies to copy'); return; }
        await navigator.clipboard.writeText(ScoutCookieFormat.toCookieJson(cookies));
        setStatus(`Copied ${cookies.length} cookies to clipboard`);
        return;
      }
      setStatus('Exporting…');
      const result = await send({type: 'export-cookies', scope, format});
      setStatus(result.count ? `Exported ${result.count} cookies` : (result.error || 'Nothing to export'),
          Boolean(result.error));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
});

$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const label = $('#import-label');
  label.classList.add('busy');
  setStatus('Importing…');
  try {
    const cookies = ScoutCookieFormat.parseCookieContent(await file.text());
    if (!cookies.length) throw new Error('No cookies found in that file');
    const result = await send({type: 'import-cookies', cookies});
    if (!result.ok && result.error && !('count' in result)) {
      // send() itself failed (background unreachable) -- result.count is absent,
      // unlike a normal import-cookies reply which always has one.
      throw new Error(result.error);
    }
    const failed = result.failed || 0;
    const imported = result.count || 0;
    lastImport = {fileName: file.name, imported, total: cookies.length, failed};
    setStatus(`Imported ${imported} of ${cookies.length} cookies` + (failed ? ` — ${failed} failed` : ''),
        failed > 0 && !imported);
    // refresh() repaints the whole panel, so the durable line is rendered from
    // lastImport inside it rather than here -- otherwise this would be undone
    // one line later.
    await refresh();
  } catch (error) {
    lastImport = {fileName: file.name, imported: 0, total: 0, failed: 0, error: true};
    renderImportResult(null);
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    event.target.value = '';
    label.classList.remove('busy');
  }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.menu-wrap')) closeExportMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#export-menu').hidden) closeExportMenu();
});

// The launch snapshot first, because it needs no launcher and cannot fail: the
// panel is fully usable a frame after it opens. The two live lists replace what
// the snapshot could say -- the workspace's automations and its cookie sets --
// and each leaves the snapshot standing if the launcher is closed.
void (async () => {
  await loadSession();
  void loadAutomations();
})();
void refresh();
void loadCookieSets();
// The first status poll runs at open, not on a timer: a panel opened while a run
// is already going has to show it immediately rather than up to fifteen seconds
// later. It schedules the next one itself, at the cadence the answer earns.
void pollRun();
