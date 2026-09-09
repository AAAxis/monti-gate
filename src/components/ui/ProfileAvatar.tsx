// A profile's plate in the Name column: a picture, a brand mark, or its
// initials.
//
// The initials-on-colour plate was the only answer for a long time, and it
// stops working at the scale this app is for. Thirty profiles across five
// Facebook accounts and four Instagram ones are thirty two-letter monograms in
// six tints, and the one thing that would tell them apart -- which site each is
// for -- lived in the Tags column at the far right of the table. So the plate
// now takes an image or a brand mark, and falls back to the initials.
//
// One component rather than the two inline copies it replaces (the profiles
// table and AssignedCell's holder badges), because those two drifting is
// exactly the failure the file header of AssignedCell warns about.
import {initials} from '../../lib/text';
import {parseAvatar} from '../../lib/profileAvatar';
import {profileColorStyle} from '../../lib/profileColors';
import {TagMark} from './TagChip';
import type {ScoutProfile} from '../../types';

export function ProfileAvatar({profile, small}: {
  profile: Pick<ScoutProfile, 'name' | 'color' | 'avatar'>;
  // The 22px cut used down the proxies and cookies tables' Assigned to columns,
  // where a profile is a footnote on someone else's row rather than the subject
  // of its own.
  small?: boolean;
}) {
  const parsed = parseAvatar(profile.avatar);
  const base = small ? 'avatar avatar-sm' : 'avatar';

  if (parsed?.kind === 'image') {
    // referrerPolicy for the same reason .account-avatar carries it: a picture
    // pasted from a CDN that checks the referer 403s without it, and this app
    // has no business naming itself to whoever hosts the file.
    return (
      <img
        alt=""
        className={`${base} avatar-photo`}
        referrerPolicy="no-referrer"
        src={parsed.url}
      />
    );
  }

  if (parsed?.kind === 'brand') {
    // No profileColorStyle here: a full-colour brand mark on a tinted plate is
    // two colours arguing, and the mark is the thing being recognized. It sits
    // on --paper like the extension cards' logos do.
    return (
      <span className={`${base} avatar-brand`} title={parsed.preset.label}>
        <TagMark preset={parsed.preset} size={small ? 13 : 19} />
      </span>
    );
  }

  return (
    <span className={base} style={profileColorStyle(profile.color)}>
      {initials(profile.name)}
    </span>
  );
}
