// Who is holding this row's thing -- a proxy in the Proxies tab, a cookie-set
// in the Cookies tab. Assignment is many-to-one in both, so this is a list.
//
// The same avatars the Profiles tab draws, in the same colours, so a proxy row,
// a cookie row and a profile row all name the same profile the same way. Each
// is a badge that carries its name and stays collapsed to the circle until it
// is hovered: twenty-five rows of full names is a column as wide as the rest of
// the table, and the one row under the cursor is the only one being read.
//
// Avatars rather than a count, because "who is using this" is the question that
// decides whether a row is safe to change or throw away, and a bare "3
// profiles" makes you open something else to find out.
//
// Deliberately not a coloured badge. Down a column of twenty-five rows that
// painted half the table in the same red the failed proxy checks beside it use,
// which reads as "half my proxies are broken" -- and an unassigned proxy is
// spare capacity, not a fault.
//
// Lives here rather than in a tab because both tables ask exactly the same
// question and a second copy would drift.
import {ProfileAvatar} from './ProfileAvatar';
import type {ScoutProfile} from '../../types';

// Four avatars is about what fits before the column starts competing with the
// row's own name; the rest become "+N", and the cell's title carries them all.
const ASSIGNED_AVATAR_LIMIT = 4;

export function AssignedCell({holders, emptyLabel = 'Not assigned'}: {
  holders: ScoutProfile[];
  emptyLabel?: string;
}) {
  if (!holders.length) {
    return <span className="assigned-empty">{emptyLabel}</span>;
  }
  const shown = holders.slice(0, ASSIGNED_AVATAR_LIMIT);
  const hidden = holders.length - shown.length;
  return (
    <span className="assigned-cell" title={holders.map((profile) => profile.name).join(', ')}>
      {shown.map((profile) => (
        <span className="assigned-holder" key={profile.id}>
          <ProfileAvatar profile={profile} small />
          <span className="assigned-holder-name">{profile.name}</span>
        </span>
      ))}
      {hidden > 0 && <span className="assigned-more">+{hidden}</span>}
    </span>
  );
}
