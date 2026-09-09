// The local API's route table, as the renderer sees it.
//
// Same arrangement as src/automations/schema.ts and for the same reason: the
// JSON is the single source of truth because nothing compiles electron/, and a
// TypeScript table would have to be maintained twice by hand. This file is the
// compile-time half.
//
// What it replaces: API_GROUPS in src/data/apiDocs.ts used to be a third
// hand-written copy of the list in main.cjs, and had drifted far enough to
// document three routes that do not exist. apiDocs now renders this instead.
import rawRoutes from '../../electron/api/routes.json';

export type ApiMethod = 'GET' | 'POST';

// How a field is spelled in an MCP inputSchema. 'steps' is the automation step
// tree -- an array of objects whose shape comes from step-schema.json, which is
// too large to inline into every tool description, so the tool points at
// scout_automation_schema instead.
//
// 'strings' and 'tags' generate the same array-of-strings schema and validate
// identically. Both exist because 'tags' predates any other list-of-strings
// field and reads as its own type in the API docs -- a `columns: tags` row
// would say the wrong thing about what that field holds.
export type ApiFieldType =
  'string' | 'number' | 'boolean' | 'object' | 'objects' | 'steps' | 'tags' | 'strings';

export type ApiField = {
  key: string;
  type: ApiFieldType;
  required?: boolean;
  description?: string;
};

export type ApiRoute = {
  method: ApiMethod;
  path: string;
  group: string;
  label: string;
  // 'unscoped' additionally requires a key with no folder scope: a key granted
  // one folder may RUN an automation but may not author one.
  //
  // The original reason was that automations were org-wide and had no folder,
  // so there was nothing for a folder scope to mean. 20260817 gave them
  // folders and that reason is gone, but the rule stays and is now a choice
  // rather than a consequence: an automation folder is filing, not a
  // permission boundary. Every member's RLS policy on `automations` is plain
  // org membership, so a scoped key that could author by folder would be
  // reading a guarantee into a label that the database does not enforce.
  // Widening this is a permissions change and wants its own change, not a
  // side effect of adding a folder rail.
  scope: 'any' | 'unscoped';
  // Present when this route's dispatch is driven from the table. The older
  // routes are documented here but still dispatched by hand in main.cjs.
  channel?: string;
  // Answered in the main process without a renderer round trip.
  local?: boolean;
  // The MCP tool fronting this route, where one exists.
  mcp?: string;
  mcpDescription?: string;
  body?: string;
  fields?: ApiField[];
};

// A tool that drives an open page over CDP and has no route of its own. See
// $sessionToolsComment in the JSON for why these carry a label.
export type ApiSessionTool = {
  mcp: string;
  group: string;
  label: string;
};

export const API_ROUTES = (rawRoutes.routes as unknown) as ApiRoute[];
export const API_SESSION_TOOLS =
  (rawRoutes.sessionTools as unknown) as ApiSessionTool[];

// Grouped for display, in the order the groups first appear in the table.
export function routeGroups(): Array<{title: string; routes: ApiRoute[]}> {
  const groups: Array<{title: string; routes: ApiRoute[]}> = [];
  for (const route of API_ROUTES) {
    const found = groups.find((group) => group.title === route.group);
    if (found) {
      found.routes.push(route);
    } else {
      groups.push({title: route.group, routes: [route]});
    }
  }
  return groups;
}

// ── The reference, as one list ───────────────────────────────────────────────
//
// The API tab used to render `routeGroups()` directly, which meant it showed
// routes and nothing else -- so the five page-driving tools, which have no
// route, appeared nowhere on the one screen that answers "what can reach my
// profiles". And a route with no tool looked identical to one with a tool,
// which is the other half of the same question: an agent cannot call
// POST /v1/proxies/delete no matter how prominently the tab documents it.
//
// So the unit here is a capability, not a route. Each entry knows both of its
// faces and either may be absent.
export type ApiEntry = {
  // Stable identity for React keys and for the open/closed set.
  id: string;
  group: string;
  label: string;
  // Absent for a session tool: there is no endpoint, so there is no curl.
  route?: ApiRoute;
  // Absent for a route deliberately left HTTP-only.
  mcp?: string;
};

export type ApiEntryGroup = {
  title: string;
  entries: ApiEntry[];
  // Counted rather than derived at render time, because both numbers are in
  // the collapsed summary and that is the whole point of collapsing it: you
  // should not have to open a group to learn how much is in it.
  toolCount: number;
};

export function referenceGroups(): ApiEntryGroup[] {
  const groups: ApiEntryGroup[] = [];
  const into = (title: string) => {
    const found = groups.find((group) => group.title === title);
    if (found) {
      return found;
    }
    const created: ApiEntryGroup = {title, entries: [], toolCount: 0};
    groups.push(created);
    return created;
  };

  for (const route of API_ROUTES) {
    const group = into(route.group);
    group.entries.push({
      id: `${route.method} ${route.path}`,
      group: route.group,
      label: route.label,
      route,
      mcp: route.mcp,
    });
    if (route.mcp) {
      group.toolCount += 1;
    }
  }
  for (const tool of API_SESSION_TOOLS) {
    const group = into(tool.group);
    group.entries.push({
      id: tool.mcp,
      group: tool.group,
      label: tool.label,
      mcp: tool.mcp,
    });
    group.toolCount += 1;
  }
  return groups;
}

// What a search box matches on. Path, label and tool name are the three things
// someone arrives knowing -- "screenshot", "/v1/proxies", "scout_launch".
//
// Lowercases the needle itself rather than trusting the caller to. Every caller
// does today, which is exactly why the one that eventually forgets would ship a
// search box that silently matches nothing the moment a capital is typed.
export function entryMatches(entry: ApiEntry, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const haystack = [
    entry.label,
    entry.mcp || '',
    entry.route ? `${entry.route.method} ${entry.route.path}` : '',
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

// Every tool an agent brief should name: the ones fronting a route, plus the
// CDP tools that drive an open page and have no route of their own. Derived
// rather than listed, so a tool added to the table shows up in the brief
// without a second edit -- the hand-written list this replaces named six of
// the fourteen that existed.
export function mcpToolNames(): string[] {
  const fromRoutes = API_ROUTES
      .map((route) => route.mcp)
      .filter((name): name is string => Boolean(name));
  return [...fromRoutes, ...API_SESSION_TOOLS.map((tool) => tool.mcp)];
}
