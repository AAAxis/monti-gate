const {spawnSync} = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// The bundle ensure-macos-app.cjs leaves in ~/Applications. Spelled out here
// rather than imported because it is needed *before* that script runs -- see
// stopRunningLauncher.
const launcherExecutable = path.join(
    os.homedir(), 'Applications/Scout Web.app/Contents/MacOS/Electron');

if (process.platform !== 'darwin') {
  const electron = path.join(root, 'node_modules/.bin/electron');
  const result = spawnSync(electron, [root], {stdio: 'inherit'});
  process.exit(result.status ?? 1);
}

// Every process running the launcher bundle's Electron binary *as the app*.
//
// The binary is reused to run plain Node scripts: electron/mcp/server.cjs is
// spawned with ELECTRON_RUN_AS_NODE by whatever MCP client is connected, and
// those show up under the identical executable path. Killing one would drop a
// live MCP session belonging to some other program entirely, so anything whose
// arguments name a script is not the app and is left alone -- the app is only
// ever started with a project directory or with no argument at all.
function launcherPids() {
  const found = spawnSync('/usr/bin/pgrep', ['-f', launcherExecutable], {encoding: 'utf8'});
  const pids = (found.stdout || '')
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);

  return pids.filter((pid) => {
    const line = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {encoding: 'utf8'});
    const command = (line.stdout || '').trim();
    if (!command.startsWith(launcherExecutable)) {
      return false;
    }
    return !/\.[cm]?js(\s|$)/.test(command.slice(launcherExecutable.length));
  });
}

// Why a restart has to kill first.
//
// The dev bundle runs the working tree through a symlink, so Vite reloads the
// renderer on every edit -- but the MAIN process reads electron/*.cjs exactly
// once, at startup. `open -na` does spawn a second copy, and that copy loses
// the single-instance lock in main.cjs, calls app.quit(), and its
// 'second-instance' handler merely focuses the window that was already there.
// So `npm run dev` looks like a restart, prints like a restart, and leaves the
// old main process serving IPC. A renderer that calls an ipcMain handler added
// after that process started gets "No handler registered for 'scout:...'", and
// nothing about the symptom points at the launcher being stale.
//
// Killing here rather than dropping the lock in main.cjs: the lock is what
// delivers scout:// deep links to the running copy, and a second live instance
// would fight over the same userData directory.
//
// Matched on the bundle's executable path, never on "Electron" or "scout".
// Monti Browser profiles and the per-profile launcher apps under
// ~/Applications/Scout Profiles are Electron/Chromium processes too, and
// killing a user's open browser profiles to restart the launcher would be a
// worse bug than the one this prevents. The helper processes live under
// Contents/Frameworks and do not match; they exit with their main process.
function stopRunningLauncher() {
  let pids = launcherPids();
  if (!pids.length) {
    return;
  }

  console.log(`Stopping ${pids.length} running Scout Web process(es) so this restart picks up electron/ changes.`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone between pgrep and here. Nothing to do.
    }
  }

  // Bounded wait: ensure-macos-app.cjs deletes and recopies the bundle, and
  // doing that under a live process is how you get a half-replaced app.
  for (let waited = 0; waited < 5000 && pids.length; waited += 200) {
    spawnSync('/bin/sleep', ['0.2']);
    pids = launcherPids();
  }

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Same race as above.
    }
  }
}

stopRunningLauncher();

const ensure = spawnSync(process.execPath, [path.join(__dirname, 'ensure-macos-app.cjs')], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

if (ensure.status !== 0) {
  process.exit(ensure.status ?? 1);
}

const appPath = ensure.stdout.trim().split(/\r?\n/).at(-1);
const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;
// -W (wait for the app to exit) so this script's lifetime matches the app's.
// `open` otherwise returns the moment the bundle is handed to LaunchServices,
// this process exits, and `concurrently -k` in the dev script reads that as a
// finished task and SIGTERMs its sibling -- the Vite server the app has not
// even finished loading yet. The window comes up pointing at a dead port.
// Blocking here also makes Ctrl-C do the obvious thing: it tears down the
// dev server and the launcher together.
// Spelled out rather than clustered as -naW: -a takes the next argument, so
// any letter packed in after it becomes the application name.
const result = spawnSync('/usr/bin/open', ['-n', '-W', '-a', appPath, '--args', root], {
  env,
  stdio: 'inherit',
});

process.exit(result.status ?? 0);
