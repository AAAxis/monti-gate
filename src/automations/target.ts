// Which profile the step editor's Check button tests a selector against.
//
// The Run button used to share this function, and guessing was the whole
// problem: it picked a profile nobody chose and the first sign of that was the
// run dying on a proxy belonging to a profile the user was not thinking about.
// Run now asks (RunAutomationModal), so this has one caller left.
//
// The two must still agree. Checking a selector against one profile and running
// it against another is the kind of disagreement nobody notices until a
// selector that "passed" fails every run -- so `lastRunProfileId` is consulted
// first, and it is written by every run of this automation whatever started it.
// Check therefore tests against the page the last run actually used.
import type {ScoutAutomation, ScoutProfile, CloudState} from '../types';

// In order: the profile this automation last ran on, the one it runs on launch
// when there is exactly one, and otherwise whatever is highlighted on the
// Profiles tab. Anything more ambiguous than that is the user's call to make,
// which is why null is a normal answer here, not a failure.
export function runTarget(
    state: CloudState,
    automation: ScoutAutomation | null,
    selectedProfileId: string | null,
    lastRunProfileId?: string | null,
): ScoutProfile | null {
  const live = (id: string | null | undefined) => id ?
    state.profiles.find((profile) => profile.id === id && !profile.deleted_at) || null :
    null;
  // Trashed is deliberately excluded rather than merely unlikely: a profile can
  // be trashed between the run and the next Check, and a Check against a
  // profile that cannot launch is worse than no answer.
  const last = live(lastRunProfileId);
  if (last) {
    return last;
  }
  const attached = automation ?
    state.profiles.filter(
        (profile) => !profile.deleted_at && profile.automation_id === automation.id) :
    [];
  if (attached.length === 1) {
    return attached[0];
  }
  return live(selectedProfileId);
}
