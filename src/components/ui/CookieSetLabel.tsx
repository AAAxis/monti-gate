// A cookie-set's name with its mark, for everywhere the set appears outside its
// own library.
//
// The Cookies table draws the set as a 32px plate in its Name cell, which is
// the subject of that row. Everywhere else a set is a *value* -- what this
// profile launches with -- so it gets the 20px inline plate the Folder label
// uses, and for the same reason: a Folder cell and a Cookie set cell in the
// same row have to line their names up.
//
// Round rather than the folder plate's rounded square, because round is the
// shape a set wears in its own table. One library, one mark.
import {Cookie} from 'lucide-react';
import {cookieSetColor} from '../../lib/cookieMark';
import {profileColorStyle} from '../../lib/profileColors';
import type {ScoutCookie, ScoutFolder} from '../../types';

export function CookieSetLabel({cookie, folders, text}: {
  cookie: ScoutCookie;
  // For the colour fallback -- see cookieSetColor. Passed rather than read off a
  // store, so this stays a pure function of its props the way FolderLabel is.
  folders: ScoutFolder[];
  // What to say beside the mark. Defaults to the set's name; the profile dialog
  // appends the cookie count it has always shown.
  text?: string;
}) {
  const color = cookieSetColor(cookie, folders);
  return (
    <span className="cookie-label">
      <span className="cookie-glyph" style={color ? profileColorStyle(color) : undefined}>
        <Cookie size={13} strokeWidth={1.75} />
      </span>
      {text ?? cookie.name}
    </span>
  );
}
