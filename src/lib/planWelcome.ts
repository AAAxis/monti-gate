// Which plan this machine has already congratulated each workspace on.
//
// localStorage rather than a column, for the same reason as
// src/lib/introSeen.ts: it is a property of this install. Everyone on a team
// should see the welcome once on each of their own machines, and nobody should
// see somebody else's.
//
// Keyed by org id, not a single value, because a person can belong to several
// workspaces and switch between them in the header. One shared key would let an
// upgrade in workspace A swallow the welcome for workspace B.
//
// What is stored is the plan itself rather than a "seen" boolean, and that is
// the point: it is also the *previous* plan the next time round, which is what
// lets the welcome show "5 → 300" instead of just "300". A free workspace has
// its 'free' written silently at startup precisely so the upgrade it has not
// bought yet will have a number to count up from.
const KEY = 'scout.planWelcome';

type Acknowledged = Record<string, string>;

function read(): Acknowledged {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    // Anything that is not an object of strings is treated as absent rather
    // than repaired: the only cost is one extra welcome, and the alternative is
    // trusting a shape from disk.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Acknowledged = {};
    for (const [orgId, plan] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof plan === 'string') {
        out[orgId] = plan;
      }
    }
    return out;
  } catch {
    // Storage disabled, or JSON that is not ours. Handled below in
    // lastAcknowledgedPlan, which is where the safe direction is decided.
    return {};
  }
}

// The plan this workspace was last welcomed onto, or null if never.
//
// Returns null when storage throws, which means a machine with no localStorage
// shows the welcome every launch. That is the opposite of introSeen.ts's
// choice, and deliberately: the walkthrough is reachable by hand from two
// places, so failing to "already seen" costs nothing there. This screen has no
// other entry point at all, and a paying customer who is never told what they
// bought is a worse outcome than one who is told twice.
export function lastAcknowledgedPlan(orgId: string): string | null {
  return read()[orgId] ?? null;
}

export function acknowledgePlan(orgId: string, plan: string): void {
  try {
    const next = read();
    if (next[orgId] === plan) {
      return;
    }
    next[orgId] = plan;
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Nothing to do -- worst case the welcome opens once more next launch.
  }
}
