// Run artifacts on disk.
//
//   <userData>/AutomationRuns/<runId>/run.json        the record
//   <userData>/AutomationRuns/<runId>/<i>-<stepId>.png  screenshots
//
// run.json is rewritten on every status transition, which makes it two things
// at once: the screenshot viewer's index, and the crash buffer. If the window
// is closed or the user is signed out when a run finishes, the record still
// exists and the renderer flushes it to Supabase on next mount. That flush is
// what makes run history honest rather than best-effort -- without it, "did
// last night's run work" has no answer whenever the app was not running.
//
// Screenshots stay here and never go to Supabase.
// scout_monitoring_results.screenshot_base64 already inlines images into a
// table and it will not scale; a full-page PNG runs to megabytes.

const fs = require('node:fs');
const path = require('node:path');

const RETENTION_DAYS = 14;

function runsRoot(app) {
  return path.join(app.getPath('userData'), 'AutomationRuns');
}

function runDir(app, runId) {
  return path.join(runsRoot(app), runId);
}

function ensureRunDir(app, runId) {
  const dir = runDir(app, runId);
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

// Written on every transition, so a killed process leaves the latest state.
function writeRun(app, run) {
  try {
    const dir = ensureRunDir(app, run.id);
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2), {mode: 0o600});
  } catch {
    // A run that cannot write its record still runs. Losing the buffer is
    // worth less than aborting the work it describes.
  }
}

function saveScreenshot(app, runId, index, stepId, base64) {
  const dir = ensureRunDir(app, runId);
  const name = `${String(index).padStart(3, '0')}-${stepId}.png`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
  return name;
}

function readScreenshot(app, runId, name) {
  // The name comes back from a renderer, so it is untrusted: basename strips
  // any ../ before it can climb out of the run directory.
  const safe = path.basename(String(name || ''));
  if (!safe.endsWith('.png')) {
    return null;
  }
  const file = path.join(runDir(app, runId), safe);
  if (!fs.existsSync(file)) {
    return null;
  }
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

// Runs that reached a terminal status on disk but may never have been written
// to Supabase. The renderer flushes these and then calls clearRun on each.
function pendingRuns(app) {
  const root = runsRoot(app);
  if (!fs.existsSync(root)) {
    return [];
  }
  const out = [];
  for (const entry of fs.readdirSync(root)) {
    try {
      const file = path.join(root, entry, 'run.json');
      if (!fs.existsSync(file)) {
        continue;
      }
      const run = JSON.parse(fs.readFileSync(file, 'utf8'));
      // `running` means the process died mid-run. It is still worth flushing:
      // a run that stops existing is less honest than one recorded as
      // interrupted, so it is reported as failed rather than dropped.
      if (run.status === 'running') {
        run.status = 'failed';
        run.error = run.error || 'The launcher stopped while this run was in flight';
        run.finished_at = run.finished_at || new Date().toISOString();
      }
      out.push(run);
    } catch {
      // A half-written run.json is not worth failing startup over.
    }
  }
  return out;
}

// Called once the renderer has persisted a run. Only the record goes; the
// screenshots stay until the retention sweep, because the log viewer reads them
// from disk by name.
function markFlushed(app, runId) {
  try {
    const file = path.join(runDir(app, runId), 'run.json');
    if (fs.existsSync(file)) {
      const run = JSON.parse(fs.readFileSync(file, 'utf8'));
      run.flushed = true;
      fs.writeFileSync(file, JSON.stringify(run, null, 2), {mode: 0o600});
    }
  } catch {
    // Worst case it is flushed twice, and the flush upserts.
  }
}

// Deletes run directories older than RETENTION_DAYS. Shorter than the 30-day
// Trash contract in src/lib/trash.ts on purpose: these are PNGs, not rows.
function sweep(app) {
  const root = runsRoot(app);
  if (!fs.existsSync(root)) {
    return 0;
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of fs.readdirSync(root)) {
    try {
      const dir = path.join(root, entry);
      if (fs.statSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, {recursive: true, force: true});
        removed++;
      }
    } catch {
      // Skip anything that cannot be stat'd or removed.
    }
  }
  return removed;
}

module.exports = {
  RETENTION_DAYS,
  ensureRunDir,
  markFlushed,
  pendingRuns,
  readScreenshot,
  runDir,
  runsRoot,
  saveScreenshot,
  readScreenshotFile: readScreenshot,
  sweep,
  writeRun,
};
