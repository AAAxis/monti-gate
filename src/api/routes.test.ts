// The reference view model, which the API tab renders.
//
// These run against the real electron/api/routes.json rather than a fixture.
// That is the point: the tab's job is to be a complete and honest listing of
// that table, and a fixture would let the table drift while the tests stayed
// green -- which is the exact failure the table was introduced to stop.
import {describe, expect, it} from 'vitest';
import {
  API_ROUTES, API_SESSION_TOOLS, entryMatches, mcpToolNames, referenceGroups, routeGroups,
} from './routes';

describe('referenceGroups', () => {
  it('lists every route and every session tool exactly once', () => {
    const entries = referenceGroups().flatMap((group) => group.entries);
    expect(entries).toHaveLength(API_ROUTES.length + API_SESSION_TOOLS.length);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  });

  // The reason this view model exists. routeGroups() cannot see a tool that has
  // no route, so the five page-driving tools were absent from the one screen
  // that answers "what can reach my profiles".
  it('includes tools that have no route, which routeGroups cannot', () => {
    const routed = routeGroups().flatMap((group) => group.routes.map((route) => route.mcp));
    for (const tool of API_SESSION_TOOLS) {
      expect(routed).not.toContain(tool.mcp);
    }
    const listed = referenceGroups().flatMap((group) => group.entries.map((entry) => entry.mcp));
    for (const tool of API_SESSION_TOOLS) {
      expect(listed).toContain(tool.mcp);
    }
  });

  it('gives a session tool a label and no route, so the tab prints no curl', () => {
    const entry = referenceGroups()
        .flatMap((group) => group.entries)
        .find((item) => item.id === 'scout_eval');
    expect(entry?.route).toBeUndefined();
    expect(entry?.label).toBeTruthy();
  });

  it('counts only the entries an agent can actually call', () => {
    for (const group of referenceGroups()) {
      expect(group.toolCount).toBe(group.entries.filter((entry) => entry.mcp).length);
      expect(group.toolCount).toBeLessThanOrEqual(group.entries.length);
    }
  });

  // Routes are deliberately left HTTP-only -- destructive and bulk ones. The
  // tab marks them, so the marking has to have something to mark.
  it('keeps routes with no tool, marked by a missing mcp', () => {
    const httpOnly = referenceGroups()
        .flatMap((group) => group.entries)
        .filter((entry) => !entry.mcp);
    expect(httpOnly.length).toBeGreaterThan(0);
    for (const entry of httpOnly) {
      expect(entry.route).toBeDefined();
    }
  });

  it('totals the same tools the agent brief names', () => {
    const fromGroups = referenceGroups()
        .flatMap((group) => group.entries)
        .filter((entry) => entry.mcp).length;
    expect(fromGroups).toBe(mcpToolNames().length);
  });
});

describe('entryMatches', () => {
  const entries = referenceGroups().flatMap((group) => group.entries);
  const find = (id: string) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry) {
      throw new Error(`No entry ${id}`);
    }
    return entry;
  };

  it('matches an empty needle against everything, so a cleared box hides nothing', () => {
    for (const entry of entries) {
      expect(entryMatches(entry, '')).toBe(true);
    }
  });

  it('matches on a path fragment', () => {
    expect(entryMatches(find('GET /v1/profiles'), '/v1/prof')).toBe(true);
    expect(entryMatches(find('GET /v1/profiles'), '/v1/proxies')).toBe(false);
  });

  it('matches on a tool name, including one with no route', () => {
    expect(entryMatches(find('scout_screenshot'), 'scout_screen')).toBe(true);
    expect(entryMatches(find('GET /v1/profiles'), 'scout_list_profiles')).toBe(true);
  });

  it('matches on the label, which is what someone types when they know the verb', () => {
    expect(entryMatches(find('scout_eval'), 'javascript')).toBe(true);
  });

  it('is case-insensitive, and trims, so a pasted needle still matches', () => {
    expect(entryMatches(find('scout_navigate'), 'URL')).toBe(true);
    expect(entryMatches(find('scout_screenshot'), '  SCOUT_Screenshot ')).toBe(true);
    expect(entryMatches(find('GET /v1/profiles'), '   ')).toBe(true);
  });

  it('matches the method, so "post" narrows to writes', () => {
    expect(entryMatches(find('GET /v1/profiles'), 'get /v1')).toBe(true);
  });
});
