// Whether this org may save another automation.
//
// Shared by the header button and the Automations tab because they had drifted
// into two copies of the same expression, and both copies had the same defect:
//
//   const limit = org.org?.automation_limit ?? 0;
//
// `org.org` is undefined until the workspace finishes loading, so that reads a
// still-loading workspace as an org entitled to zero automations, and the New
// automation button starts life disabled with the tooltip "Your plan doesn't
// include any more automations." It says the user's plan is the problem while
// the truth is that nothing has loaded yet.
//
// This is UX only, in both directions. `trg_automation_limit` is the real gate
// -- the launcher runs on hardware the customer controls, so a client-side cap
// is decoration -- and describeDbError turns that trigger's exception into the
// same sentence. Letting a click through while the org is unknown costs at
// worst one refused save with an accurate message; disabling the button costs a
// user who cannot tell a slow load from a locked feature.
import type {ScoutOrg} from '../types';

// How many runs a batch keeps in flight.
//
// **Must match MAX_CONCURRENT_RUNS in electron/automation/runner.cjs.** That is
// the real cap, and it does not queue -- going over it throws "Too many runs at
// once (3 is the limit). Wait for one to finish." with status 429. This
// constant is the renderer-side queue that stops that refusal ever being
// reached. Nothing compiles electron/, and there is no IPC that reports the
// runner's cap, so the pair is hand-kept: change one, change the other.
export const RUN_CONCURRENCY = 3;

// How long a batch waits on one run before giving its queue slot away. The
// automation's own timeout_ms plus a minute for the launch, the CDP handshake
// and the runner's own teardown -- a run that has genuinely finished always
// reports well inside this, so reaching it means the terminal event was lost.
export function runWaitCeiling(timeoutMs: number | undefined): number {
  return (timeoutMs || 300000) + 60000;
}

export type AutomationCap = {
  // Nothing is known yet. Neither allow nor deny on this -- say nothing.
  loading: boolean;
  atCap: boolean;
  limit: number | null;
};

export function automationCap(
    org: ScoutOrg | null | undefined, count: number): AutomationCap {
  if (!org) {
    return {loading: true, atCap: false, limit: null};
  }
  // null is unlimited, the convention profile_limit uses. rowToOrg currently
  // collapses null to 0 on purpose (so an un-migrated database does not read as
  // unlimited), but the check belongs here anyway: this function should not
  // depend on which of the two the mapper happens to hand it.
  const limit = org.automation_limit ?? null;
  if (limit === null) {
    return {loading: false, atCap: false, limit: null};
  }
  return {loading: false, atCap: count >= limit, limit};
}
