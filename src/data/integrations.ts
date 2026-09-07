import {Bot, Code, Hexagon, PanelsTopLeft, Plug, SquareTerminal, Waypoints, Wind} from 'lucide-react';
import claudeCodeLogo from '../assets/claude-code.svg';
import codexLogo from '../assets/codex.svg';
import cursorLogo from '../assets/cursor.svg';
import geminiCliLogo from '../assets/gemini-cli.svg';
import mcpLogo from '../assets/mcp.svg';
import openclawLogo from '../assets/openclaw.svg';
import vscodeLogo from '../assets/vscode.svg';
import windsurfLogo from '../assets/windsurf.svg';

export type IntegrationId =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'openclaw'
  | 'gemini-cli'
  | 'windsurf'
  | 'vscode'
  | 'other';

// Not sections -- the tab shows one flat list. The category drives behaviour:
// 'manual' has no config file this app can write, so connecting it means
// handing over a snippet rather than pretending to wire it up.
export type IntegrationCategory = 'agent' | 'automation' | 'manual';

export type Integration = {
  id: IntegrationId;
  name: string;
  description: string;
  category: IntegrationCategory;
  icon: typeof Hexagon;
  logo?: string;
  // Which theme the mark has to be inverted in. A single-colour mark only reads
  // on the background it was drawn for: Codex's is near-black (#111) so it
  // disappears on a dark surface, while Cursor's (#edecec) and the white-only
  // cuts of Windsurf and the MCP mark disappear on a light one. They
  // therefore invert in opposite themes, which one boolean could not express.
  // Marks that carry their own colours -- Claude Code, Gemini CLI, VS Code,
  // OpenClaw -- name neither and are left alone.
  invertOn?: 'dark' | 'light';
  // What the connect flow writes, in the user's words. Shown before anything is
  // touched, so "one click and it edited a file in my home directory" is never
  // a surprise.
  configLabel: string;
  // What the user has to do after connecting, if anything. Every one of these
  // tools reads its MCP config at process start and there is no reload signal
  // we can send, so this is always some form of "restart it".
  restartLabel: string;
  // Where that tool shows its MCP servers, so the user can confirm from the
  // other side instead of taking this app's word for it. Deliberately per-tool:
  // a generic "check its MCP settings" sends people hunting through preferences,
  // and the one thing they want after a restart is the sentence that ends the
  // question. Where a tool has a literal command for it, the command is quoted.
  confirmLabel: string;
  // Only for `category: 'manual'` -- the shape of the thing the user pastes. An
  // env-based client reads a token out of its own .env; a generic MCP client
  // wants the server block. Same key either way, two very different files.
  manualFormat?: 'env' | 'mcp';
};

// Ordered as they appear on the tab. Claude Code first because it is the one
// most of these users already have.
export const INTEGRATIONS: Integration[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's coding agent CLI. Drive profiles as tools from any project.",
    category: 'agent',
    icon: Bot,
    logo: claudeCodeLogo,
    configLabel: '~/.claude.json',
    restartLabel: 'Restart Claude Code',
    confirmLabel: 'Then run /mcp in any project — monti should be in the list.',
  },
  {
    id: 'codex',
    name: 'Codex',
    description: "OpenAI's coding agent CLI. Same tools, wired into Codex's own config.",
    category: 'agent',
    icon: SquareTerminal,
    logo: codexLogo,
    invertOn: 'dark',
    configLabel: '~/.codex/config.toml',
    restartLabel: 'Restart Codex',
    confirmLabel: 'Codex reads its MCP servers at startup — ask it what tools it has and the monti ones should be there.',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    description: "The AI editor. Registered in Cursor's global MCP config.",
    category: 'agent',
    icon: SquareTerminal,
    logo: cursorLogo,
    invertOn: 'light',
    configLabel: '~/.cursor/mcp.json',
    restartLabel: 'Reload Cursor',
    confirmLabel: 'Then open Cursor Settings → MCP: monti should be listed and switched on.',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    description: "Google's coding agent CLI. Same tools, in its own settings file.",
    category: 'agent',
    icon: Code,
    logo: geminiCliLogo,
    configLabel: '~/.gemini/settings.json',
    restartLabel: 'Restart Gemini CLI',
    confirmLabel: 'Then run /mcp — monti should be in the list.',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    description: 'The Codeium editor. Registered for Cascade to use.',
    category: 'agent',
    icon: Wind,
    logo: windsurfLogo,
    invertOn: 'light',
    configLabel: '~/.codeium/windsurf/mcp_config.json',
    restartLabel: 'Reload Windsurf',
    confirmLabel: 'Then open Cascade’s plugin panel: monti should be listed there.',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    description: 'Agent mode in Visual Studio Code, through its user MCP config.',
    category: 'agent',
    icon: PanelsTopLeft,
    logo: vscodeLogo,
    configLabel: 'Code/User/mcp.json',
    restartLabel: 'Reload VS Code',
    confirmLabel: 'Then switch Chat to Agent mode and open the tools picker — the monti tools should be listed.',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Personal assistant gateway across chat channels.',
    category: 'automation',
    icon: Waypoints,
    logo: openclawLogo,
    configLabel: '~/.openclaw/openclaw.json',
    restartLabel: 'Restart OpenClaw',
    confirmLabel: 'It loads its config at startup — monti should show up among its tools.',
  },
  {
    id: 'other',
    name: 'Any other MCP client',
    description: 'Anything that speaks MCP. Copy the server block into its config yourself.',
    category: 'manual',
    icon: Plug,
    // The protocol's own mark rather than a vendor's -- this card is the one
    // that stands for every client we have not named.
    logo: mcpLogo,
    invertOn: 'light',
    configLabel: 'whatever your client reads',
    restartLabel: 'Restart your client',
    confirmLabel: 'Your client should list monti among its MCP servers once it is back up.',
    manualFormat: 'mcp',
  },
];

export function findIntegration(id: string | null | undefined): Integration | undefined {
  return INTEGRATIONS.find((item) => item.id === id);
}

// The tools an agent gets once connected. Listed in the dialog so the value of
// connecting is visible before you do it, and kept in step with
// electron/mcp/tools.cjs by hand -- nothing compiles electron/, so they cannot
// share a module.
// A first message to paste into the connected agent. It exists because the gap
// after connecting is blank-page shaped: the tools are wired but nothing tells
// the agent to reach for them. One paragraph, tool-accurate, and cautious about
// destructive actions by instruction rather than by hoping.
export const AGENT_STARTER_PROMPT = `You are connected to Scout Web over MCP (server name: monti). It manages anti-detect browser profiles. Using the monti tools, list my profiles and tell me what you found. When I give you a task: pick or launch the right profile, drive the session with the navigate / read page text / screenshot tools, and close the session when you are done. Ask me before creating or trashing profiles, or changing a profile's proxy or fingerprint.`;

export const MCP_TOOL_SUMMARY = [
  'Create, read, update and trash profiles',
  'Set a profile\'s proxy mode and fingerprint',
  'Launch and close a profile session',
  'Navigate, read page text and screenshot',
  'List and assign proxies',
];
