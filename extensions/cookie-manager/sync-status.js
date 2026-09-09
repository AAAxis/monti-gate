// Turns the sync-state record background.js persists into the words the panel
// shows. Extracted from sidepanel.js so it can be tested.
//
// It earned its own file the hard way. Two user-visible bugs lived in the
// *ordering* of the branches below -- a paused profile reporting a dead session
// key forever, and a healthy relaunch opening on the previous launch's refusal
// -- and neither was reachable from a test while this logic sat inside a script
// that calls document.querySelector at load time.
//
// Same shape and same reason as cookie-format.js next door: this extension is
// loaded raw by Chrome with no build step, so it can import nothing. Loaded via
// <script src> in sidepanel.html; the CJS branch exists only for the test.
(function(root) {
  'use strict';

  // "just now" / "7 min ago" / "3 h ago" / a date. `now` is injectable so the
  // test does not have to mock the clock.
  function relativeTime(at, now) {
    if (!at) return '';
    const minutes = Math.round(((typeof now === 'number' ? now : Date.now()) - at) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString();
  }

  // Priority order matters, and it is not simply "worst news first":
  //
  //   1. not available     -- there is no launcher session to describe at all
  //   2. not reachable     -- re-measured on every attempt, so it is always live
  //   3. suppressed        -- see below
  //   4. paused            -- see below
  //   5. every lastErrorKind
  //   6. pending / in sync / never synced
  //
  // `pushSuppressed` outranks lastErrorKind for the same reason `paused` does
  // -- there will be no next attempt to disprove an old failure -- and outranks
  // `paused` itself because it is the more surprising of the two and the one
  // with something to do about it. A user who paused sync knows they paused it.
  //
  // lastErrorKind outranks pending/inSync so a real unresolved failure never
  // hides behind a stale-looking green state -- the badge can stay green while
  // lastErrorKind is 'internal' because the badge only paints a handful of
  // transport-level kinds, and this panel has room to say what actually
  // happened for every kind background.js can persist.
  //
  // But `paused` outranks lastErrorKind, because an error kind is a claim about
  // the *last attempt*, and pausing guarantees there will be no next one.
  // Ranked the other way round, a profile paused after any failure showed that
  // failure forever with nothing in the system able to disprove it.
  // background.js also clears the kind when it pauses; this ordering is what
  // covers the case it cannot reach -- a token that died while already paused.
  function classifySync(sync, now) {
    if (!sync.available) {
      return {
        tone: 'off', icon: 'circle', title: 'Sync unavailable',
        detail: 'This window was not launched from Scout Web, so cookies are not being synced.',
      };
    }
    if (!sync.reachable || sync.lastErrorKind === 'network') {
      return {
        tone: 'bad', icon: 'alertTriangle', title: 'Launcher not reachable',
        detail: sync.lastError || 'Scout Web did not answer. Cookies stay local until it is back.',
      };
    }
    // This window loaded a cookie set the profile is not assigned to, so the
    // jar and the sync target disagree. Saving now would write the loaded set's
    // cookies into the assigned one -- set B applied, set A overwritten -- so
    // nothing is saved anywhere until the user chooses where they should go.
    //
    // Amber rather than red, and the wording avoids "failed": nothing is
    // broken, this is the engine declining to guess.
    if (sync.pushSuppressed) {
      return {
        tone: 'warn', icon: 'pause', title: 'Sync paused',
        detail: sync.loadedSetName ?
          `Holding “${sync.loadedSetName}”, which isn’t assigned to this profile. ` +
              'Changes aren’t being saved.' :
          'Holding a cookie set this profile isn’t assigned. Changes aren’t being saved.',
      };
    }
    if (sync.paused) {
      return {
        tone: 'warn', icon: 'pause', title: 'Sync paused',
        detail: 'Cookies stay local until you resume or use "Save to Launcher now".',
      };
    }
    if (sync.lastErrorKind === 'refused') {
      // The bug this whole feature exists to make visible -- keep it
      // unmistakable and say what to do about it. Naming the two causes
      // matters: both are ordinary and neither is the user's fault, and "stale
      // or invalid" on its own read like corruption and sent people looking for
      // a broken profile.
      return {
        tone: 'bad', icon: 'xCircle', title: 'Launcher rejected the request',
        detail: 'This window’s session key is no longer valid — the Launcher was ' +
            'restarted, or this profile has been open more than 12 hours. ' +
            'Relaunch the profile from Scout Web to renew it.',
      };
    }
    if (sync.lastErrorKind === 'other-workspace') {
      // Amber, not red, and pointedly NOT "relaunch". Nothing is broken: the
      // launcher is showing a different workspace than the one this window was
      // launched from, and writing this profile's cookies into the workspace on
      // screen would put them somewhere they do not belong. Loading cookies
      // still works -- reads are safe across workspaces, only writes are not.
      return {
        tone: 'warn', icon: 'pause', title: 'Paused — another workspace',
        detail: sync.lastError ||
            'Scout Web is showing a different workspace. Switch back to this ' +
            'profile’s workspace to resume syncing.',
      };
    }
    if (sync.lastErrorKind === 'rate-limited') {
      return {
        tone: 'warn', icon: 'clock', title: 'Rate limited',
        detail: 'Scout Web is throttling requests right now. Sync will retry automatically.',
      };
    }
    if (sync.lastErrorKind === 'internal') {
      return {
        tone: 'bad', icon: 'alertOctagon', title: 'Sync error',
        detail: sync.lastError || 'Something went wrong inside the sync engine.',
      };
    }
    if (sync.lastErrorKind === 'saved-none') {
      return {
        tone: 'bad', icon: 'alertTriangle', title: 'Nothing was saved',
        detail: sync.lastError || 'Scout Web did not recognize any of the pushed cookies.',
      };
    }
    if (sync.lastErrorKind === 'import-failed') {
      return {
        tone: 'bad', icon: 'alertTriangle', title: 'Pull failed',
        detail: sync.lastError || 'None of the cookies from Scout Web could be applied here.',
      };
    }
    if (sync.lastErrorKind === 'server-error') {
      return {
        tone: 'bad', icon: 'alertTriangle', title: 'Launcher error',
        detail: sync.lastError || 'Scout Web answered with an error.',
      };
    }
    if (sync.pushPending) {
      return {
        tone: 'warn', icon: 'loader', spin: true, title: 'Push pending',
        detail: 'Waiting to push recent cookie changes to Scout Web…',
      };
    }
    if (sync.inSync) {
      const bits = [`${sync.pushedCount} cookie${sync.pushedCount === 1 ? '' : 's'}`];
      if (sync.lastSet) bits.push(`saved to “${sync.lastSet}”`);
      const when = relativeTime(sync.pushedAt, now);
      if (when) bits.push(when);
      return {tone: 'ok', icon: 'checkCircle', title: 'In sync with Launcher', detail: bits.join(' · ')};
    }
    return {
      tone: 'off', icon: 'circle', title: 'Not yet synced',
      detail: 'Cookies have not been sent to Scout Web yet.',
    };
  }

  const api = {classifySync, relativeTime};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ScoutSyncStatus = api;
  }
})(globalThis);
