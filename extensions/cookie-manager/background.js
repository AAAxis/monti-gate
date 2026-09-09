importScripts('cookie-format.js');

const SEED_IMPORTED_KEY = 'scoutSeedCookiesImported';
const SEED_SIGNATURE_KEY = 'scoutSeedCookiesSignature';
const SYNC_STATE_KEY = 'scoutSyncState';

// ---- push cadence -----------------------------------------------------------
// run-token.cjs's COOKIE_RATE allows 12 pushes/token/minute with a sliding 60s
// window. PUSH_DEBOUNCE_MS alone only coalesces bursts closer together than
// itself; changes spaced further apart (ad/analytics/session-refresh churn is
// routinely 3-5s apart) would each fire their own push and can reach the cap.
// PUSH_MIN_INTERVAL_MS is a floor under the debounce for exactly that case,
// with enough headroom (10/min) that a manual "Sync now" click or two never
// tips it over. PUSH_RETRY_DELAY_MS/PUSH_RATE_LIMIT_RETRY_DELAY_MS back a
// single bounded retry after an automatic push fails outright -- see
// `retryQueued` below for how that stays bounded rather than a hot loop.
const PUSH_DEBOUNCE_MS = 3000;
const PUSH_MIN_INTERVAL_MS = 6000;
const PUSH_RETRY_DELAY_MS = 10000;
const PUSH_RATE_LIMIT_RETRY_DELAY_MS = 65000;

function reportUnhandled(context) {
  return (error) => console.error(`Scout cookie sync: ${context} failed`, error);
}

async function hashText(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---- launch config ---------------------------------------------------------
// scout-launch.json is written per launch by built-in-extensions.cjs and only
// when the launcher minted a run token. Absent file => the extension is
// running outside a profile launch (or minting failed): sync is shown as
// unavailable, everything else still works.
async function launchConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL('scout-launch.json'));
    if (!response.ok) return null;
    const parsed = await response.json();
    return parsed.token && parsed.apiPort ? parsed : null;
  } catch {
    return null;
  }
}

async function profileMeta() {
  try {
    const response = await fetch(chrome.runtime.getURL('profile-meta.json'));
    if (!response.ok) return {};
    return await response.json();
  } catch {
    return {};
  }
}

// What the side panel paints before it has talked to anyone: this profile, the
// theme to paint in, the proxy verdict as the launcher composed it, and the
// automations this launch may run. Written per launch by built-in-extensions.cjs
// from the renderer's own homeProxyStatus() output, so the panel and the start
// page describe one session in one set of words.
//
// Absent for the same reason scout-launch.json is: the extension is running
// outside a profile launch. The panel says so rather than inventing a session.
async function sessionData() {
  try {
    const response = await fetch(chrome.runtime.getURL('scout-session.json'));
    if (!response.ok) return null;
    const parsed = await response.json();
    return parsed && parsed.proxy ? parsed : null;
  } catch {
    return null;
  }
}

// ---- sync state --------------------------------------------------------------
// Everything the badge and popup need lives here, not in module-scope
// variables: a service worker can be evicted between any two lines, and the
// next event wakes a fresh instance with no memory of what this one was doing.
//
//   reachable       true unless the last launcher round trip's fetch() itself
//                    threw (nothing was listening). An HTTP error status
//                    (403/429/5xx) still counts as reachable:true -- the
//                    launcher answered, it just refused or rejected.
//   lastErrorKind    '' | 'network' | 'refused' | 'server-error' |
//                    'rate-limited' | 'saved-none' | 'import-failed' |
//                    'internal'. 'network' is the only kind that pairs with
//                    reachable:false; the rest are answered rejections of
//                    one shape or another. 'refused' (HTTP 403, "Not
//                    allowed") is specifically a dead/invalid run token;
//                    'server-error' is everything else non-2xx (5xx, or an
//                    unparseable body) and says nothing about the token.
//   lastErrorSource  '' | 'push' | 'pull' -- which operation produced
//                    lastError/lastErrorKind, since both share these fields.
//   signature        SHA-256 hex digest of ScoutCookieFormat.jarSignature(),
//                    not the raw tab-separated dump: that string is
//                    hundreds of KB for a real jar and this is rewritten on
//                    close to every cookie change. Opaque outside this file;
//                    only ever compared for equality.
//   pushTokenHash    SHA-256 hex digest of the run token signature/inSync
//                    above were captured under. A fresh token is minted every
//                    launch but this record's directory (and its storage)
//                    survives into the next one; compared against the current
//                    token on every push so a stale watermark from a
//                    previous launch can never short-circuit a real push.
//   lastAttemptAt    epoch ms of the last actual network push attempt (not
//                    the time it was scheduled); backs PUSH_MIN_INTERVAL_MS.
//   lastSet          name of the cookie set the last successful push/pull
//                    touched, so the popup can say where a push landed.
//   pushSuppressed   true after this window loaded a set it is NOT assigned
//                    to. See suppressAfterArbitraryLoad below: the jar now
//                    holds set B while the push loop is aimed at set A, so
//                    every push is stopped until the user says where the
//                    changes should go. Distinct from `paused`, which is the
//                    user's own switch -- this one is the engine refusing to
//                    write somewhere it would be wrong, and it is cleared by
//                    loading the assigned set again or by an explicit resume.
//   loadedSetId      id of the non-assigned set this window loaded, and
//   loadedSetName    its name, so the card can say which one and offer to
//                    save back to it by id. Both '' when nothing arbitrary
//                    has been loaded.
const DEFAULT_SYNC = {
  available: false, paused: false, inSync: false, reachable: true,
  pushedAt: 0, pushedCount: 0, lastError: '', lastErrorKind: '', lastErrorSource: '',
  signature: '', pushTokenHash: '', pushPending: false, lastAttemptAt: 0, lastSet: '',
  pushSuppressed: false, loadedSetId: '', loadedSetName: '',
};

async function getSyncState() {
  const stored = await chrome.storage.local.get(SYNC_STATE_KEY);
  return {...DEFAULT_SYNC, ...(stored[SYNC_STATE_KEY] || {})};
}

// Writes are serialized through one promise chain rather than each doing its
// own get-then-set: two overlapping calls (e.g. schedulePush's fire-and-forget
// `pushPending:true` landing mid-flight of a push's terminal patch) would
// otherwise both read the same "before" state and the later set() would
// silently discard whatever the earlier one wrote. The chain link that fails
// is still reported to ITS caller (the returned promise rejects normally);
// only the shared `syncStateChain` itself is normalized back to resolved so
// one bad write cannot wedge every write after it.
let syncStateChain = Promise.resolve();

function setSyncState(patch) {
  const result = syncStateChain.then(async () => {
    const next = {...await getSyncState(), ...patch};
    await chrome.storage.local.set({[SYNC_STATE_KEY]: next});
    await updateBadge(next);
    return next;
  });
  syncStateChain = result.catch(() => undefined);
  return result;
}

// ---- badge -----------------------------------------------------------------
// One glance at the toolbar answers "did my session make it to the launcher".
// reachable:false, lastErrorKind:'refused', and lastErrorKind:'rate-limited'
// are kept visually distinct (Important 3): a dead token, a live-but-refused
// server error, and a throttled-but-self-clearing connection are all very
// different from the launcher process not answering at all, and collapsing
// them into one red bang was actively misleading for the one class of bug
// this whole feature exists to fix (a stale/expired run token).
//
// The '×' glyph specifically means "your run token looks dead" -- gated on
// lastErrorSource === 'push' so a pull failure (e.g. loadEntries throwing,
// answered as its own HTTP 500 "server-error") can never paint it. A pull
// hitting a genuine 403 does still leave `refused` in lastError text for the
// popup to read, it just does not drive this specific glyph, which is
// documented as describing push sync status. 'server-error' (any 5xx, or an
// unparseable body) never gets a dedicated glyph on either path -- it falls
// through to pending/inSync, same as the app-level kinds below.
async function updateBadge(sync) {
  const state = sync || await getSyncState();
  let text = '';
  let color = '#1a7f3c';
  if (state.available && !state.paused) {
    if (!state.reachable) {
      text = '!';
      color = '#d53c32';
    } else if (state.lastErrorKind === 'refused' && state.lastErrorSource === 'push') {
      text = '×';
      color = '#d53c32';
    } else if (state.lastErrorKind === 'rate-limited') {
      text = '⏱';
      color = '#b45309';
    } else if (state.pushPending) {
      text = '…';
      color = '#b45309';
    }
    // In-sync deliberately shows NO badge. A steady-state green check on the
    // toolbar icon reads as clutter, not information -- the badge exists to
    // flag problems, and the panel itself is where healthy sync status lives.
  }
  try {
    await chrome.action.setBadgeText({text});
    await chrome.action.setBadgeBackgroundColor({color});
  } catch (error) {
    // Badge is decoration; never let it fail a sync. Still logged (not a bare
    // catch) so a broken action API is not invisible.
    console.error('Scout cookie sync: failed to update badge', error);
  }
}

// ---- launcher round trip -----------------------------------------------------
// Shared by push and pull so both classify failures the same way (Important
// 1 and 3): a thrown fetch (nothing answered) is 'network'. A response that
// parses but carries status:false or a non-2xx is split three ways by status
// code: 429 is 'rate-limited' (self-clearing, unlike a dead token); 403 is
// 'refused', run-token.cjs's one and only "Not allowed" refusal, i.e.
// specifically a dead/invalid/expired run token; everything else (5xx, or a
// 200 whose body would not parse) is 'server-error' and says nothing about
// the token -- run-token.cjs's own work() failures (a dead proxy, a
// renderer-side throw like loadEntries) surface as exactly this, not as 403.
// 409 is the one refusal that is not a fault: the launcher has moved to a
// different workspace, so this profile's sets are not the ones it can write.
// Kept distinct from 'refused' because the remedy is the opposite -- relaunching
// is what fixes a dead token and is exactly the wrong advice here, where
// switching the workspace back resumes a session that is otherwise fine.
function classifyStatus(status) {
  if (status === 429) return 'rate-limited';
  if (status === 403) return 'refused';
  if (status === 409) return 'other-workspace';
  return 'server-error';
}

async function fetchLauncher(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return {ok: false, kind: 'network', message: error && error.message ? error.message : String(error)};
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false, kind: classifyStatus(response.status),
      message: `Launcher answered HTTP ${response.status} with a response that could not be parsed.`,
    };
  }
  if (response.ok && body && body.status) {
    return {ok: true, body};
  }
  return {
    ok: false,
    kind: classifyStatus(response.status),
    message: (body && body.msg) || `Launcher answered HTTP ${response.status}`,
  };
}

// ---- push (browser -> launcher) --------------------------------------------
async function pushToLauncher(opts) {
  const manual = Boolean(opts && opts.manual);
  try {
    const config = await launchConfig();
    if (!config) {
      await setSyncState({available: false, pushPending: false});
      return {ok: false, error: 'This window was not launched from Scout Web.'};
    }
    let state = await setSyncState({available: true});

    // A fresh run token is minted every launch, but this state record's
    // storage survives into the next one (Important 8). If the token this
    // watermark was captured under does not match the current launch's, the
    // watermark cannot be trusted -- it may describe a set that was deleted
    // or reassigned since. Reset before the unchanged-shortcut below ever
    // gets a chance to read it.
    const tokenHash = await hashText(config.token);
    if (state.pushTokenHash !== tokenHash) {
      // The error fields go with the watermark, for the same reason and on the
      // same evidence: they describe an attempt made against a token that no
      // longer exists. Keeping them made a healthy relaunch open on "Launcher
      // rejected the request" -- the panel accusing the new session of the old
      // one's failure -- until the first push happened to succeed and clear it.
      // The suppression goes with the watermark too, and for a stronger
      // reason than the error fields do: it describes THIS window's jar
      // holding a set the profile is not assigned to, and a fresh token means
      // a fresh launch whose jar is whatever that launch seeded. Carrying it
      // over would leave a new session permanently refusing to sync because
      // of something the previous one loaded.
      state = await setSyncState({
        inSync: false, signature: '', pushTokenHash: tokenHash,
        lastError: '', lastErrorKind: '', lastErrorSource: '',
        pushSuppressed: false, loadedSetId: '', loadedSetName: '',
      });
    }

    // The jar is mid-rewrite: a pull is clearing it and importing a set. A
    // push now would send a half-applied jar, and in replace mode that can
    // briefly be an EMPTY one. Requeued rather than dropped, so the real push
    // still happens once the jar settles.
    //
    // In memory rather than in storage on purpose: if this worker is evicted
    // the import dies with it, so the flag can never be left stuck on.
    if (jarWriteDepth > 0) {
      queuePush(PUSH_DEBOUNCE_MS);
      return {ok: false, error: 'Waiting for the cookie import to finish.'};
    }

    // Applies to the manual path as well, unlike `paused` below. "Sync now"
    // while a foreign set is loaded is not an escape hatch -- it is exactly
    // the bug: it would write set B's jar into set A, which is the profile's
    // assigned set and what it launches with. The panel disables the button
    // and offers "save to «B»" or "save as new" instead.
    if (state.pushSuppressed) {
      await setSyncState({pushPending: false});
      return {
        ok: false,
        error: state.loadedSetName ?
          `This window is holding "${state.loadedSetName}", which isn't assigned to ` +
              'this profile. Changes are not being saved.' :
          'Syncing is stopped: this window is holding a set it is not assigned.',
      };
    }

    if (!manual && state.paused) {
      // Pausing clears the last failure too. An error kind is a statement about
      // the last attempt; while paused there will be no next attempt, so a kind
      // left here can never be disproved -- and classifySync would go on
      // reporting a dead token as the reason sync is idle when the real reason
      // is that the user turned it off.
      await setSyncState({
        pushPending: false, lastError: '', lastErrorKind: '', lastErrorSource: '',
      });
      return {ok: false, error: 'Sync is paused.'};
    }

    if (!manual && state.lastAttemptAt) {
      const elapsed = Date.now() - state.lastAttemptAt;
      // A negative elapsed value only happens if the system clock moved
      // backwards (NTP correction) -- treat that as "the floor is already
      // satisfied" rather than computing a wait as large as the rollback
      // itself, which would otherwise recompute identically (blocking
      // automatic sync for the rollback's whole duration) on every re-entry.
      if (elapsed >= 0 && elapsed < PUSH_MIN_INTERVAL_MS) {
        queuePush(Math.min(PUSH_MIN_INTERVAL_MS - elapsed, PUSH_MIN_INTERVAL_MS));
        return {ok: false, error: 'Waiting for the minimum interval between pushes.'};
      }
    }

    const cookies = await chrome.cookies.getAll({});
    const signature = await hashText(ScoutCookieFormat.jarSignature(cookies));
    // The shortcut requires a clean last attempt, not just a matching
    // signature: skipping the fetch while an unresolved lastErrorKind sits in
    // state would let a transient failure (network blip, a 5xx) stick
    // forever once the jar goes quiet, since nothing would ever run the real
    // request that could clear it.
    if (!manual && state.inSync && state.signature === signature && !state.lastErrorKind) {
      await setSyncState({pushPending: false});
      return {ok: true, unchanged: true};
    }

    await setSyncState({lastAttemptAt: Date.now()});
    const result = await fetchLauncher(
        `http://127.0.0.1:${config.apiPort}/v1/cookies/push-from-profile`,
        {runToken: config.token, cookies});

    if (!result.ok) {
      await setSyncState({
        reachable: result.kind !== 'network', pushPending: false,
        lastError: result.message, lastErrorKind: result.kind, lastErrorSource: 'push',
      });
      // Retries are only for the automatic path -- a manual failure must not
      // arm or disarm that bookkeeping, or an interleaved manual click could
      // let the "single" retry budget re-charge indefinitely.
      if (!manual) queueRetry(result.kind);
      return {ok: false, error: result.message};
    }
    retryQueued = false;

    const saved = Number(result.body.saved) || 0;
    // useAutomationBridge.ts refuses to persist a push that normalizes to
    // zero cookies (guards against wiping a saved set from a transient empty
    // jar) and answers 200 {status:true, saved:0} for it -- indistinguishable
    // from a real success by status code alone. Treating that as synced would
    // advance the watermark past a jar that was never actually saved, and a
    // later push of the *same* jar would then be skipped as "unchanged"
    // forever. Only a genuinely empty local jar (nothing was ever going to be
    // saved) is allowed to count as in sync.
    if (saved === 0 && cookies.length > 0) {
      const message = 'Launcher did not save the pushed cookies (none were recognizable).';
      await setSyncState({
        reachable: true, inSync: false, pushPending: false,
        lastError: message, lastErrorKind: 'saved-none', lastErrorSource: 'push',
      });
      return {ok: false, error: message};
    }
    await setSyncState({
      reachable: true, inSync: true, signature, pushPending: false,
      pushedAt: Date.now(), pushedCount: saved, lastError: '', lastErrorKind: '', lastErrorSource: '',
      lastSet: result.body.set || '',
    });
    return {ok: true, count: saved, set: result.body.set || undefined};
  } catch (error) {
    // Nothing above this point (config/state lookups, chrome.cookies.getAll,
    // hashing) was inside a catch -- a throw there used to escape as an
    // unhandled rejection from the fire-and-forget `void pushToLauncher()`
    // callers, leaving `pushPending:true` stuck with no lastError to explain
    // it. Wrapping the whole body closes that.
    const message = error && error.message ? error.message : String(error);
    console.error('Scout cookie sync: push crashed', error);
    await setSyncState({
      pushPending: false, lastError: message, lastErrorKind: 'internal', lastErrorSource: 'push',
    }).catch(reportUnhandled('persisting push crash state'));
    return {ok: false, error: message};
  }
}

// A single bounded retry after an automatic push fails outright -- not a
// backoff sequence, exactly one attempt (Important 4), so it can never become
// a hot loop: `retryQueued` blocks a second retry from being queued off the
// first retry's own failure, and any genuine cookie change (schedulePush)
// clears it, since a real change deserves its own fresh attempt rather than
// counting against this budget.
let retryQueued = false;

function queueRetry(kind) {
  if (retryQueued) {
    // This failure WAS the retry attempt, and it failed too: stop here
    // rather than queue another, and wait for the next real cookies.onChanged
    // (schedulePush resets this flag) instead of looping.
    retryQueued = false;
    return;
  }
  retryQueued = true;
  queuePush(kind === 'rate-limited' ? PUSH_RATE_LIMIT_RETRY_DELAY_MS : PUSH_RETRY_DELAY_MS);
  void setSyncState({pushPending: true}).catch(reportUnhandled('marking retry pending'));
}

let pushTimer = 0;

function queuePush(delayMs) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = 0;
    void pushToLauncher().catch(reportUnhandled('automatic push'));
  }, delayMs);
}

function schedulePush() {
  // Only write when the flag is actually changing: an idle jar generates two
  // onChanged events per imported cookie, and re-persisting the same
  // multi-field state record (Important 6) on every single one of them for no
  // observable change is the write-volume problem, not just the signature
  // field's size.
  if (!pushTimer) void setSyncState({pushPending: true}).catch(reportUnhandled('marking push pending'));
  retryQueued = false;
  queuePush(PUSH_DEBOUNCE_MS);
}

// ---- list (launcher -> browser, read-only) ---------------------------------
// What the launcher holds for this profile, without applying any of it.
//
// Unlike pullFromLauncher below, this touches nothing: no import, no jar
// change, and -- importantly -- no sync state. A failure here is the user
// looking something up, not the sync engine failing, and writing lastErrorKind
// from it would make an expanded list repaint the sync card as broken.
async function listLauncherCookies(setId) {
  const config = await launchConfig();
  if (!config) {
    return {ok: false, error: 'This window was not launched from Scout Web.'};
  }
  const result = await fetchLauncher(
      `http://127.0.0.1:${config.apiPort}/v1/cookies/list-for-profile`,
      {runToken: config.token, ...(setId ? {setId} : {})});
  if (!result.ok) {
    return {ok: false, error: result.message, kind: result.kind};
  }
  return {
    ok: true,
    set: result.body.set || null,
    setId: result.body.setId || null,
    count: Number(result.body.count) || 0,
    cookies: Array.isArray(result.body.cookies) ? result.body.cookies : [],
  };
}

// Every cookie set in this launch's workspace, metadata only, for the panel's
// picker. Touches no sync state, for the same reason listLauncherCookies does
// not: this is the user looking something up, not the sync engine failing.
async function listLauncherCookieSets() {
  const config = await launchConfig();
  if (!config) {
    return {ok: false, available: false,
      error: 'This window was not launched from Scout Web.'};
  }
  const result = await fetchLauncher(
      `http://127.0.0.1:${config.apiPort}/v1/cookies/list-sets-for-profile`,
      {runToken: config.token});
  if (!result.ok) {
    return {ok: false, available: true, error: result.message, kind: result.kind};
  }
  return {
    ok: true,
    available: true,
    assignedId: result.body.assignedId || null,
    sets: Array.isArray(result.body.sets) ? result.body.sets : [],
  };
}

// ---- pull (launcher -> browser) --------------------------------------------
// `setId` picks a set this profile is not assigned to -- the panel's picker
// over the workspace's whole library. Absent means the assigned set.
//
// Two things this function does that it did not before a picker existed:
//
//   1. It REPLACES rather than merges. importCookies only ever calls
//      chrome.cookies.set, so "Load from Launcher" used to leave everything
//      already in the jar in place -- despite the button's own hint saying it
//      replaces this browser's cookies, which had simply been false since it
//      was written. With one assigned set the difference was mostly invisible;
//      with a picker it is dangerous, because applying set B over set A leaves
//      a jar that is neither, and that jar is what gets saved back.
//   2. It stops the push loop when the loaded set is not the assigned one --
//      see suppressAfterArbitraryLoad.
async function pullFromLauncher(setId) {
  try {
    const config = await launchConfig();
    if (!config) {
      return {ok: false, error: 'This window was not launched from Scout Web.'};
    }
    const result = await fetchLauncher(
        `http://127.0.0.1:${config.apiPort}/v1/cookies/pull-for-profile`,
        {runToken: config.token, ...(setId ? {setId} : {})});
    if (!result.ok) {
      // Persisted the same way a push failure is (Important 1): closing the
      // popup used to make a 403/429/dead-connection on pull evaporate
      // entirely while the badge kept showing whatever it showed before.
      await setSyncState({
        reachable: result.kind !== 'network',
        lastError: result.message, lastErrorKind: result.kind, lastErrorSource: 'pull',
      });
      return {ok: false, error: result.message};
    }

    const cookies = Array.isArray(result.body.cookies) ? result.body.cookies : [];
    // Whether what arrived is the set this profile launches with. The launcher
    // decides this, not the panel: `assigned` is computed there against
    // profiles.cookie_id, and a set with no assignment at all reads as
    // assigned so an ordinary "Load from Launcher" never suppresses anything.
    const assigned = result.body.assigned !== false;
    const loadedName = result.body.set || '';
    const loadedId = result.body.setId || '';

    if (!cookies.length) {
      // Nothing to apply, so nothing was replaced and the jar is untouched --
      // which means this is NOT a moment to suppress the push loop either. An
      // empty set is a set with no cookies in it, not a set that took over
      // this window.
      await setSyncState({
        reachable: true, lastError: '', lastErrorKind: '', lastErrorSource: '',
        lastSet: loadedName,
      });
      return {ok: true, count: 0, failed: 0, cleared: 0, set: result.body.set || null,
        setId: loadedId || null, assigned};
    }

    // Clear, then import: the two halves of "replace". Counted separately so a
    // clear that only half worked is visible rather than folded into the
    // import's own numbers -- the same discipline `failed` already follows.
    //
    // Both are inside jarWriteDepth so the push loop cannot catch the jar
    // mid-rewrite. The window between the clear and the last set() is the one
    // moment this browser's jar is genuinely empty, and pushing THAT into a
    // cookie set would be the worst failure this file can produce.
    let cleared;
    let imported;
    jarWriteDepth++;
    try {
      cleared = await clearJar();
      imported = await importCookies(cookies);
    } finally {
      jarWriteDepth--;
    }

    if (imported.count === 0) {
      // Distinct from "the launcher had nothing for you" above: this is
      // "the launcher answered with N cookies and every single one of them
      // failed to apply", which used to come back as the identical
      // {ok:true,count:0} (Important 2).
      const message = `None of the ${cookies.length} cookies from the launcher could be applied to this browser.`;
      await setSyncState({
        reachable: true, lastError: message, lastErrorKind: 'import-failed', lastErrorSource: 'pull',
      });
      return {ok: false, count: 0, failed: imported.failed, cleared: cleared.count,
        set: result.body.set || null, setId: loadedId || null, assigned, error: message};
    }
    await setSyncState({
      reachable: true, lastError: '', lastErrorKind: '', lastErrorSource: '',
      lastSet: loadedName,
      // The whole point of the one-shot picker. Loading a set this profile is
      // not assigned to leaves the jar and the sync target disagreeing: the
      // jar holds B, the push loop writes to A. Left alone, chrome.cookies
      // .onChanged fires within three seconds of the import and A -- the set
      // the profile actually launches with -- gets overwritten with B's
      // cookies. Set B applied, set A destroyed, six seconds, no warning.
      //
      // Suppressed rather than redirected to B: redirecting would silently
      // start rewriting a teammate's stored set with whatever this window does
      // next, which is a bigger surprise than "changes aren't being saved".
      // The panel says which set is loaded and offers both ways out.
      //
      // Loading the ASSIGNED set is the opposite -- it makes the jar and the
      // launcher agree again -- so it clears the suppression.
      ...(assigned ?
        {pushSuppressed: false, loadedSetId: '', loadedSetName: ''} :
        {pushSuppressed: true, loadedSetId: loadedId, loadedSetName: loadedName}),
    });
    // A partial failure (some cookies applied, some did not) is surfaced via
    // `failed` on an otherwise-ok response rather than treated as a state
    // error: the pull did substantially work, unlike the all-failed case
    // above.
    return {ok: true, count: imported.count, failed: imported.failed,
      cleared: cleared.count, clearFailed: cleared.failed,
      set: result.body.set || null, setId: loadedId || null, assigned};
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('Scout cookie sync: pull crashed', error);
    await setSyncState({
      lastError: message, lastErrorKind: 'internal', lastErrorSource: 'pull',
    }).catch(reportUnhandled('persisting pull crash state'));
    return {ok: false, error: message};
  }
}

// ---- save-as (browser -> launcher, library save) ---------------------------
// A user-named snapshot into the Cookies tab -- deliberately separate from
// pushToLauncher above. It shares that function's transport (fetchLauncher,
// the same push-from-profile route, `saveAs` in the body) but touches NONE of
// its bookkeeping: no read or write of SYNC_STATE_KEY, so inSync, signature,
// pushTokenHash and lastAttemptAt are exactly as this call found them. A
// named snapshot is not a sync, and must never advance or reset the
// watermark the automatic push loop depends on -- a failed save-as here must
// not make the next real sync think it has something to retry, and a
// successful one must not make it think a push already landed.
//
// Failures are returned straight to the caller (the popup's status line or
// the editor's dialog), not persisted into lastError/lastErrorKind: those
// fields drive the toolbar badge and the popup's sync card, both of which
// describe the *automatic* sync loop. This is a one-off action the user is
// watching happen; there is nothing for a badge glyph to add, and folding a
// save-as failure into 'lastErrorSource: push' would make it indistinguishable
// from a real sync failure (e.g. wrongly painting the "dead token" '×' badge
// off a save-as that failed for an unrelated reason, like an empty jar).
async function saveAsSet(name, cookies) {
  try {
    const config = await launchConfig();
    if (!config) {
      return {ok: false, error: 'This window was not launched from Scout Web.'};
    }
    const jar = Array.isArray(cookies) ? cookies : await chrome.cookies.getAll({});
    if (!jar.length) {
      return {ok: false, error: 'There are no cookies to save.'};
    }
    const result = await fetchLauncher(
        `http://127.0.0.1:${config.apiPort}/v1/cookies/push-from-profile`,
        {runToken: config.token, cookies: jar, saveAs: name});
    if (!result.ok) {
      return {ok: false, error: result.message};
    }
    const saved = Number(result.body.saved) || 0;
    if (!saved) {
      // The launcher answered 200 but recognized none of the cookies -- same
      // "the request completed but nothing came of it" case pushToLauncher
      // treats as saved-none, just not persisted into sync state here.
      return {ok: false, error: 'Scout Web did not recognize any of the cookies to save.'};
    }
    return {ok: true, saved, set: result.body.set || ''};
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('Scout cookie sync: save-as-set crashed', error);
    return {ok: false, error: message};
  }
}

// ---- overwrite an existing set (browser -> launcher) -----------------------
// The explicit counterpart to saveAsSet: the same route and the same
// bookkeeping discipline (none), but writing over a set that already exists
// instead of creating a new one.
//
// Manual only, and it must stay that way. The automatic push loop cannot reach
// this function -- schedulePush calls pushToLauncher, which sends no
// saveToSetId -- and that separation is what stops a keyless document that
// browses the open web from quietly rewriting a teammate's stored session.
// There is no undo: the launcher's savePayload uploads a new object and deletes
// the superseded one, so the previous contents are gone once this succeeds. The
// panel confirms, naming the set and both counts, before calling it.
async function overwriteSet(setId, cookies) {
  try {
    if (!setId) {
      return {ok: false, error: 'No cookie set was named.'};
    }
    const config = await launchConfig();
    if (!config) {
      return {ok: false, error: 'This window was not launched from Scout Web.'};
    }
    const jar = Array.isArray(cookies) ? cookies : await chrome.cookies.getAll({});
    if (!jar.length) {
      return {ok: false, error: 'There are no cookies to save.'};
    }
    const result = await fetchLauncher(
        `http://127.0.0.1:${config.apiPort}/v1/cookies/push-from-profile`,
        {runToken: config.token, cookies: jar, saveToSetId: setId});
    if (!result.ok) {
      return {ok: false, error: result.message};
    }
    const saved = Number(result.body.saved) || 0;
    if (!saved) {
      return {ok: false, error: 'Scout Web did not recognize any of the cookies to save.'};
    }
    return {ok: true, saved, set: result.body.set || ''};
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('Scout cookie sync: overwrite-set crashed', error);
    return {ok: false, error: message};
  }
}

// Puts the push loop back on the assigned set after an arbitrary load.
//
// Deliberately does NOT reload the assigned set first. The user has a jar in
// front of them -- possibly one they have been working in since the load -- and
// silently throwing it away to restore coherence would be a worse surprise than
// the one this whole mechanism exists to prevent. What it does is exactly what
// it says: from here on, this window's cookies go back to the assigned set, and
// the first push will overwrite it. The panel warns in those words.
async function resumeSyncToAssigned() {
  await setSyncState({
    pushSuppressed: false, loadedSetId: '', loadedSetName: '',
    // The watermark cannot be trusted across a suppression: it describes a jar
    // from before the foreign set was applied, and leaving it would let the
    // unchanged-shortcut skip the very first push -- the one that makes the
    // assigned set match what is on screen.
    inSync: false, signature: '',
  });
  return await pushToLauncher({manual: true});
}

// ---- side panel: proxy re-check and automation runs -------------------------
// Both spend the same run token the cookie sync engine above spends, and both
// go through fetchLauncher so a dead token, a throttle and a 5xx are classified
// here exactly once. Neither reads or writes SYNC_STATE_KEY: like saveAsSet,
// these are one-off actions the user is watching happen, and folding their
// failures into lastError/lastErrorKind would paint the cookie badge red for
// something that has nothing to do with cookies.
//
// The run token authorizes exactly these two things plus the two cookie routes.
// Neither request carries anything the caller chose beyond an automation id the
// launcher already handed this session -- no proxy, no steps, no profile.
async function recheckProxy() {
  const config = await launchConfig();
  if (!config) {
    return {ok: false, error: 'This window was not launched from Scout Web.'};
  }
  const result = await fetchLauncher(
      `http://127.0.0.1:${config.apiPort}/v1/proxies/recheck-from-page`,
      {runToken: config.token});
  if (!result.ok) {
    return {ok: false, error: result.message};
  }
  return {
    ok: true,
    proxyOk: Boolean(result.body.proxyOk),
    title: result.body.title || '',
    detail: result.body.detail || '',
    fields: Array.isArray(result.body.fields) ? result.body.fields : [],
  };
}

// Every automation in this launch's workspace, for the panel's list.
//
// The panel's first paint still comes from scout-session.json -- the launch
// snapshot, which works with the launcher closed -- and this replaces it. Quiet
// on failure for the same reason automationStatus is: a window opened outside
// the launcher, or with the launcher since closed, is an ordinary state and the
// panel keeps showing the snapshot rather than painting an error over it.
async function listAutomations() {
  const config = await launchConfig();
  if (!config) {
    return {ok: false, available: false};
  }
  const result = await fetchLauncher(
      `http://127.0.0.1:${config.apiPort}/v1/automations/list-from-page`,
      {runToken: config.token});
  if (!result.ok) {
    return {ok: false, available: true, error: result.message};
  }
  return {
    ok: true,
    available: true,
    automations: Array.isArray(result.body.automations) ? result.body.automations : [],
  };
}

// Two routes, one button.
//
// An automation this launch was handed goes to run-from-page, which resolves it
// out of the run token and therefore works with the launcher window closed --
// which is most of the value of pinning one. Anything else has to go to
// run-any-from-page, where the launcher's renderer resolves it on demand, and
// that route answers 503 when the window is shut.
//
// The choice is made from the launch snapshot rather than by trying one route
// and falling back on a 403: a 403 is deliberately the same answer for an
// unknown token as for an unoffered automation (run-token.cjs), so treating it
// as "try the other one" would turn every genuinely dead token into two
// requests and a misleading second error.
async function runAutomation(automationId) {
  if (!automationId) {
    return {ok: false, error: 'No automation was named.'};
  }
  const config = await launchConfig();
  if (!config) {
    return {ok: false, error: 'This window was not launched from Scout Web.'};
  }
  const session = await sessionData();
  const offered = (session && Array.isArray(session.automations) ? session.automations : [])
      .some((item) => item && item.id === automationId);
  const path = offered ? 'run-from-page' : 'run-any-from-page';
  const result = await fetchLauncher(
      `http://127.0.0.1:${config.apiPort}/v1/automations/${path}`,
      {runToken: config.token, automationId});
  // The launcher answers identically for every refusal, so there is nothing
  // more specific to say than that it did not start.
  return result.ok ? {ok: true} : {ok: false, error: result.message};
}

// What is running against this profile right now, or null.
//
// Scoped to the profile by the launcher, not by this extension: the run may have
// been started from the launcher's own window, by a schedule, or by an MCP tool,
// and all three are exactly as relevant to the person watching this window as one
// started from the panel.
//
// This is the one call the panel makes on a timer, so its failure is quiet by
// design: `ok: false` with no `error` when the window has no launch credential at
// all. A poll that painted an error banner every second on a window opened
// outside the launcher would be worse than one that says nothing.
async function automationStatus() {
  const config = await launchConfig();
  if (!config) {
    return {ok: false, available: false};
  }
  const result = await fetchLauncher(
      `http://127.0.0.1:${config.apiPort}/v1/automations/status-from-page`,
      {runToken: config.token});
  if (!result.ok) {
    return {ok: false, available: true, error: result.message};
  }
  // Both null-able, and both nulls are successful answers that must not be
  // confused with a failed poll -- the panel paints an idle list for those and
  // leaves the last known state alone for a failure.
  //
  // `last` is the run that most recently FINISHED against this profile. Without
  // it the progress card is a bar that vanishes: the launcher answers out of its
  // live map, so the instant a run seals there is nothing to report and the card
  // disappears without ever saying whether it worked.
  return {
    ok: true,
    available: true,
    run: result.body.run || null,
    last: result.body.last || null,
  };
}

// Stops whatever is running against this profile. Names no run: the launcher
// resolves that from the token's own profile, so there is nothing here for a
// caller to aim.
async function cancelAutomation() {
  const config = await launchConfig();
  if (!config) {
    return {ok: false, error: 'This window was not launched from Scout Web.'};
  }
  const result = await fetchLauncher(
      `http://127.0.0.1:${config.apiPort}/v1/automations/cancel-from-page`,
      {runToken: config.token});
  if (!result.ok) {
    return {ok: false, error: result.message};
  }
  // False when there was nothing left to stop -- a run that ended between the
  // last poll and the click. Reported rather than treated as a failure.
  return {ok: true, cancelled: Boolean(result.body.cancelled)};
}

// Brings the launcher forward on its Automations tab, naming nothing.
//
// The panel's empty state is the only caller: a launch with no automations
// attached has nothing to run, and "go and attach one" is the only useful thing
// that screen can offer. Naming no automation is what the launcher reads as "the
// tab, no particular row" -- see authorizeOpen in run-token.cjs for why widening
// the route that far is safe.
async function openAutomationsInLauncher() {
  const config = await launchConfig();
  if (!config) {
    return {ok: false, error: 'This window was not launched from Scout Web.'};
  }
  const result = await fetchLauncher(
      `http://127.0.0.1:${config.apiPort}/v1/automations/open-in-launcher`,
      {runToken: config.token});
  return result.ok ? {ok: true} : {ok: false, error: result.message};
}

// ---- import / export -------------------------------------------------------
function downloadFile(filename, text, mime) {
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
  return chrome.downloads.download({url, filename, saveAs: true});
}

async function currentSiteDomain() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  try {
    if (!tab || !tab.url) return '';
    const url = new URL(tab.url);
    // Only http(s) tabs are "a site" with a cookie-bearing domain -- a
    // chrome://, chrome-extension://, about:, or file: active tab (this
    // popup's own extension page counts, since chrome.tabs.query can return
    // it) has a hostname too, but showing that hostname read as "the site"
    // in the popup instead surfaced this extension's own ID.
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : '';
  } catch {
    return '';
  }
}

async function exportCookies(scope, format) {
  const domain = scope === 'site' ? await currentSiteDomain() : '';
  if (scope === 'site' && !domain) return {count: 0};
  const cookies = await chrome.cookies.getAll(domain ? {domain} : {});
  if (!cookies.length) return {count: 0};
  const meta = await profileMeta();
  const stem = (meta.name || domain || 'scout-cookies')
      .replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'scout-cookies';
  if (format === 'netscape') {
    await downloadFile(`${stem}-cookies.txt`,
        ScoutCookieFormat.toNetscapeCookies(cookies), 'text/plain');
  } else {
    await downloadFile(`${stem}-cookies.json`,
        ScoutCookieFormat.toCookieJson(cookies), 'application/json');
  }
  return {count: cookies.length};
}

function cookieUrl(cookie) {
  if (cookie.url) return cookie.url;
  const domain = String(cookie.domain || '').replace(/^\./, '');
  const path = cookie.path || '/';
  return `${cookie.secure ? 'https' : 'http'}://${domain}${path}`;
}

// Greater than zero while a pull is rewriting the jar. Read by pushToLauncher,
// which requeues rather than sending a half-applied -- or, for the moment
// between the clear and the first set, entirely empty -- jar.
//
// Module scope rather than storage: a service worker can be evicted between any
// two lines, but if it is, the import it was running dies with it, so there is
// no state left to be stale. A persisted flag could get stuck on and stop
// syncing until the next launch.
let jarWriteDepth = 0;

// Empties this browser's jar, so an import can replace rather than merge.
//
// chrome.cookies.remove, not chrome.browsingData.removeCookies: browsingData is
// not in this extension's permissions (and asking for it would be asking for a
// great deal more than this needs), and it would also clear localStorage,
// IndexedDB and service worker registrations for every origin -- far past
// "replace the cookies".
//
// partitionKey and storeId are carried through when present. A partitioned
// cookie removed without its key is not removed at all, and it would survive
// into the "replaced" jar as a leftover from the previous set.
async function clearJar() {
  const existing = await chrome.cookies.getAll({});
  let removed = 0;
  let failed = 0;
  for (const cookie of existing) {
    try {
      const details = {url: cookieUrl(cookie), name: cookie.name};
      if (cookie.storeId) details.storeId = cookie.storeId;
      if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
      const result = await chrome.cookies.remove(details);
      // remove() resolves with null when nothing matched -- an httpOnly cookie
      // whose url we reconstructed wrongly, most often. Counted as failed
      // rather than removed: the caller reports it, and a jar that says it was
      // replaced when it was not is the thing this whole change is fixing.
      if (result) removed++;
      else failed++;
    } catch (error) {
      failed++;
      console.warn('Scout cookie clear failed', cookie.domain, cookie.name, error);
    }
  }
  return {count: removed, failed};
}

// Returns both how many cookies actually made it into the browser and how
// many did not (a raw entry that failed to normalize counts the same as one
// chrome.cookies.set rejected): a caller that only reads `count` must not be
// able to mistake "500 sent, 500 failed" for "the source had nothing"
// (Important 2).
async function importCookies(rawCookies) {
  let imported = 0;
  let failed = 0;
  for (const raw of rawCookies) {
    const cookie = ScoutCookieFormat.normalizeCookie(raw);
    if (!cookie) {
      failed++;
      continue;
    }
    try {
      const details = {
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
      };
      if (cookie.domain) details.domain = cookie.domain;
      if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
      await chrome.cookies.set(details);
      imported++;
    } catch (error) {
      failed++;
      console.warn('Scout cookie import failed', cookie.domain, cookie.name, error);
    }
  }
  return {count: imported, failed};
}

// ---- status for the side panel ----------------------------------------------
async function statusForPanel() {
  const [meta, sync, seedState, all, siteDomain] = await Promise.all([
    profileMeta(),
    getSyncState(),
    chrome.storage.local.get([SEED_IMPORTED_KEY, 'seededAt', 'seededCount']),
    chrome.cookies.getAll({}),
    currentSiteDomain(),
  ]);
  const site = siteDomain ? await chrome.cookies.getAll({domain: siteDomain}) : [];
  const config = await launchConfig();
  return {
    profile: meta.id ? {id: meta.id, name: meta.name || ''} : null,
    sync: {...sync, available: Boolean(config)},
    seed: {
      imported: Boolean(seedState[SEED_IMPORTED_KEY]),
      seededAt: seedState.seededAt || 0,
      seededCount: seedState.seededCount || 0,
    },
    counts: {total: all.length, site: site.length, siteDomain},
  };
}

// ---- messages --------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      switch (message && message.type) {
        case 'get-status':
          sendResponse(await statusForPanel());
          return;
        case 'get-session':
          sendResponse({ok: true, session: await sessionData()});
          return;
        case 'toolbar-theme':
          // The panel telling us what prefers-color-scheme actually resolved to
          // in this browser, which beats the appearance the launcher guessed at
          // launch. Sent on open and on every flip while it is open.
          applyActionIcon(Boolean(message.dark));
          sendResponse({ok: true});
          return;
        case 'recheck-proxy':
          sendResponse(await recheckProxy());
          return;
        case 'run-automation':
          sendResponse(await runAutomation(message.automationId));
          return;
        case 'list-automations':
          sendResponse(await listAutomations());
          return;
        case 'automation-status':
          sendResponse(await automationStatus());
          return;
        case 'cancel-automation':
          sendResponse(await cancelAutomation());
          return;
        case 'open-automations':
          sendResponse(await openAutomationsInLauncher());
          return;
        case 'sync-now':
          sendResponse(await pushToLauncher({manual: true}));
          return;
        case 'set-paused': {
          const paused = Boolean(message.paused);
          await setSyncState({paused});
          if (!paused) {
            // Changes made while paused had nowhere to go and the next
            // automatic trigger could be arbitrarily far off -- unpausing
            // has to be a trigger itself (Important 11).
            void pushToLauncher().catch(reportUnhandled('push after unpause'));
          }
          sendResponse({ok: true});
          return;
        }
        case 'pull-from-launcher':
          // `setId` omitted -> the assigned set, which is what the single
          // "Load from Launcher" button always meant. Present -> the panel's
          // picker chose a set from the workspace library.
          sendResponse(await pullFromLauncher(message.setId));
          return;
        case 'list-launcher-cookies':
          sendResponse(await listLauncherCookies(message.setId));
          return;
        case 'list-launcher-cookie-sets':
          sendResponse(await listLauncherCookieSets());
          return;
        case 'overwrite-set':
          sendResponse(await overwriteSet(message.setId, message.cookies));
          return;
        case 'resume-sync':
          sendResponse(await resumeSyncToAssigned());
          return;
        case 'save-as-set':
          // `message.cookies` omitted -> the whole current jar (popup's
          // "Save to Cookies tab…"); present -> exactly the rows the caller
          // chose (editor's scope picker: selected / filtered / all).
          sendResponse(await saveAsSet(message.name, message.cookies));
          return;
        case 'export-cookies':
          sendResponse(await exportCookies(message.scope, message.format));
          return;
        case 'import-cookies': {
          const cookies = Array.isArray(message.cookies) ? message.cookies :
            Array.isArray(message.cookies && message.cookies.cookies) ?
              message.cookies.cookies : [];
          const result = await importCookies(cookies);
          sendResponse({count: result.count, failed: result.failed});
          return;
        }
        default:
          sendResponse({ok: false, error: 'Unknown message'});
      }
    } catch (error) {
      // A handler throwing here (rather than returning an error shape) would
      // leave sendResponse uncalled and the popup's await hanging forever with
      // nothing on screen -- the same class of silent failure this rewrite
      // exists to close, just one layer up from the network calls.
      const errorMessage = error && error.message ? error.message : String(error);
      console.error('Scout cookie sync: message handler failed', message && message.type, error);
      sendResponse({ok: false, error: errorMessage});
    }
  })();
  return true;
});

// ---- per-profile auto-seed on first launch ---------------------------------
// Unchanged contract from v1: electron bundles seed-cookies.json only when the
// profile has a cookie source assigned; imported once per signature.
async function importSeedCookiesIfPresent() {
  let response;
  try {
    response = await fetch(chrome.runtime.getURL('seed-cookies.json'));
  } catch {
    // No seed-cookies.json bundled for this profile -- nothing to seed, the
    // normal case for a profile with no cookie source assigned.
    return;
  }
  if (!response.ok) return;
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    // The file exists but is not valid JSON, unlike the two returns above:
    // that is a packaging bug, not "nothing to seed", and silently dropping
    // every seed cookie here would be indistinguishable from the normal case.
    console.error('Scout cookie sync: seed-cookies.json is present but could not be parsed', error);
    return;
  }
  const cookies = Array.isArray(payload) ? payload :
    Array.isArray(payload && payload.cookies) ? payload.cookies : [];
  const signature = ScoutCookieFormat.jarSignature(cookies);
  const state = await chrome.storage.local.get([SEED_IMPORTED_KEY, SEED_SIGNATURE_KEY]);
  if (state[SEED_IMPORTED_KEY] && state[SEED_SIGNATURE_KEY] === signature) return;
  const result = await importCookies(cookies);
  if (!result.count) return;
  await chrome.storage.local.set({
    [SEED_IMPORTED_KEY]: true,
    [SEED_SIGNATURE_KEY]: signature,
    seededAt: Date.now(),
    seededCount: result.count,
  });
}

// ---- side panel on toolbar click ---------------------------------------------
// The action has no default_popup, so without this the toolbar button does
// nothing at all. Registered on both lifecycle events for the reason
// extensions/onlinesim-sms/background.js does: onInstalled fires once for a
// freshly copied extension directory, onStartup on every later browser start,
// and a worker evicted between them has to re-assert the behaviour.
//
// chrome.sidePanel.open() is not usable here instead: it requires a user
// gesture, which is why the panel cannot be opened for the user at launch.
function registerPanelBehavior() {
  if (!chrome.sidePanel) return;
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})
      .catch(reportUnhandled('registering side panel behavior'));
}

// ---- action icon, per toolbar theme -----------------------------------------
// Chrome never re-tints an extension's action icon, and the toolbar is
// near-white in one theme and near-charcoal in the other, so one bitmap is
// legible in at most one of them. We ship both inks (see
// scripts/panel-icon-art.cjs) and choose here.
//
// Two signals, in order of when they become available:
//
//   1. `toolbarDark` in scout-session.json -- the appearance the launcher
//      resolved at launch, written by built-in-extensions.cjs. Available before
//      anything is opened, which is the only moment that matters for an icon
//      the user has not clicked yet.
//   2. the panel's own prefers-color-scheme, messaged in by sidepanel.js when
//      it opens and whenever it flips. Strictly better evidence -- it is the
//      rendering engine's own answer rather than another process's guess -- but
//      it does not exist until the user opens the panel once.
//
// Wrong-but-visible is the failure mode either way: both inks are legible
// enough to click, so a mis-guess is a cosmetic mismatch and never a lost
// button. That is why 1 is allowed to be a guess at all.
const ICON_SIZES = [16, 32, 48, 128];
let appliedIconDark = null;

function applyActionIcon(dark) {
  if (dark === appliedIconDark) return;
  appliedIconDark = dark;
  const dir = dark ? 'on-dark' : 'on-light';
  const path = {};
  for (const size of ICON_SIZES) {
    path[size] = `icons/${dir}/icon-${size}.png`;
  }
  // Callback form, not the promise: setIcon resolves through a callback on
  // every Chrome that has it, and the promise overload is newer than the floor
  // this extension supports.
  try {
    chrome.action.setIcon({path}, () => void chrome.runtime.lastError);
  } catch (error) {
    console.warn('Scout: could not set the action icon', error);
  }
}

async function applyActionIconFromSession() {
  const data = await sessionData();
  // No session file means this window was not launched from the launcher, and
  // there is nothing to read a theme from. Leave the manifest's default in
  // place rather than guessing dark.
  if (data && typeof data.toolbarDark === 'boolean') {
    applyActionIcon(data.toolbarDark);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  registerPanelBehavior();
  void applyActionIconFromSession().catch(reportUnhandled('action icon (onInstalled)'));
  void importSeedCookiesIfPresent().catch(reportUnhandled('seed import (onInstalled)'));
});
chrome.runtime.onStartup.addListener(() => {
  registerPanelBehavior();
  void applyActionIconFromSession().catch(reportUnhandled('action icon (onStartup)'));
  void importSeedCookiesIfPresent().catch(reportUnhandled('seed import (onStartup)'));
});
registerPanelBehavior();
void applyActionIconFromSession().catch(reportUnhandled('action icon (initial)'));
void importSeedCookiesIfPresent().catch(reportUnhandled('seed import (initial)'));
chrome.cookies.onChanged.addListener(() => schedulePush());
void pushToLauncher().catch(reportUnhandled('initial push'));
