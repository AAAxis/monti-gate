#!/usr/bin/env node
// End-to-end check for the automation runner, with no Electron and no Supabase.
//
// Serves a local page, launches Monti Browser straight at it with
// --remote-debugging-port, drives a workflow that exercises every step type
// through electron/automation/runner.cjs, and asserts on what it produced.
//
// Why a local page rather than a real site: without a working proxy the browser
// fails closed at startup to 127.0.0.1:39217/v1.0/internal/proxy-error, which
// is StartupBrowserCreatorImpl's Scout-launch gate doing its job. That gate is
// startup-only, and Chromium bypasses the proxy for loopback -- so a CDP
// Page.navigate to 127.0.0.1 lands normally and the run is genuinely
// end-to-end. Verified before this script was written.
//
//   node scripts/verify-automation.mjs
//   MONTI_BROWSER_APP=/path/to/Monti\ Browser.app node scripts/verify-automation.mjs
//
// Exits non-zero on the first failed assertion.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const runner = require('../electron/automation/runner.cjs');
const store = require('../electron/automation/store.cjs');

const DEFAULT_APP = path.join(
    process.env.HOME || '',
    'Library/Application Support/Scout Web/browser');
const CDP_PORT = 39557;
const PAGE_PORT = 8733;

// Resolves the newest downloaded browser when MONTI_BROWSER_APP is unset --
// that is where the launcher puts the one it manages.
function resolveExecutable() {
  if (process.env.MONTI_BROWSER_APP) {
    const app = process.env.MONTI_BROWSER_APP;
    return path.join(app, 'Contents/MacOS', path.basename(app, '.app'));
  }
  if (!existsSync(DEFAULT_APP)) {
    throw new Error(`No browser found. Set MONTI_BROWSER_APP to an .app bundle.`);
  }
  for (const version of readdirSync(DEFAULT_APP)) {
    const bundle = path.join(DEFAULT_APP, version, 'Monti Browser.app');
    const binary = path.join(bundle, 'Contents/MacOS/Monti Browser');
    if (existsSync(binary)) {
      return binary;
    }
  }
  throw new Error(`No browser under ${DEFAULT_APP}. Set MONTI_BROWSER_APP.`);
}

const PAGE = `<!doctype html>
<html><head><title>Runner Probe</title></head>
<body>
  <h1 id="h">hello world</h1>
  <input id="i">
  <button id="btn" onclick="document.getElementById('out').textContent='clicked'">go</button>
  <p id="out"></p>
  <ul>
    <li class="row" data-k="a">alpha</li>
    <li class="row" data-k="b">beta</li>
    <li class="row" data-k="c">gamma</li>
  </ul>
</body></html>`;

// One workflow touching every executor, plus if and loop nesting.
const AUTOMATION = {
  id: 'verify_automation',
  name: 'Runner verification',
  variables: {seed: 'from-variables'},
  timeout_ms: 120000,
  steps: [
    {id: 's1', type: 'goto', url: `http://127.0.0.1:${PAGE_PORT}/`},
    {id: 's2', type: 'waitFor', for: 'selector', selector: '#h'},
    {id: 's3', type: 'extract', selector: '#h', what: 'text', into: 'heading'},
    // Interpolation across two namespaces, into a real input.
    {id: 's4', type: 'type', selector: '#i', text: '{{profile.email}}/{{vars.seed}}'},
    {id: 's5', type: 'extract', selector: '#i', what: 'value', into: 'typed'},
    {id: 's6', type: 'click', selector: '#btn'},
    {id: 's7', type: 'waitFor', for: 'text', text: 'clicked'},
    // Whole-field template must keep its array type for the loop below.
    {id: 's8', type: 'extract', selector: '.row', what: 'text', all: true, into: 'rows'},
    {
      id: 's9',
      type: 'loop',
      mode: 'forEach',
      items: '{{vars.rows}}',
      maxIterations: 10,
      body: [{id: 's9a', type: 'setVar', name: 'last', value: '{{loop.item}}@{{loop.index}}'}],
    },
    {
      id: 's10',
      type: 'if',
      condition: {left: '{{vars.heading}}', op: 'equals', right: 'hello world'},
      then: [{
        id: 's10a',
        type: 'evaluate',
        script: 'return vars.n * 2;',
        args: {n: '21'},
        into: 'doubled',
      }],
      else: [{id: 's10b', type: 'setVar', name: 'doubled', value: 'branch-not-taken'}],
    },
    {id: 's11', type: 'screenshot'},
    {id: 's12', type: 'wait', minMs: 20, maxMs: 60},
    // Proves onError:'continue' downgrades the run to `partial` rather than
    // failing it -- and that a failure is still logged, not swallowed.
    {id: 's13', type: 'click', selector: '#does-not-exist', onError: 'continue'},
    // This runner.start() is not given a pushCookies callback (no Electron
    // renderer here to push to), which is exactly the case the executor must
    // not silently no-op on -- onError:'continue' keeps the run going so the
    // rest of the checks below still get their turn.
    {id: 's14', type: 'saveCookies', onError: 'continue'},
  ],
};

const results = [];
function check(label, ok, detail) {
  results.push({label, ok, detail});
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`CDP never came up on ${port}`);
}

async function main() {
  const executable = resolveExecutable();
  const workDir = mkdtempSync(path.join(tmpdir(), 'scout-verify-automation-'));
  // store.cjs only ever asks for userData, so this stub is the whole Electron
  // surface the runner needs.
  const app = {getPath: () => workDir};

  const server = createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(PAGE_PORT, '127.0.0.1', resolve));

  const child = spawn(executable, [
    '--monti-profile-launch',
    '--monti-profile-id=verify-automation',
    '--monti-profile-name=Verify automation',
    `--user-data-dir=${path.join(workDir, 'udd')}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-session-restore',
    '--new-window',
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ], {stdio: 'ignore'});

  let finished = null;
  try {
    await waitForCdp(CDP_PORT, 30000);

    const runId = await runner.start({
      app,
      automation: AUTOMATION,
      profile: {id: 'verify-automation', name: 'Verify', email: 'probe@example.com'},
      trigger: 'manual',
      cdpUrl: `http://127.0.0.1:${CDP_PORT}`,
      onEvent: (event) => {
        if (event.type === 'finished') {
          finished = event.run;
        }
      },
    });
    check('start() returned a run id immediately', Boolean(runId), runId);

    const deadline = Date.now() + 120000;
    while (!finished && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!finished) {
      throw new Error('The run never finished');
    }

    // A step failed under onError:'continue', so `partial` is the correct
    // terminal status -- `ok` here would mean the policy silently swallowed it.
    check('run ended `partial` (one step failed under onError:continue)',
        finished.status === 'partial', finished.status);
    check('extract read the heading', finished.vars.heading === 'hello world',
        JSON.stringify(finished.vars.heading));
    check('interpolation mixed profile and vars namespaces',
        finished.vars.typed === 'probe@example.com/from-variables',
        JSON.stringify(finished.vars.typed));
    check('extract all returned an array of 3',
        Array.isArray(finished.vars.rows) && finished.vars.rows.length === 3,
        JSON.stringify(finished.vars.rows));
    check('whole-field template kept its array type through the loop',
        finished.vars.last === 'gamma@2', JSON.stringify(finished.vars.last));
    check('if took the then branch and evaluate got real args, not a template',
        finished.vars.doubled === 42, JSON.stringify(finished.vars.doubled));
    check('the failing step was logged as an error, not swallowed',
        finished.log.some((e) => e.level === 'error' && e.stepId === 's13'));
    check('saveCookies without a pushCookies capability threw a clear error, not a silent no-op',
        finished.log.some((e) => e.stepId === 's14' && e.level === 'error' &&
          e.message.includes('This launch cannot save cookies to the Launcher')));
    check('every step has a log line with a tree path',
        finished.log.filter((e) => e.path === '8.body.0').length === 3,
        `loop body lines: ${finished.log.filter((e) => e.path === '8.body.0').length}`);

    const shot = finished.log.find((e) => e.screenshot);
    check('screenshot was written to disk, not inlined',
        Boolean(shot) && existsSync(path.join(store.runDir(app, runId), shot.screenshot)),
        shot?.screenshot);

    // The crash buffer: run.json must exist independently of any database.
    check('run.json was buffered to disk',
        existsSync(path.join(store.runDir(app, runId), 'run.json')));
    check('pendingRuns() finds the finished run for flushing',
        store.pendingRuns(app).some((r) => r.id === runId));
  } finally {
    child.kill();
    server.close();
    // child.kill() signals, it does not wait, so the browser is often still
    // flushing its user-data-dir here -- which surfaced as an ENOTEMPTY that
    // failed the whole script *after* all twelve checks had already passed.
    // force: covers "already gone"; maxRetries: covers "not gone yet".
    rmSync(workDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('\nRun log:');
    for (const entry of finished?.log || []) {
      console.log(`  [${entry.level}] ${entry.path} ${entry.message}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('verify-automation failed:', error?.stack || error);
  process.exit(1);
});
