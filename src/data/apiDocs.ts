// Everything the API tab documents: the endpoint catalogue, and the three
// things it can hand you -- a curl line, a runnable example script, and a
// ready-to-paste brief for a coding agent.

import {mcpToolNames, routeGroups} from '../api/routes';
import type {ApiRoute} from '../api/routes';

export const API_BASE_URL = 'http://127.0.0.1:39219';

// Kept as the tab's own vocabulary so ApiTab did not have to change, but it is
// now a view of ApiRoute rather than a second list of endpoints.
export type ApiEndpoint = ApiRoute;

export type ApiGroup = {
  title: string;
  endpoints: ApiEndpoint[];
};

// The agents a user is likely to hand this API to. `wiring` is the one thing
// that genuinely differs between them: where the MCP server is registered, and
// therefore whether the agent should reach for MCP tools or plain HTTP.
export type AgentTool = {
  id: 'claude-code' | 'codex' | 'cursor' | 'gemini-cli' | 'vscode';
  name: string;
  wiring: string;
};

// The tool names come from the route table, so a tool added there shows up in
// every agent brief without a second edit. Six of them used to be listed by
// hand here and the list had already stopped being complete.
function preferMcp(where: string) {
  return `If an "monti" MCP server is registered in ${where}, prefer its tools ` +
    `(${mcpToolNames().join(', ')}) over raw HTTP; otherwise call the HTTP ` +
    'API below directly.';
}

export const AGENT_TOOLS: AgentTool[] = [
  {id: 'claude-code', name: 'Claude Code', wiring: preferMcp('~/.claude.json')},
  {id: 'codex', name: 'Codex', wiring: preferMcp('~/.codex/config.toml as [mcp_servers.monti]')},
  {id: 'cursor', name: 'Cursor', wiring: preferMcp('~/.cursor/mcp.json')},
  {id: 'gemini-cli', name: 'Gemini CLI', wiring: preferMcp('~/.gemini/settings.json')},
  {id: 'vscode', name: 'VS Code', wiring: preferMcp('the user mcp.json')},
];

// Derived from electron/api/routes.json, which is what electron/main.cjs also
// builds its allow-list from -- so what this tab documents and what the server
// answers cannot disagree. scripts/verify-api-routes.mjs asserts that.
//
// It used to be a hand-written list, and it had drifted badly: of the sixteen
// endpoints it documented, several were a REST-shaped design (POST /v1/profiles,
// POST /v1/proxies, POST /v1/profiles/{id}/launch) that was never built, and it
// advertised a `notes` field on /v1/profiles/update that the handler's whitelist
// does not have. agentPrompt() ships this to a coding agent as fact, so every
// agent handed the brief spent its first turns on 404s.
export const API_GROUPS: ApiGroup[] = routeGroups()
    .map((group) => ({title: group.title, endpoints: group.routes}));

export function authHeader() {
  return 'Authorization: Bearer <YOUR_API_KEY>';
}

export function curlFor(endpoint: ApiEndpoint) {
  const lines = [
    `curl -X ${endpoint.method} "${API_BASE_URL}${endpoint.path}"`,
    `  -H "${authHeader()}"`,
    '  -H "Content-Type: application/json"',
  ];
  if (endpoint.body) {
    lines.push(`  -d '${endpoint.body}'`);
  }
  return lines.join(' \\\n');
}

export function apiExampleScript() {
  return `#!/usr/bin/env node
// Scout Web Browser API example.
// Keep Scout Web open and signed in while running this script.

const BASE_URL = ${JSON.stringify(API_BASE_URL)};
// Create a key in Settings -> API and paste it here. Keys are only shown
// once, at creation -- Anty never stores or displays the raw value again.
const TOKEN = '<YOUR_API_KEY>';

async function monti(method, path, body) {
  const response = await fetch(\`\${BASE_URL}\${path}\`, {
    method,
    headers: {
      Authorization: \`Bearer \${TOKEN}\`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(\`\${method} \${path} failed: \${response.status} \${text}\`);
  }
  return data;
}

async function main() {
  console.log('Health:', await monti('GET', '/health'));

  // Profiles are created in the app, not over the API -- each one is an
  // identity with a fingerprint and a proxy, and minting those from a script
  // is how you end up with fifty profiles that look alike.
  const {profiles} = await monti('GET', '/v1/profiles');
  console.log('Profiles:', profiles);
  const profile = profiles[0];
  if (!profile) {
    throw new Error('Create a profile in Scout Web first.');
  }

  // The step vocabulary, so nothing below is guesswork.
  const {steps} = await monti('GET', '/v1/automations/schema');
  console.log('Step types:', Object.keys(steps).join(', '));

  const {automation} = await monti('POST', '/v1/automations/create', {
    name: 'Example: read a heading',
    steps: [
      {id: 's1', type: 'goto', url: 'https://example.com'},
      {id: 's2', type: 'waitFor', for: 'selector', selector: 'h1'},
      {id: 's3', type: 'extract', selector: 'h1', what: 'text', into: 'heading'},
    ],
  });
  console.log('Created automation:', automation.id);

  // Launches the profile if it is not already open, and returns as soon as the
  // run is registered -- it continues in the background.
  const run = await monti('POST', '/v1/automations/run', {
    automationId: automation.id,
    profileId: profile.id,
  });
  console.log('Run started:', run.runId);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}

// A ready-to-paste brief for a coding agent. Everything an agent needs to
// start calling this API without being told twice: base URL, auth scheme, the
// full endpoint list with request bodies, and the house rules it would
// otherwise have to guess (keys are per-script, the browser stays anonymous).
//
// Tailored per tool only in the first paragraph -- the agents differ in how
// they are wired up, not in what the API does.
export function agentPrompt(tool: AgentTool) {
  const endpoints = API_GROUPS
      .map((group) => {
        const rows = group.endpoints
            .map((endpoint) => {
              const line = `- ${endpoint.method} ${endpoint.path} — ${endpoint.label}`;
              return endpoint.body ? `${line}\n  body: ${endpoint.body}` : line;
            })
            .join('\n');
        return `### ${group.title}\n${rows}`;
      })
      .join('\n\n');
  return [
    `You are working in ${tool.name}. ${tool.wiring}`,
    '',
    '## Scout Web local automation API',
    '',
    `Base URL: ${API_BASE_URL} (loopback only — it is not reachable off this machine)`,
    'Auth: every /v1/* request needs `Authorization: Bearer <MONTI_API_TOKEN>`.',
    'Content-Type: application/json for requests with a body.',
    '',
    'Scout Web manages anti-detect browser profiles. Each profile is an isolated',
    'browser identity with its own proxy, fingerprint and cookie jar. The API',
    'lets you list, update and launch them, and author the automations that run',
    'against them.',
    '',
    'An automation is a tree of steps -- goto, click, type, extract, if, loop --',
    'run against one profile. Call GET /v1/automations/schema (or',
    'monti_automation_schema) for the step vocabulary before writing one; the',
    'field names are not guessable and the server rejects a tree that does not',
    'validate, naming the exact path that failed.',
    '',
    '## Endpoints',
    '',
    endpoints,
    '',
    '## Rules',
    '',
    '- A key may be scoped to specific folders. A 403 means the key cannot see',
    '  that profile, not that the profile is missing — do not retry.',
    '- Automations are shared across every folder, so a folder-scoped key may',
    '  list, read and run them but cannot create, change or delete one. That is',
    '  also a 403, and also not worth retrying.',
    '- Every step needs a unique `id` you supply. The run log addresses steps by',
    '  it, so do not reuse one across steps.',
    '- Never hardcode the token in committed files. Read it from the',
    '  MONTI_API_TOKEN environment variable.',
    '- Launching a profile starts a separate anonymous browser process. Never',
    '  pass it credentials, tokens, or anything identifying.',
    '- Profile ids are also on-disk directory names. Treat them as immutable.',
    '',
    'Confirm you can reach the API before writing code against it:',
    '',
    '```bash',
    `curl -s -H "Authorization: Bearer $MONTI_API_TOKEN" ${API_BASE_URL}/v1/profiles`,
    '```',
  ].join('\n');
}
