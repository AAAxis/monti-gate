// Whether this machine has been shown the profiles walkthrough.
//
// localStorage rather than a column: it is a property of this install, not of
// the workspace. Two people sharing an org should each see it once, and the
// same person on a second machine should see it again there. Same reasoning and
// same storage as the theme preference (src/theme.tsx) and the active org id
// (src/db/orgs.ts).
const KEY = 'scout.profileIntroSeen';

export function hasSeenProfileIntro(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    // Storage can throw outright when the renderer has no access to it. Treating
    // that as "already seen" is the safe direction: the walkthrough is
    // reachable by hand from the empty state and from Settings, whereas a
    // read that always fails would reopen it on every launch forever.
    return true;
  }
}

export function markProfileIntroSeen(): void {
  try {
    window.localStorage.setItem(KEY, '1');
  } catch {
    // Nothing to do -- worst case it opens once more next launch.
  }
}

export function forgetProfileIntroSeen(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // As above.
  }
}
