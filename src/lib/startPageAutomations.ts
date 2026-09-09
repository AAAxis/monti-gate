// Which automations a profile's start page offers as tiles.
//
// One function because three places need the same answer and disagreeing would
// be silent: useProfileActions decides whether the launch needs a debugging
// port from it, buildLaunchPayload renders the tiles from it, and the Start
// page tab previews it. When the port and the tiles were worked out separately,
// a pinned automation could be drawn on a page that had no port to run it on.
//
// `pinned` is org-wide, which is why there is no join table: the per-profile
// slot is automation_id, and pinning is the many-to-many half.
import type {ScoutAutomation, ScoutProfile} from '../types';

export function startPageAutomations(
    automations: ScoutAutomation[],
    // Omitted on the Start page tab, which is previewing what every profile
    // gets rather than one profile's page: that is the pinned set alone.
    profile?: Pick<ScoutProfile, 'automation_id'>): ScoutAutomation[] {
  // deleted_at first, and here rather than at the three call sites, for the
  // same reason this function exists at all: a trashed automation that still
  // drew a tile on one of them and not the others is exactly the silent
  // disagreement the shared helper is for. A profile keeps its automation_id
  // through a soft delete so that restoring is lossless, which is precisely
  // what makes this filter necessary.
  return automations.filter((item) => !item.deleted_at && (
    item.pinned || (profile?.automation_id ? item.id === profile.automation_id : false)));
}
