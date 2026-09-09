// Registering the Scout MCP server in each agent tool's own config file.
//
// Split out of main.cjs, which was 3,855 lines and where this block was already
// self-contained. It handles four things that used to be tangled together:
// where each tool keeps its config, what shape that config wants, whether our
// entry is in there right now, and whether the tool is on this machine at all.
//
// This module never imports `electron` -- every path it needs is passed in --
// so it can be required from a script or exercised without an app instance,
// the same rule profile-icons.cjs keeps.
//
// ── Why file editing rather than each tool's own CLI ─────────────────────────
// Every CLI form of this we tried (`claude mcp add`, `claude mcp add-json`)
// proved unreliable on Windows. Editing the file has no shell argument-passing
// to go wrong.
//
// ── What we write, and why it needs nothing installed ────────────────────────
// The server is `electron/mcp/server.cjs`, shipped inside this app, started by
// the agent tool through the launcher's own binary with ELECTRON_RUN_AS_NODE=1.
// That was previously an external Python MCP bridge at a checkout path
// the user had to supply -- which did not exist, could not be obtained, and so
// left every "connected" tool pointed at a missing interpreter.

const fs = require('node:fs');
const path = require('node:path');

// The name our server is registered under in every tool. Also the thing this
// module is allowed to touch: a config file may hold a dozen other servers and
// this app must leave every one of them exactly as it found it.
const SERVER_KEY = 'scout';

// ── Config locations ─────────────────────────────────────────────────────────
// Each tool keeps a single global registry. Split by platform only where the
// tool actually differs -- VS Code follows the OS convention for application
// support directories, the CLI tools all use a dotfile in $HOME on every OS.

function vscodeUserDir(home, platform) {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  }
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User');
  }
  return path.join(home, '.config', 'Code', 'User');
}

// ── Looking for the tool itself ──────────────────────────────────────────────
// The pieces the `detect` blocks below are written in terms of. They only ever
// answer "does this exact thing exist on disk", never "did we once write here".

function existsPath(candidate) {
  try {
    return fs.existsSync(candidate);
  } catch {
    // An unreadable parent directory is not evidence either way, and must not
    // throw out of a detection sweep that has other candidates left to try.
    return false;
  }
}

// Where a GUI editor is installed, per platform. macOS keeps both a system-wide
// and a per-user Applications folder and either is a normal place to drag an
// app to; Windows installers for all four of these default to
// %LOCALAPPDATA%\Programs. Linux gets nothing here on purpose -- there is no
// single convention, and it is the one platform where PATH is trustworthy.
function appBundles(home, platform, macName, winParts) {
  if (platform === 'darwin') {
    return [`/Applications/${macName}.app`, path.join(home, 'Applications', `${macName}.app`)];
  }
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(local, 'Programs', ...winParts)];
  }
  return [];
}

// PATH, plus the directories package managers actually install into.
//
// The extras are not padding: a packaged macOS app launched from Finder
// inherits launchd's PATH, which is /usr/bin:/bin:/usr/sbin:/sbin and nothing
// else -- no Homebrew, no ~/.local/bin, no npm prefix. Scanning only PATH would
// therefore miss every CLI tool the moment this app is double-clicked rather
// than run from a terminal, and label a working install "not found".
function searchDirs(home, platform) {
  const raw = process.env.PATH || '';
  const dirs = raw.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'win32') {
    return dirs;
  }
  return dirs.concat([
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.yarn', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]);
}

// Windows has no execute bit -- what makes a file runnable there is its
// extension being in PATHEXT, so the name has to be tried with each of them.
function executableNames(name, platform) {
  if (platform !== 'win32') {
    return [name];
  }
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return exts.map((ext) => name + ext.toLowerCase());
}

// Returns the full path of the first match, so the caller can show the user
// exactly what was found rather than asserting.
function findExecutable(names, home, platform) {
  const dirs = searchDirs(home, platform);
  for (const name of names) {
    for (const candidate of executableNames(name, platform)) {
      for (const dir of dirs) {
        const full = path.join(dir, candidate);
        try {
          fs.accessSync(full, fs.constants.X_OK);
          return full;
        } catch {
          // Not here, or here but not runnable -- either way, keep looking.
        }
      }
    }
  }
  return null;
}

// One row per tool. `container` is the property path our entry sits under, and
// it is the only part that genuinely differs between JSON tools:
//
//   mcpServers.scout       Claude Code, Cursor, Gemini CLI, Windsurf
//   mcp.servers.scout      OpenClaw
//   servers.scout          VS Code
//   context_servers.scout  Zed
//
// `entryShape` covers the second difference: VS Code and Claude Code want an
// explicit "type": "stdio"; the rest infer stdio from the presence of `command`.
//
// `name` is the tool as a user says it, duplicated from src/data/integrations.ts
// because nothing compiles electron/ and the two cannot share a module. It is
// only ever used in sentences the user reads, so drift shows up as odd wording
// rather than as broken behaviour.
//
// ── `detect`: the kinds of evidence, and why each row differs ────────────────
// This used to be one shared rule -- "any of these paths exists" -- with the
// tool's own dot-directory in the list. That rule reported Cursor and Windsurf
// as installed on a machine that has neither. Dot-directories outlive the
// software that made them and are shared with software that has nothing to do
// with it: ~/.gemini held only Antigravity's data on the machine this was found
// on, and Code/User held a settings.json with no VS Code anywhere. Worse,
// ~/.cursor, ~/.codeium/windsurf and Code/User are directories THIS app creates
// when it writes the config -- detection that counts our own footprint can only
// ever answer yes.
//
// So the evidence is now per tool, and of named kinds:
//
//   apps   The application bundle or installed executable. For the GUI editors
//          this is the only signal that survives an uninstall honestly: the
//          bundle goes, while everything under Application Support stays behind
//          forever. Those four tools therefore have `apps` and `bins` and no
//          `marks` at all -- leftover state is exactly the lie being fixed.
//   marks  Files the tool itself writes and this app never does. Only for the
//          CLIs, which have no bundle to look for. Never the config file we
//          write, never the bare dot-directory that holds it.
//   bins   Executable names, resolved by scanning PATH and the usual install
//          directories (see findExecutable). A hit is a real file on disk and
//          so proves presence; a miss proves nothing, because a double-clicked
//          .app inherits launchd's minimal PATH.
//   ownDir A whole directory this app can account for, used by OpenClaw alone
//          and explained on that row.
const TOOLS = {
  'claude-code': {
    name: 'Claude Code',
    format: 'json',
    configPath: (home) => path.join(home, '.claude.json'),
    container: ['mcpServers'],
    entryShape: 'typed',
    // ~/.claude.json is missing here on purpose: it is the file we write, and
    // we create it when it does not exist.
    detect: {
      bins: ['claude'],
      marks: (home) => [
        path.join(home, '.claude', 'projects'),
        path.join(home, '.claude', 'history.jsonl'),
        path.join(home, '.claude', 'statsig'),
        path.join(home, '.claude', 'ide'),
        path.join(home, '.claude', '.credentials.json'),
        path.join(home, '.claude', 'settings.json'),
      ],
    },
  },
  codex: {
    name: 'Codex',
    format: 'toml',
    configPath: (home) => path.join(home, '.codex', 'config.toml'),
    // config.toml is ours to create, so the evidence is the state Codex keeps
    // beside it: the account it signed in with, and the sessions it recorded.
    detect: {
      bins: ['codex'],
      marks: (home) => [
        path.join(home, '.codex', 'auth.json'),
        path.join(home, '.codex', 'sessions'),
        path.join(home, '.codex', 'history.jsonl'),
        path.join(home, '.codex', 'installation_id'),
        path.join(home, '.codex', 'version.json'),
        path.join(home, '.codex', 'log'),
      ],
    },
  },
  cursor: {
    name: 'Cursor',
    format: 'json',
    configPath: (home) => path.join(home, '.cursor', 'mcp.json'),
    container: ['mcpServers'],
    entryShape: 'plain',
    detect: {
      bins: ['cursor'],
      apps: (home, platform) => appBundles(home, platform, 'Cursor', ['cursor', 'Cursor.exe']),
    },
  },
  openclaw: {
    name: 'OpenClaw',
    format: 'json',
    configPath: (home) => path.join(home, '.openclaw', 'openclaw.json'),
    container: ['mcp', 'servers'],
    entryShape: 'plain',
    // The one directory this app can reason about as a whole: openclaw.json is
    // the only thing we ever put in ~/.openclaw, so anything else in there was
    // put there by OpenClaw. Every other tool's dot-directory is shared with
    // unrelated software, which is why none of them get this treatment.
    detect: {
      bins: ['openclaw'],
      ownDir: (home) => ({dir: path.join(home, '.openclaw'), ours: ['openclaw.json']}),
    },
  },
  'gemini-cli': {
    name: 'Gemini CLI',
    format: 'json',
    configPath: (home) => path.join(home, '.gemini', 'settings.json'),
    container: ['mcpServers'],
    entryShape: 'plain',
    // ~/.gemini is not evidence of anything: on the machine this bug was found
    // on it holds only Antigravity's data. settings.json is not evidence
    // either -- that is the file we write. The credentials and the install id
    // are Gemini CLI's alone.
    detect: {
      bins: ['gemini'],
      marks: (home) => [
        path.join(home, '.gemini', 'oauth_creds.json'),
        path.join(home, '.gemini', 'google_accounts.json'),
        path.join(home, '.gemini', 'installation_id'),
        path.join(home, '.gemini', 'commands'),
        path.join(home, '.gemini', 'extensions'),
        path.join(home, '.gemini', 'tmp'),
      ],
    },
  },
  windsurf: {
    name: 'Windsurf',
    format: 'json',
    configPath: (home) => path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    container: ['mcpServers'],
    entryShape: 'plain',
    // ~/.codeium/windsurf is created by us on first connect, and ~/.codeium
    // by the Codeium editor extension, which is not Windsurf. Bundle only.
    detect: {
      bins: ['windsurf'],
      apps: (home, platform) =>
        appBundles(home, platform, 'Windsurf', ['Windsurf', 'Windsurf.exe']),
    },
  },
  vscode: {
    name: 'VS Code',
    format: 'json',
    configPath: (home, platform) => path.join(vscodeUserDir(home, platform), 'mcp.json'),
    container: ['servers'],
    entryShape: 'typed',
    // Code/User survives an uninstall with settings.json and keybindings.json
    // in it -- true on the machine this bug was found on, which has the folder
    // and no VS Code. The bundle is the only thing that goes away.
    detect: {
      bins: ['code'],
      apps: (home, platform) =>
        appBundles(home, platform, 'Visual Studio Code', ['Microsoft VS Code', 'Code.exe']),
    },
  },
};

// Tools with no config file of their own. "other" is any MCP client this app
// cannot write to -- it connects by showing the user a snippet instead of
// editing anything.
const MANUAL_IDS = ['other'];

function isManual(integrationId) {
  return MANUAL_IDS.includes(integrationId);
}

function configPathFor(integrationId, home, platform) {
  const tool = TOOLS[integrationId];
  return tool ? tool.configPath(home, platform) : null;
}

// ── Reading and writing ──────────────────────────────────────────────────────

function readJsonConfig(configPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Missing or unreadable -- treat as empty, which is what the writers want:
    // a first connect should create the file rather than refuse.
  }
  return {};
}

// Atomic, because ~/.claude.json is not a config file we own -- it is Claude
// Code's live state (74 top-level keys, ~128 KB on a working install). A
// truncating write there loses the user's projects, history and onboarding
// state, not just our entry. Same directory so the rename stays on one
// filesystem and therefore stays atomic.
//
// This does NOT protect against a running Claude Code writing between our read
// and our rename -- nothing on this side can. It is why the UI tells the user
// to restart the tool after connecting.
function writeFileAtomic(configPath, contents) {
  fs.mkdirSync(path.dirname(configPath), {recursive: true});
  const temp = `${configPath}.scout-tmp`;
  try {
    fs.writeFileSync(temp, contents);
    fs.renameSync(temp, configPath);
  } catch (error) {
    try {
      fs.rmSync(temp, {force: true});
    } catch {
      // Best effort -- the original write error is the one worth reporting.
    }
    throw error;
  }
}

// Walks (creating as it goes) the container path, replacing any non-object it
// finds. A tool whose config has `mcpServers: null` or `mcpServers: []` should
// end up connected, not throw.
function containerFor(config, containerPath) {
  let node = config;
  for (const key of containerPath) {
    if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) {
      node[key] = {};
    }
    node = node[key];
  }
  return node;
}

// `spawn` is {command, args, env} -- the one description of how to start our
// server, built once by the caller so every tool is guaranteed to be handed the
// same thing.
function jsonEntry(tool, spawn) {
  const entry = tool.entryShape === 'typed' ? {type: 'stdio'} : {};
  entry.command = spawn.command;
  entry.args = [...spawn.args];
  entry.env = {...spawn.env};
  return entry;
}

// ── Codex: TOML, spliced by hand ─────────────────────────────────────────────
// There is no TOML library here and adding one to write four lines is not worth
// it. This app only ever touches its own table, so "find this exact header, cut
// to the next top-level [section] or EOF, splice" is safe.

const CODEX_HEADER = `[mcp_servers.${SERVER_KEY}]`;

// Shared by the writer and the remover so the two can never disagree about
// where our table ends. The negative lookahead keeps our own [.env] subtable
// inside the section rather than treating it as the next one.
function codexSection(existing) {
  const start = existing.indexOf(CODEX_HEADER);
  if (start === -1) {
    return null;
  }
  const afterHeader = existing.slice(start + CODEX_HEADER.length);
  const next = afterHeader.match(new RegExp(`\\n\\[(?!mcp_servers\\.${SERVER_KEY}\\.)`));
  const end = next ?
    start + CODEX_HEADER.length + next.index + 1 :
    existing.length;
  return {start, end};
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unescapeToml(value) {
  return value.replace(/\\(.)/g, '$1');
}

// Readers for exactly the three things codexBlock writes, and nothing more.
// Enough to tell a current entry from a stale one and to recover the token on
// repair; this is not a TOML parser and must not be used as one.
function tomlValue(body, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(body);
  return match ? unescapeToml(match[1]) : null;
}

function tomlArray(body, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(body);
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => unescapeToml(item[1]));
}

// The [mcp_servers.scout.env] subtable runs from its header to the end of the
// section codexSection already bounded, so a plain key = "value" sweep of the
// tail is enough.
function tomlEnvTable(body) {
  const header = body.indexOf(`[mcp_servers.${SERVER_KEY}.env]`);
  if (header === -1) {
    return {};
  }
  const env = {};
  const tail = body.slice(header);
  for (const line of tail.split('\n').slice(1)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (match) {
      env[match[1]] = unescapeToml(match[2]);
    }
  }
  return env;
}

function codexBlock(spawn) {
  const lines = [
    CODEX_HEADER,
    `command = ${tomlString(spawn.command)}`,
    `args = [${spawn.args.map(tomlString).join(', ')}]`,
    '',
    `[mcp_servers.${SERVER_KEY}.env]`,
  ];
  for (const [key, value] of Object.entries(spawn.env)) {
    lines.push(`${key} = ${tomlString(value)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function applyCodex(configPath, spawn) {
  let existing = '';
  try {
    existing = fs.readFileSync(configPath, 'utf8');
  } catch {
    // No config yet -- creating it is the correct outcome.
  }
  const block = codexBlock(spawn);
  const section = codexSection(existing);
  if (!section) {
    const separator = existing.trim().length > 0 ? '\n\n' : '';
    writeFileAtomic(configPath, existing.replace(/\s*$/, '') + separator + block);
  } else {
    writeFileAtomic(configPath, existing.slice(0, section.start) + block + existing.slice(section.end));
  }
  return configPath;
}

// ── Public surface ───────────────────────────────────────────────────────────

// Writes (or replaces) our server registration. Returns the path touched.
function applyIntegrationConfig({integrationId, home, platform, spawn}) {
  const tool = TOOLS[integrationId];
  if (!tool) {
    throw new Error(`No config writer for ${integrationId}`);
  }
  const configPath = tool.configPath(home, platform);
  if (tool.format === 'toml') {
    return applyCodex(configPath, spawn);
  }
  const config = readJsonConfig(configPath);
  containerFor(config, tool.container)[SERVER_KEY] = jsonEntry(tool, spawn);
  writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

// Deletes only our entry. The other half of connecting: revoking a key without
// this leaves the tool retrying a dead token forever, with nothing on screen
// explaining why.
function removeIntegrationConfig({integrationId, home, platform}) {
  const tool = TOOLS[integrationId];
  if (!tool) {
    return null;
  }
  const configPath = tool.configPath(home, platform);
  if (!fs.existsSync(configPath)) {
    return configPath;
  }
  if (tool.format === 'toml') {
    const existing = fs.readFileSync(configPath, 'utf8');
    const section = codexSection(existing);
    if (section) {
      const next = existing.slice(0, section.start) + existing.slice(section.end);
      writeFileAtomic(configPath, next.replace(/\n{3,}/g, '\n\n'));
    }
    return configPath;
  }
  const config = readJsonConfig(configPath);
  let node = config;
  for (const key of tool.container) {
    if (!node[key] || typeof node[key] !== 'object') {
      return configPath;
    }
    node = node[key];
  }
  if (node[SERVER_KEY]) {
    delete node[SERVER_KEY];
    writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  return configPath;
}

// What the config actually says right now, which is not the same question as
// "did this app create a key". The wiring lives in a file the user or another
// tool can edit at any time, and until this existed nothing noticed.
//
// Returns the command/args too, so the caller can tell a current entry from one
// left behind by the Python bridge.
function readIntegrationEntry({integrationId, home, platform}) {
  const tool = TOOLS[integrationId];
  if (!tool) {
    return {configPath: null, hasEntry: false, command: null, args: [], env: {}};
  }
  const configPath = tool.configPath(home, platform);
  const miss = {configPath, hasEntry: false, command: null, args: [], env: {}};
  try {
    if (tool.format === 'toml') {
      const existing = fs.readFileSync(configPath, 'utf8');
      const section = codexSection(existing);
      if (!section) {
        return miss;
      }
      const body = existing.slice(section.start, section.end);
      return {
        configPath,
        hasEntry: true,
        command: tomlValue(body, 'command'),
        args: tomlArray(body, 'args'),
        env: tomlEnvTable(body),
      };
    }
    let node = readJsonConfig(configPath);
    for (const key of tool.container) {
      if (!node[key] || typeof node[key] !== 'object') {
        return miss;
      }
      node = node[key];
    }
    const entry = node[SERVER_KEY];
    if (!entry || typeof entry !== 'object') {
      return miss;
    }
    return {
      configPath,
      hasEntry: true,
      command: typeof entry.command === 'string' ? entry.command : null,
      args: Array.isArray(entry.args) ? entry.args : [],
      env: entry.env && typeof entry.env === 'object' ? entry.env : {},
    };
  } catch {
    // No config file yet -- not connected, which `miss` already says.
    return miss;
  }
}

// An entry is stale if it names the Python bridge that no longer ships, or if
// whatever it names is simply not on disk. Both produce the same user-visible
// symptom -- the tool silently fails to start the server on every launch -- so
// both get the same repair offer.
function isStaleEntry(entry) {
  if (!entry.hasEntry || !entry.command) {
    return false;
  }
  if (/[/\\]\.venv[/\\](bin|Scripts)[/\\]python/i.test(entry.command)) {
    return true;
  }
  return !fs.existsSync(entry.command);
}

// Is the tool this config is for actually on this machine, and what says so.
//
// The evidence is returned, not just the verdict, for two reasons. The UI can
// then name the thing it found -- "/Applications/Cursor.app" reads as a fact
// where "Detected" reads as a claim -- and anyone doubting a "not found" can
// see which kinds of proof were looked for.
//
// A miss is still not proof of absence: someone can install any of these
// somewhere nothing here looks. So this never blocks connecting; it only
// decides what the card is allowed to say. Refusing to wire up a working
// install would be a worse failure than an unsure label.
function detectToolDetail(integrationId, home, platform) {
  const tool = TOOLS[integrationId];
  const detect = tool && tool.detect;
  if (!detect) {
    return {found: false, evidence: ''};
  }

  // Bundles first, then tool-written state, then an executable: strongest
  // evidence first, so the evidence string is the most convincing true thing
  // available rather than whichever check happened to run first.
  const paths = [
    ...(detect.apps ? detect.apps(home, platform) : []),
    ...(detect.marks ? detect.marks(home, platform) : []),
  ];
  const hit = paths.find(existsPath);
  if (hit) {
    return {found: true, evidence: hit};
  }

  const binary = detect.bins ? findExecutable(detect.bins, home, platform) : null;
  if (binary) {
    return {found: true, evidence: binary};
  }

  if (detect.ownDir) {
    const {dir, ours} = detect.ownDir(home, platform);
    try {
      const extra = fs.readdirSync(dir)
          .find((entry) => !ours.includes(entry) && !entry.endsWith('.scout-tmp'));
      if (extra) {
        return {found: true, evidence: path.join(dir, extra)};
      }
    } catch {
      // No directory at all, which is the same answer as an empty one.
    }
  }

  return {found: false, evidence: ''};
}

function detectTool(integrationId, home, platform) {
  return detectToolDetail(integrationId, home, platform).found;
}

module.exports = {
  SERVER_KEY,
  TOOLS,
  applyIntegrationConfig,
  configPathFor,
  detectTool,
  detectToolDetail,
  isManual,
  isStaleEntry,
  readIntegrationEntry,
  readJsonConfig,
  removeIntegrationConfig,
  writeFileAtomic,
};
