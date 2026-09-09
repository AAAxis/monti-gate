// How the Automations grid orders its cards: your starred ones first, then
// newest first. A pure comparator, applied at render time rather than baked
// into the DB read, because stars are per-user state the query cannot see.
//
// The tiebreak on id matters more than it looks: two automations minted in the
// same millisecond (a paste, an agent batch-creating over MCP) would otherwise
// compare equal and swap places between renders as Array.prototype.sort is not
// obliged to be stable across different inputs.
import type {ScoutAutomation} from '../types';

export function compareAutomations(
    a: ScoutAutomation, b: ScoutAutomation, starred: ReadonlySet<string>): number {
  const aStarred = starred.has(a.id);
  const bStarred = starred.has(b.id);
  if (aStarred !== bStarred) {
    return aStarred ? -1 : 1;
  }
  // Missing created_at sorts last, not first: a row that somehow lost its
  // timestamp should not squat on top of the grid.
  const byCreated = (b.created_at || '').localeCompare(a.created_at || '');
  if (byCreated !== 0) {
    return byCreated;
  }
  return a.id.localeCompare(b.id);
}

export function sortAutomations(
    list: ScoutAutomation[], starredIds: string[]): ScoutAutomation[] {
  const starred = new Set(starredIds);
  return [...list].sort((a, b) => compareAutomations(a, b, starred));
}
