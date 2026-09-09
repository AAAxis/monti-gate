// One automation, resolved into something the main process can actually run.
//
// The runner lives in the main process and has no catalogue: it cannot resolve
// a callAutomation reference, it cannot read a parameter declaration, and it
// cannot see the profile's stored answers to one. All of that has to be worked
// out here, in the renderer, and handed over whole.
//
// There are two callers and they must not drift:
//
//   - useProfileActions, at launch, building the tiles that ride the run token
//     so a start-page run needs no launcher window.
//   - useAutomationBridge, on demand, resolving a workflow the side panel asked
//     to run that this launch was never handed. Nothing it returns is persisted
//     -- see runAnyFromPage in main.cjs for why that matters.
//
// They used to be one copy and a comment saying "the same as the other one".
import {resolveCallTree} from '../automations/callGraph';
import {
  describeMissingParams, resolveRunVars, secretVarNames,
} from '../automations/parameters';
import type {AutomationStep, AutomationVars} from '../automations/types';
import type {ScoutAutomation, ScoutProfile} from '../types';

// An automation plus the four things the runner cannot work out for itself.
//
// `paramsBlocked` is a sentence, not a flag: it names the profile and the
// parameters it has no value for, and the run routes refuse with it verbatim
// rather than opening a browser that dies on an unresolved {{vars.x}}.
export type RunTile = ScoutAutomation & {
  // Keyed by automation id, and steps only: the runner needs a called
  // automation's body, not its row.
  resolvedAutomations?: Record<string, AutomationStep[]>;
  vars: AutomationVars;
  secretVarNames: string[];
  paramsBlocked?: string;
};

export function buildRunTile(
    automation: ScoutAutomation,
    profile: ScoutProfile,
    catalogue: ScoutAutomation[]): RunTile {
  const tree = resolveCallTree(automation, catalogue);
  const calleeParameters = Object.keys(tree.resolved).map((id) =>
    catalogue.find((entry) => entry.id === id)?.parameters || []);
  const vars = resolveRunVars({
    parameters: automation.parameters,
    calleeParameters,
    profileValues: profile.automation_vars?.[automation.id],
  });
  const missing = describeMissingParams(automation.parameters, vars);
  return {
    ...automation,
    // A tree with problems ships without a resolution rather than with a
    // partial one: the run then refuses with a sentence naming the missing
    // callee, which is a better failure than a run that gets halfway.
    ...(tree.problems.length === 0 && Object.keys(tree.resolved).length > 0 ?
      {resolvedAutomations: tree.resolved} : {}),
    vars,
    secretVarNames: secretVarNames(automation.parameters, ...calleeParameters),
    ...(missing ? {paramsBlocked: `${profile.name} ${missing}.`} : {}),
  };
}
