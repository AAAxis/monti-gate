// A folder's name in a table cell, with its glyph.
//
// Lifted out of ProfilesTab, where it was an inner component so it could read
// `state` off the closure -- which it never actually needed: the folder itself
// carries the colour and the icon. Out here the Folder column can be a plain
// entry in the column registry (tables/profileColumns.tsx) rather than a reason
// for that registry to reach back into the tab that renders it.
import {FolderGlyph} from './FolderGlyph';
import type {ScoutFolder} from '../../types';

export function FolderLabel({folder, fallback}: {
  folder?: ScoutFolder | null;
  // What "no folder" is called, which differs per library: All profiles, All
  // proxies, All cookie-sets. The three tabs each had their own copy of this
  // component for the sake of that one string.
  fallback: string;
}) {
  if (!folder) {
    return <>{fallback}</>;
  }
  return (
    <span className="folder-label">
      <FolderGlyph color={folder.color} icon={folder.icon} size={13} small /> {folder.name}
    </span>
  );
}
