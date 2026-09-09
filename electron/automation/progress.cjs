// A run record, reduced to what a watcher can be shown.
//
// Its own file, and pure, for the reason redact.cjs is: this is arithmetic with
// a history of being got wrong in a way nothing crashes on, and vitest can
// import a .cjs directly (typed by the hand-written .d.cts next door) while it
// cannot import the runner, which pulls in a CDP socket and the disk store.
//
// The consumer is the Scout Panel's Automations tab, which polls this roughly
// once a second while something is in flight. That is the whole reason it is a
// reduction rather than the record: the record carries the full step log, and
// shipping that down a poll would put a run's every selector and typed value
// through a loopback socket once a second to render a one-line summary.

// How far along, as a fraction, or null for "cannot say".
//
// null is a real answer here and the panel is expected to render it as an
// indeterminate bar. `total_steps` counts only the automation's TOP-LEVEL steps
// (see the Run constructor), so an `if` branch, a `loop` or a `callAutomation`
// runs steps that were never in the denominator and `step_count` overshoots it.
// A run of six declared steps whose third is a loop over forty rows would
// otherwise report 700% complete, and a bar pinned at 100% for the remaining
// four minutes is a bar that lies more quietly but lies for longer.
//
// Zero declared steps is also null rather than 0 or 1: an automation with no
// steps has no progress to describe.
function progressOf(record) {
  const total = Number(record?.total_steps) || 0;
  const done = Number(record?.step_count) || 0;
  if (total <= 0 || done > total) {
    return null;
  }
  // Clamped below as well as above: a negative count could only come from a
  // corrupt record, and a bar drawn at -20% is a layout bug rather than a
  // reading.
  return Math.min(1, Math.max(0, done / total));
}

// The last thing the run said it was doing, for the line under the bar.
//
// Read off the end of the log rather than tracked separately: the runner appends
// one entry per step as it completes it, so the last entry is the most recent
// thing that happened. That makes this "just finished X" rather than "now doing
// Y", which is the honest reading of a record written after the fact -- and the
// only one available, since a step's own start is never logged.
//
// Warnings and errors count. A retry's "failed (attempt 1)" line is exactly what
// someone watching a stalled run needs to see, and skipping to the last `info`
// would hide it.
function currentStepOf(record) {
  const log = Array.isArray(record?.log) ? record.log : [];
  for (let i = log.length - 1; i >= 0; i--) {
    const message = log[i] && log[i].message;
    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }
  return '';
}

// The compact record. Every field is either a primitive or '' -- no nested log,
// no vars bag, and nothing that could carry a secret: `vars` is redacted in the
// record but the panel has no use for it, and not sending it is stronger than
// sending it masked.
function runSummary(record) {
  if (!record) {
    return null;
  }
  return {
    runId: record.id || '',
    status: record.status || '',
    automationId: record.automation_id || '',
    automationName: record.automation_name || '',
    trigger: record.trigger || '',
    startedAt: record.started_at || null,
    finishedAt: record.finished_at || null,
    stepCount: Number(record.step_count) || 0,
    totalSteps: Number(record.total_steps) || 0,
    progress: progressOf(record),
    currentStep: currentStepOf(record),
    // Already a plain sentence by the time it reaches the record, and the panel
    // shows it verbatim -- the runner's wording is more specific than anything
    // the panel could compose from a status alone.
    error: record.error || null,
  };
}

module.exports = {currentStepOf, progressOf, runSummary};
