// The Scout MCP server. Runs as a stdio child of whichever agent tool the user
// connected -- Claude Code, Codex, Cursor, and the rest.
//
// It ships inside this app and is started through the launcher's own binary
// with ELECTRON_RUN_AS_NODE=1, so connecting installs nothing. It replaced a
// Python package (an external Python MCP bridge) at a checkout path the user had to
// supply by hand -- which did not exist and could not be obtained, so every
// "connected" tool was in fact pointed at a missing interpreter.
//
// ── stdout is the wire ───────────────────────────────────────────────────────
// The spec is blunt about it: "The server MUST NOT write anything to its stdout
// that is not a valid MCP message." One stray console.log corrupts the stream
// and every tool call fails with a parse error that names nothing useful. So
// the console is redirected onto stderr below, before anything else is
// required, and it stays that way.
//
// ── Two protocol eras ────────────────────────────────────────────────────────
// Revision 2026-07-28 dropped the `initialize` handshake: modern clients put
// the protocol version in each request's `_meta` and servers MUST implement
// `server/discover`. Everything at 2025-11-25 and earlier still handshakes.
// Clients are mid-migration, so this is a dual-era server -- it answers both,
// which the spec explicitly provides for, and gates nothing on having seen an
// initialize first.

// Redirect the console before requiring anything that might log on load.
const write = (line) => process.stdout.write(`${line}\n`);
const log = (...parts) => process.stderr.write(`[scout-mcp] ${parts.map(String).join(' ')}\n`);
console.log = log;
console.info = log;
console.debug = log;
console.warn = log;
console.error = log;

const {createClient} = require('./api.cjs');
const tools = require('./tools.cjs');

const SERVER_NAME = 'scout';
const SERVER_VERSION = process.env.SCOUT_LAUNCHER_VERSION || '1.0.0';
// Newest first -- this is the order a client picks from.
const SUPPORTED_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
const CAPABILITIES = {tools: {}};
const INSTRUCTIONS =
  'Drive Scout anti-detect browser profiles. Each profile is an isolated ' +
  'browser identity with its own proxy, fingerprint and cookie jar. Typical ' +
  'flow: scout_list_profiles, then scout_launch_profile, then scout_navigate / ' +
  'scout_read_page / scout_screenshot, then scout_close_profile. A launched ' +
  'session is anonymous — never send it credentials or tokens.';

const API_BASE = process.env.SCOUT_API_BASE || 'http://127.0.0.1:39219';
const API_TOKEN = process.env.SCOUT_API_TOKEN || '';
const api = createClient(API_BASE, API_TOKEN);

// Requests the client asked us to abandon. Checked after each await so a
// cancelled call stops sending, which the spec requires.
const cancelled = new Set();

// Requests still being worked on. Closing stdin is the shutdown signal, but
// exiting the instant it closes drops the replies to anything still in flight
// -- a client that writes a batch and closes gets silence instead of results.
// So EOF starts a drain rather than an exit.
let inFlight = 0;
let draining = false;

function exitWhenDrained() {
  draining = true;
  if (inFlight === 0) {
    process.exit(0);
  }
}

function reply(id, result) {
  write(JSON.stringify({jsonrpc: '2.0', id, result}));
}

function replyError(id, code, message, data) {
  const error = {code, message};
  if (data !== undefined) {
    error.data = data;
  }
  write(JSON.stringify({jsonrpc: '2.0', id, error}));
}

// A tool that failed at runtime is not a protocol error. Models recover from an
// isError result -- they cannot see a JSON-RPC error at all.
function toolFailure(id, message) {
  reply(id, {
    content: [{type: 'text', text: message}],
    isError: true,
    resultType: 'complete',
  });
}

function protocolVersionOf(message) {
  return message?.params?._meta?.['io.modelcontextprotocol/protocolVersion'] || null;
}

async function callTool(id, params) {
  const tool = tools.BY_NAME.get(params?.name);
  if (!tool) {
    replyError(id, -32602, `Unknown tool: ${params?.name}`);
    return;
  }
  try {
    const result = await tool.run({api, args: params.arguments || {}});
    if (cancelled.has(id)) {
      cancelled.delete(id);
      return;
    }
    reply(id, {...result, isError: false, resultType: 'complete'});
  } catch (error) {
    if (cancelled.has(id)) {
      cancelled.delete(id);
      return;
    }
    // A 403 here means the key is scoped to other folders -- worth saying
    // plainly, because retrying will never help.
    const detail = error.status === 403 ?
      `${error.message}. This connection's key is scoped to specific folders.` :
      error.message;
    toolFailure(id, detail);
  }
}

async function handle(message) {
  const {id, method, params} = message;
  const isRequest = id !== undefined && id !== null;

  // Notifications never get a reply.
  if (!isRequest) {
    if (method === 'notifications/cancelled' && params?.requestId !== undefined) {
      cancelled.add(params.requestId);
    }
    return;
  }

  // Modern clients name their version on every request. Reject one we do not
  // speak with the error that tells the client what to retry with.
  const requested = protocolVersionOf(message);
  if (requested && !SUPPORTED_VERSIONS.includes(requested)) {
    replyError(id, -32022, 'Unsupported protocol version',
        {supported: SUPPORTED_VERSIONS, requested});
    return;
  }

  switch (method) {
    // Modern era. Servers MUST implement this.
    case 'server/discover':
      reply(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        instructions: INSTRUCTIONS,
        _meta: {
          'io.modelcontextprotocol/serverInfo': {name: SERVER_NAME, version: SERVER_VERSION},
        },
      });
      return;

    // Legacy era. Echo back the client's version when we speak it, so a client
    // pinned to an older revision keeps working.
    case 'initialize': {
      const asked = params?.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : '2025-06-18',
        capabilities: CAPABILITIES,
        serverInfo: {name: SERVER_NAME, version: SERVER_VERSION},
        instructions: INSTRUCTIONS,
      });
      return;
    }

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, {tools: tools.listed(), resultType: 'complete'});
      return;

    case 'tools/call':
      await callTool(id, params);
      return;

    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Framing ──────────────────────────────────────────────────────────────────
// One JSON message per line. JSON.stringify never emits a raw newline, so
// writing `JSON.stringify(x) + '\n'` is automatically compliant on our side.

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        replyError(null, -32700, 'Parse error');
      }
      if (message) {
        // Each message is handled independently; one slow tool call must not
        // hold up the next request on the same stream.
        inFlight++;
        Promise.resolve(handle(message))
            .catch((error) => {
              log('handler failed:', error?.stack || error);
              if (message.id !== undefined && message.id !== null) {
                replyError(message.id, -32603, error?.message || 'Internal error');
              }
            })
            .finally(() => {
              inFlight--;
              if (draining && inFlight === 0) {
                process.exit(0);
              }
            });
      }
    }
    newline = buffer.indexOf('\n');
  }
});

// Closed stdin is the primary and only portable shutdown signal. Drain first,
// with a cap so a wedged tool call cannot keep the process alive forever --
// the client is entitled to expect us to go away.
process.stdin.on('end', () => {
  exitWhenDrained();
  setTimeout(() => process.exit(0), 15000).unref();
});
process.stdin.on('close', () => exitWhenDrained());

process.on('uncaughtException', (error) => log('uncaught:', error?.stack || error));
process.on('unhandledRejection', (error) => log('unhandled rejection:', error?.stack || error));

if (!API_TOKEN) {
  log('SCOUT_API_TOKEN is not set — every tool call will fail with 401. ' +
      'Reconnect this integration from Scout Web.');
}
