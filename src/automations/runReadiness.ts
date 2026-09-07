// Whether a profile can be run against right now, and whether its proxy is
// worth re-checking first.
//
// This exists because the Run button used to answer neither question. It picked
// a profile with runTarget() and handed it to the runner, and the first anyone
// heard about a dead proxy was the main process refusing the spawn several
// seconds later with "Proxy 1.2.3.4:5678 did not respond ... Fix the proxy in
// Scout Web Launcher and try again." -- a sentence about a profile the user never
// chose.
//
// Kept pure and separate from the dialog so the row chip, the tick-box's
// disabled state and the footer's blocked count are three readings of ONE
// decision rather than three expressions that agree today. It mirrors
// resolveForLaunch (workspace/useProxyActions.ts), which is the gate that
// actually blocks a launch; if the two ever disagree the dialog offers a
// profile that the launch then refuses.
import {matchedProxyForProfile} from '../lib/proxies';
import type {MontiProfile, MontiProxy} from '../types';

// Older than this and a passing check is not evidence any more. Fifteen minutes
// is chosen against what the check costs: three concurrent curls with a 10s
// ceiling, five profiles at a time. Long enough that opening the dialog twice
// in a row is free, short enough that a proxy which died over lunch is caught
// before it wastes a run.
export const STALE_AFTER_MS = 15 * 60 * 1000;

export type RunReadiness =
  // No proxy is involved, so there is nothing to check and nothing to block on.
  // free_proxy is separate from direct because the Foxywall extension owns and
  // reports its own connection state inside the session -- we cannot speak for
  // it here, and must not claim it is unreachable.
  | {kind: 'direct'}
  | {kind: 'free_proxy'}
  | {kind: 'ok'; proxy: MontiProxy}
  | {kind: 'stale'; proxy: MontiProxy}
  | {kind: 'unchecked'; proxy: MontiProxy}
  | {kind: 'failed'; proxy: MontiProxy; error: string}
  // Assigned mode with nothing usable assigned: no row, a dangling proxy_id, or
  // a row missing a host or port. All three launch nowhere.
  | {kind: 'missing'};

export function runReadiness(
    profile: MontiProfile,
    proxies: MontiProxy[],
    now: number = Date.now(),
): RunReadiness {
  // Undefined means 'assigned', for profiles saved before proxy_mode existed.
  // Getting this wrong the other way would block every legacy profile in the
  // workspace on a proxy it is not required to have.
  const mode = profile.proxy_mode || 'assigned';
  if (mode === 'direct') {
    return {kind: 'direct'};
  }
  if (mode === 'free_proxy') {
    return {kind: 'free_proxy'};
  }
  // The same resolver resolveForLaunch uses, not a find on proxy_id: it carries
  // a name-based fallback for imported profiles whose id never matched, and two
  // different answers here would mean a dialog that offers a profile the launch
  // gate then refuses.
  const proxy = matchedProxyForProfile(profile, proxies);
  if (!proxy || !proxy.host || !proxy.port) {
    return {kind: 'missing'};
  }
  if (proxy.check_error) {
    return {kind: 'failed', proxy, error: proxy.check_error};
  }
  if (!proxy.checked_at) {
    return {kind: 'unchecked', proxy};
  }
  const checkedAt = Date.parse(proxy.checked_at);
  // An unparseable timestamp is treated as no timestamp rather than as
  // infinitely old: both mean "we do not know when this passed", and 'stale'
  // would claim we do.
  if (Number.isNaN(checkedAt) || now - checkedAt > STALE_AFTER_MS) {
    return {kind: 'stale', proxy};
  }
  return {kind: 'ok', proxy};
}

// Whether this profile may be ticked. Only a proven-bad proxy blocks: 'stale'
// and 'unchecked' are questions, not answers, and the dialog resolves them by
// checking rather than by refusing.
//
// This is not the whole gate -- a profile with a run already in flight is also
// un-runnable (runner.cjs refuses a second one with 409), but that is live
// session state rather than a property of the profile, so the caller ANDs it in.
export function isRunnable(readiness: RunReadiness): boolean {
  return readiness.kind !== 'failed' && readiness.kind !== 'missing';
}

// Whether opening the dialog should spend a check on this one. A failed proxy
// is re-checked as well as the never-checked ones, because "it was broken an
// hour ago" is exactly the state a user opens this dialog to disprove.
export function needsCheck(readiness: RunReadiness): boolean {
  return readiness.kind === 'stale' ||
    readiness.kind === 'unchecked' ||
    readiness.kind === 'failed';
}

// Why the Run button cannot be pressed, as one sentence, or null when it can.
//
// The Automations tab used to disable Run for exactly one reason -- no profiles
// at all. The other way a run cannot happen is a workspace full of profiles
// whose proxies are all dead, and for that case the button stayed enabled, the
// dialog opened, every row in it was un-tickable, and its footer's Run was
// disabled with nothing anywhere naming the problem.
//
// A sentence and not a structure: the caller shows it on hover and has nothing
// else to decide. Keeping this free of UI is why the wording lives here at all
// -- the same reasoning RunAutomationModal's blocked-row summary follows.
export function describeRunBlock(
    profiles: MontiProfile[],
    proxies: MontiProxy[],
    now: number = Date.now(),
): string | null {
  // Trashed profiles are restorable, so they are not profiles you can run
  // against -- the same call the tab already makes for its Demo-profile offer.
  const live = profiles.filter((profile) => !profile.deleted_at);
  if (live.length === 0) {
    return 'No profiles yet — an automation needs one to run against.';
  }
  let failed = 0;
  let missing = 0;
  for (const profile of live) {
    const readiness = runReadiness(profile, proxies, now);
    // One runnable profile is enough. 'stale' and 'unchecked' count as runnable
    // here for the same reason isRunnable lets them through: they are questions
    // the run dialog answers by checking, not grounds for refusing.
    if (isRunnable(readiness)) {
      return null;
    }
    if (readiness.kind === 'failed') {
      failed += 1;
    } else {
      missing += 1;
    }
  }
  // One profile gets a sentence about that profile. Counting to one and
  // printing "1 has a proxy that failed its check" is technically true and
  // reads like a report about somebody else's workspace.
  if (live.length === 1) {
    return `${live[0].name || 'This profile'} can't run: ${failed > 0 ?
      'its proxy failed its last check.' :
      'it has no working proxy assigned.'}`;
  }
  const causes: string[] = [];
  if (failed > 0) {
    causes.push(`${failed} ${failed === 1 ? 'has a proxy' : 'have a proxy'} that failed its check`);
  }
  if (missing > 0) {
    causes.push(`${missing} ${missing === 1 ? 'has' : 'have'} no working proxy assigned`);
  }
  return `All ${live.length} profiles are blocked — ${causes.join(', ')}.`;
}

// The proxies a batch of profiles would have checked, each one once.
//
// Deduplicated by id rather than by profile: a folder of twenty profiles
// sharing one gateway is one curl, not twenty, and without this the five-wide
// check pool spends its whole width on the same host.
export function proxiesToCheck(
    profiles: MontiProfile[],
    proxies: MontiProxy[],
    now: number = Date.now(),
): MontiProxy[] {
  const seen = new Set<string>();
  const out: MontiProxy[] = [];
  for (const profile of profiles) {
    const readiness = runReadiness(profile, proxies, now);
    if (!needsCheck(readiness) || !('proxy' in readiness) || seen.has(readiness.proxy.id)) {
      continue;
    }
    seen.add(readiness.proxy.id);
    out.push(readiness.proxy);
  }
  return out;
}
