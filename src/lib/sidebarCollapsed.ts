// Whether this machine keeps the sidebar rail collapsed to icons.
//
// localStorage rather than a column, for the reason introSeen.ts gives: how wide
// you keep the rail is a property of this install and this screen, not of the
// account. Someone who collapses it on a 13" laptop has said nothing about the
// 27" display they sign in from next, and carrying the choice across would be
// answering a question they did not ask.
const KEY = 'scout.sidebar';

export function isSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'collapsed';
  } catch {
    // Storage can throw outright when the renderer has no access to it. Opening
    // wide is the safe direction: the labels are how the rail is learnt, and a
    // read that always fails would otherwise hide them on every launch forever.
    return false;
  }
}

export function setSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(KEY, collapsed ? 'collapsed' : 'open');
  } catch {
    // Not persisting is survivable; the rail still opens and closes this session.
  }
}
