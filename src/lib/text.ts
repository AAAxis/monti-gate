export function initials(value: string) {
  return value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'A';
}

// Dates from Supabase are ISO strings. Rendered in the user's locale, day-first
// or month-first as their system says, because this is read, not parsed.
export function formatDate(value: string | null | undefined) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString(undefined, {day: 'numeric', month: 'long', year: 'numeric'});
}

// The sidebar account row is a single line shared with a 24px avatar and the
// settings gear, inside a 260px rail. CSS ellipsis alone is not enough: it
// clips at whatever width is left, which for a long local part is a few
// characters, and an unbreakable address can still push the gear off the row.
// Capping the string here keeps the row's geometry fixed; the full address
// stays available in the row's title.
const ACCOUNT_EMAIL_MAX = 24;

// Not exported: accountLabel below is the way in, and the account row is the
// only place an address is shortened. A caller reaching for this directly would
// be one that skipped the display name.
function shortenEmail(email: string) {
  if (email.length <= ACCOUNT_EMAIL_MAX) {
    return email;
  }
  const at = email.lastIndexOf('@');
  const domain = at > 0 ? email.slice(at) : '';
  // Elide the local part and keep the domain, which is the half that tells you
  // which account you are in. If the domain alone is long enough to leave no
  // recognisable local part, truncate the address as a whole instead.
  const room = ACCOUNT_EMAIL_MAX - domain.length - 1;
  if (!domain || room < 3) {
    return `${email.slice(0, ACCOUNT_EMAIL_MAX - 1)}…`;
  }
  return `${email.slice(0, room)}…${domain}`;
}

// What the sidebar account row calls you.
//
// The display name when there is one: it is the name the account chose, and it
// identifies the workspace you are signed into more directly than an elided
// address does. An email-code account has none until it sets one in Settings,
// so the address stays the fallback rather than the default. Either way the
// full address is still in the row's title.
//
// Capped by the same rule as shortenEmail and for the same reason -- the row's
// geometry is fixed, and a long name would push the gear off it just as a long
// local part did. A name has no domain half worth keeping, so it truncates
// plainly from the end.
export function accountLabel(displayName: string, email: string) {
  const name = displayName.trim();
  if (!name) {
    return shortenEmail(email);
  }
  return name.length <= ACCOUNT_EMAIL_MAX ? name : `${name.slice(0, ACCOUNT_EMAIL_MAX - 1)}…`;
}

// What the workspace switcher calls a workspace.
//
// `name`, never `legal_name`. The two are separate columns on purpose (see
// ScoutOrg in src/types.ts): `name` is what this workspace is called and its
// owner may rename it to "Client accounts" whenever they like, while
// `legal_name` is the company behind it. The switcher answers "where am I
// working", which is the first of those.
//
// Capped by the same rule as accountLabel: the sidebar row's geometry is fixed
// and the mark and chevron have to stay on it.
export function workspaceName(name: string | null | undefined): string {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return 'Workspace';
  }
  return trimmed.length <= ACCOUNT_EMAIL_MAX ?
    trimmed :
    `${trimmed.slice(0, ACCOUNT_EMAIL_MAX - 1)}…`;
}

export function escapeHtml(value: string) {
  return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
}

export function comparable(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

export function numberOrNull(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Merges any number of status groups into one deduped, case-insensitive list
// while keeping first-seen order and the original casing.
export function statusList(...groups: Array<Array<string | undefined | null>>) {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const group of groups) {
    for (const value of group) {
      const status = String(value || '').trim();
      const key = status.toLowerCase();
      if (!status || seen.has(key)) {
        continue;
      }
      seen.add(key);
      list.push(status);
    }
  }
  return list;
}

// The table form of the above: "04 Aug 2026".
//
// The tables used to slice the ISO string, which is unambiguous but reads as a
// serial number -- down a column of twenty-five the eye has to parse the month
// back out of a two-digit field every time. A short month name is scannable at
// a glance and, unlike "04/08/2026", cannot be misread as US ordering.
//
// Separate from formatDate rather than replacing it: that one is prose in the
// settings panels ("Renews 4 August 2026"), where the full month reads better
// and there is room for it. This one is for a column.
//
// Fixed to en-GB rather than the user's locale, which is what pins the day-
// first order and the two-digit day: a column of dates should line up, and a
// screenshot passed around the team should mean the same thing to everyone.
export function formatDateShort(value: string | null | undefined): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'});
}
