// One run, turned into the words and the numbers the Automations tab paints.
//
// Its own file for the same reason sync-status.js and tabs.js are next door: this
// extension is loaded raw by Chrome with no build step, so a module here can
// import nothing and has to publish onto the global. Loaded via <script src> in
// sidepanel.html; the CJS branch exists only for the test.
//
// Everything here is a pure function of a run summary (electron/automation/
// progress.cjs composes those, and its own test covers the arithmetic behind
// `progress`). That split is the point: this repo's vitest runs in plain node
// with no jsdom, deliberately, so the parts with a history of being got wrong --
// the phrasing per status, the bar for an indeterminate run, the clock -- are
// reachable by a test, and only the DOM writes live in sidepanel.js.
(function(root) {
  'use strict';

  // The five statuses the runner can seal a record with, plus 'running'. Each
  // gets its own sentence rather than sharing one with a status word appended:
  // "Daily login · cancelled" reads as a category, "Daily login was stopped"
  // reads as something that happened.
  //
  // `tone` is the panel's existing four-tone vocabulary, and it is what the tab's
  // dot is driven from -- so the choices here are also choices about what is
  // worth interrupting someone on another tab for.
  //
  //   running   'off'   in flight is not a verdict. A dot on every run in
  //                     progress would mark the tab for minutes at a time and
  //                     stop meaning anything.
  //   ok        'ok'    green card, no dot: nothing needs attention.
  //   partial   'warn'  a step failed and the run was told to continue. It
  //                     finished, and something in it did not.
  //   failed    'bad'   the run stopped where it broke.
  //   cancelled 'off'   the user pressed Stop. Marking the tab would be the
  //                     panel telling them about their own click.
  const STATES = {
    running: {tone: 'off', icon: 'loader', spin: true, live: true},
    ok: {tone: 'ok', icon: 'checkCircle', spin: false, live: false},
    partial: {tone: 'warn', icon: 'alertTriangle', spin: false, live: false},
    failed: {tone: 'bad', icon: 'xCircle', spin: false, live: false},
    cancelled: {tone: 'off', icon: 'pause', spin: false, live: false},
  };

  // An unrecognised status is treated as in-flight rather than as an error: the
  // runner is free to add one, and a panel that painted a red card for a status
  // it merely had not heard of would be lying about a run that was fine.
  const FALLBACK = {tone: 'off', icon: 'loader', spin: true, live: true};

  function stateOf(run) {
    return (run && STATES[run.status]) || FALLBACK;
  }

  // m:ss, or h:mm:ss once it has been going an hour. Seconds are always two
  // digits so the line does not reflow every ten seconds while someone watches
  // it, which is exactly the kind of movement that pulls the eye off the step
  // text next to it.
  //
  // A negative or unparseable elapsed reads as '' rather than as '0:00': the
  // clocks at each end of this are the same machine's, but a summary that
  // arrived with no startedAt should say nothing rather than claim it just
  // started.
  function elapsed(startedAt, at) {
    const started = Date.parse(startedAt || '');
    if (!Number.isFinite(started)) {
      return '';
    }
    const seconds = Math.floor((at - started) / 1000);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '';
    }
    const ss = String(seconds % 60).padStart(2, '0');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}:${ss}`;
    }
    const mm = String(minutes % 60).padStart(2, '0');
    return `${Math.floor(minutes / 60)}:${mm}:${ss}`;
  }

  // The bar. `indeterminate` is a real state and the caller is expected to render
  // it as motion without a position -- see progressOf() in
  // electron/automation/progress.cjs for why a run's step count can outrun its
  // declared total, and why reporting 100% for the rest of it would be a longer
  // lie than admitting we cannot say.
  //
  // A finished run always reads as full regardless of its own arithmetic: it is
  // over, and a bar frozen at 58% under the words "Daily login failed" invites
  // the reading that it is still going.
  function bar(run) {
    if (!run) {
      return {percent: 0, indeterminate: false};
    }
    if (!stateOf(run).live) {
      return {percent: 100, indeterminate: false};
    }
    if (typeof run.progress !== 'number') {
      return {percent: 0, indeterminate: true};
    }
    return {percent: Math.round(run.progress * 100), indeterminate: false};
  }

  // The line under the title: what the run last did.
  //
  // For a failed run the runner's own error is more specific than its last log
  // line -- the log says which step, the error says what went wrong in it -- so
  // the error wins where there is one.
  function step(run) {
    if (!run) {
      return '';
    }
    if (!stateOf(run).live && run.error) {
      return run.error;
    }
    return run.currentStep || '';
  }

  // "step 7 of 12 · 0:24", dropping either half that cannot be stated.
  //
  // The step count goes away entirely for a run with no usable denominator
  // rather than becoming "step 46 of 12", which is the pair that made progressOf
  // give up in the first place. What is left is the clock, which is true and is
  // most of what someone watching a long run wants anyway.
  function meta(run, at) {
    if (!run) {
      return '';
    }
    const parts = [];
    const live = stateOf(run).live;
    if (live && typeof run.progress === 'number' && run.totalSteps > 0) {
      parts.push(`step ${Math.min(run.stepCount + 1, run.totalSteps)} of ${run.totalSteps}`);
    } else if (!live && run.stepCount > 0) {
      parts.push(`${run.stepCount} step${run.stepCount === 1 ? '' : 's'}`);
    }
    const clock = live ?
      elapsed(run.startedAt, at) :
      // A sealed record carries its own duration; measuring against `at` would
      // keep counting up after the run had stopped.
      elapsed(run.startedAt, Date.parse(run.finishedAt || '') || at);
    if (clock) {
      parts.push(clock);
    }
    return parts.join(' · ');
  }

  // The whole card, in one call. `at` is passed in rather than read from the
  // clock here so the caller controls the tick and a test can name a moment.
  function describe(run, at) {
    if (!run) {
      return null;
    }
    const state = stateOf(run);
    const name = run.automationName || 'This automation';
    return {
      // Present tense while it runs, past tense once it is over. The name is the
      // headline either way -- it is what someone is looking for when they open
      // the tab.
      title: state.live ? name :
        run.status === 'ok' ? `${name} finished` :
          run.status === 'partial' ? `${name} finished with problems` :
            run.status === 'failed' ? `${name} failed` :
              run.status === 'cancelled' ? `${name} was stopped` :
                name,
      step: step(run),
      meta: meta(run, at),
      tone: state.tone,
      icon: state.icon,
      spin: state.spin,
      live: state.live,
      bar: bar(run),
    };
  }

  const api = {bar, describe, elapsed, meta, step};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ScoutRunView = api;
  }
})(globalThis);
