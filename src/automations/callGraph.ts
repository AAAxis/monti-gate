// Resolving callAutomation references before a run starts.
//
// The main process has no automation catalogue -- it receives exactly one
// resolved automation per run -- so the renderer walks the call tree here and
// hands the runner a {calleeId: steps[]} map alongside the root. Everything
// that can be wrong with a reference is caught at this seam, as a sentence,
// before a browser launches: an id that names nothing, a cycle (direct or
// through intermediaries), a chain deeper than MAX_CALL_DEPTH.
//
// Pure functions, no imports from the workspace: the MCP create/update
// handlers run the same checks against their would-be-saved state, so what the
// editor refuses the API refuses identically.
import type {ScoutAutomation} from '../types';
import type {AutomationStep} from './types';

// How many callAutomation frames may stack. Matches MAX_STEP_DEPTH in spirit:
// past three levels of indirection, a flow is better restructured than run.
export const MAX_CALL_DEPTH = 3;

// Every automation id the steps reference, this level only -- branches
// included, transitive callees not. Duplicates collapsed.
export function collectCallees(steps: AutomationStep[]): string[] {
  const found = new Set<string>();
  const walk = (list: AutomationStep[]) => {
    for (const step of list) {
      if (step.type === 'callAutomation' && step.automationId) {
        found.add(step.automationId);
      }
      for (const value of Object.values(step)) {
        if (Array.isArray(value) && value.length > 0 &&
            typeof value[0] === 'object' && value[0] !== null && 'type' in value[0]) {
          walk(value as AutomationStep[]);
        }
      }
    }
  };
  walk(steps);
  return [...found];
}

export type ResolvedCallTree = {
  // calleeId -> its steps, for every automation reachable from the root.
  resolved: Record<string, AutomationStep[]>;
  problems: string[];
};

// Walk the whole tree from `automation`, depth-first. `all` is the catalogue
// to resolve against -- for a run, the loaded workspace; for an MCP update,
// the workspace with the incoming edit applied, so a save that would create a
// cycle is refused rather than discovered mid-run.
export function resolveCallTree(
    automation: Pick<ScoutAutomation, 'id' | 'name' | 'steps'>,
    all: Pick<ScoutAutomation, 'id' | 'name' | 'steps'>[]): ResolvedCallTree {
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const resolved: Record<string, AutomationStep[]> = {};
  const problems: string[] = [];
  // The ids on the current call stack -- membership means a cycle. A visited
  // set would wrongly refuse the diamond (A calls B and C, both call D).
  const stack: string[] = [];

  const visit = (entry: Pick<ScoutAutomation, 'id' | 'name' | 'steps'>, depth: number) => {
    stack.push(entry.id);
    for (const calleeId of collectCallees(entry.steps)) {
      if (stack.includes(calleeId)) {
        const cycleName = byId.get(calleeId)?.name || calleeId;
        problems.push(`${entry.name} calls ${cycleName}, which is already running ` +
          'above it — automations cannot call themselves in a circle.');
        continue;
      }
      const callee = byId.get(calleeId);
      if (!callee) {
        problems.push(
            `${entry.name} calls an automation that no longer exists (${calleeId}).`);
        continue;
      }
      if (depth + 1 > MAX_CALL_DEPTH) {
        problems.push(`${entry.name} calls ${callee.name} more than ` +
          `${MAX_CALL_DEPTH} levels deep — flatten the chain.`);
        continue;
      }
      if (!(calleeId in resolved)) {
        resolved[calleeId] = callee.steps;
        visit(callee, depth + 1);
      }
    }
    stack.pop();
  };

  visit(automation, 0);
  return {resolved, problems};
}
