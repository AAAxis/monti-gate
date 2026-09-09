// Every column the Cookies table can show.
//
// Tags and Folder are edited where they are read, through the same CellControls
// the Profiles and Proxies tables use -- and so are the two marks a set carries
// for the user's own benefit rather than the launcher's: its status and the
// colour of its icon.
//
// Ids are the old useTableSort keys, unchanged.
import {Cookie} from 'lucide-react';
import {AssignedCell} from '../components/ui/AssignedCell';
import {Assignee} from '../components/ui/Assignee';
import {CellColor, CellPicker, CellTags} from '../components/ui/CellControls';
import {FolderLabel} from '../components/ui/FolderLabel';
import {StatusChip} from '../components/ui/StatusChip';
import {defaultCookieStatus} from '../data/statuses';
import {assigneeName} from '../lib/assignees';
import {cookieSetColor} from '../lib/cookieMark';
import {profileColorStyle} from '../lib/profileColors';
import {daysUntilPurge} from '../lib/trash';
import {formatDateShort} from '../lib/text';
import type {CellOption} from '../components/ui/CellControls';
import type {TableColumn} from './columns';
import type {TagUsage} from '../lib/tags';
import type {ScoutCookie, ScoutFolder, ScoutProfile, CloudState} from '../types';

export type CookieColumnContext = {
  state: CloudState;
  folderFor: (cookie: ScoutCookie) => ScoutFolder | null | undefined;
  // How many profiles each set seeds, counted once for the whole table rather
  // than per row -- the same map the sort and the filter read.
  usage: Map<string, number>;
  profilesUsing: (cookieId: string) => ScoutProfile[];
  // Every tag in use across the workspace's cookie sets, for the Tags cell's
  // suggestion row -- deliberately the cookie list, not the profiles' one:
  // the two vocabularies are kept separate on purpose.
  tagOptions: TagUsage[];
  options: CookieCellOptions;
  actions: CookieCellActions;
};

export type CookieCellOptions = {
  folders: CellOption[];
  statuses: CellOption[];
};

// Every write lands in cookies.save, a partial patch -- the rules live in
// tables/cookieCellActions.tsx.
export type CookieCellActions = {
  setTags: (cookie: ScoutCookie, tags: string[]) => void;
  setFolder: (cookie: ScoutCookie, folderId: string) => void;
  setStatus: (cookie: ScoutCookie, status: string) => void;
  setColor: (cookie: ScoutCookie, color: string) => void;
};

export type CookieColumn = TableColumn<ScoutCookie, CookieColumnContext>;

export const COOKIE_COLUMNS: CookieColumn[] = [
  {
    id: 'name',
    label: 'Name',
    locked: true,
    cellClassName: 'name-cell',
    sort: (cookie) => cookie.name,
    // The icon is the set's own mark and the way to change it. Its colour falls
    // back to the folder's, which is what it was before a set could carry one:
    // a folder tint tells you where the set is filed, which is useful right up
    // to the point where two sets in one folder need telling apart.
    //
    // No `stopRowClick` on the column, deliberately -- the name beside the icon
    // still selects the row. CellColor swallows the click on the swatch alone.
    cell: (cookie, context) => (
      <>
        <CellColor
          label={`Colour for ${cookie.name}`}
          onChange={(color) => context.actions.setColor(cookie, color)}
          value={cookie.color || ''}
        >
          <span
            className="avatar"
            style={profileColorStyle(cookieSetColor(cookie, context.state.cookie_folders))}
          >
            <Cookie size={15} strokeWidth={1.75} />
          </span>
        </CellColor>
        {cookie.name}
      </>
    ),
  },
  {
    // Visible by default rather than hidden behind the column picker, the same
    // call the Proxies status column makes and for the same reason.
    id: 'status',
    label: 'Status',
    description: 'A label you mark the set with.',
    cellClassName: 'cell-fit',
    stopRowClick: true,
    sort: (cookie) => cookie.status || defaultCookieStatus,
    cell: (cookie, context) => (
      <CellPicker
        chip
        label={`Change status for ${cookie.name}`}
        onPick={(status) => context.actions.setStatus(cookie, status)}
        options={context.options.statuses}
        trigger={<StatusChip status={cookie.status || defaultCookieStatus} />}
        value={cookie.status || defaultCookieStatus}
        width={230}
      />
    ),
  },
  {
    // A count, so it opens descending: "which set has the most in it" is the
    // question the column gets asked.
    id: 'count',
    label: 'Cookies',
    firstDirection: 'desc',
    description: 'How many cookies are in the set.',
    sort: (cookie) => cookie.count,
    cell: (cookie) => cookie.count ?? '-',
  },
  {
    // Also a count, and a set nobody uses has none at all rather than a zero,
    // which keeps the unused ones out of the way in both directions.
    id: 'used',
    label: 'Used by',
    firstDirection: 'desc',
    description: 'How many profiles this set seeds at launch.',
    sort: (cookie, context) => context.usage.get(cookie.id) || undefined,
    cell: (cookie, context) => (
      <AssignedCell
        emptyLabel="Unused"
        holders={context.usage.get(cookie.id) ? context.profilesUsing(cookie.id) : []}
      />
    ),
  },
  {
    id: 'folder',
    label: 'Folder',
    stopRowClick: true,
    sort: (cookie, context) => context.folderFor(cookie)?.name,
    // A trashed row says how long it has left instead, and stays plain text --
    // the same decision the Profiles folder cell makes: the Trash pseudo-folder
    // is not a folder, and a picker on a row whose remedy is Restore would
    // fight it.
    cell: (cookie, context) => cookie.deleted_at ?
      `${daysUntilPurge(cookie.deleted_at)}d left in Trash` :
      <CellPicker
        label={`File ${cookie.name} under a folder`}
        noneLabel="All cookie-sets"
        onPick={(folderId) => context.actions.setFolder(cookie, folderId)}
        options={context.options.folders}
        trigger={<FolderLabel fallback="All cookie-sets" folder={context.folderFor(cookie)} />}
        value={cookie.folder_id || ''}
      />,
  },
  {
    // Tags is a set, not a value, so it is a CellTags rather than a picker --
    // and it has no sort for the reason the Profiles tags column has none.
    id: 'tags',
    label: 'Tags',
    stopRowClick: true,
    cell: (cookie, context) => (
      <CellTags
        label={`Edit tags for ${cookie.name}`}
        onChange={(tags) => context.actions.setTags(cookie, tags)}
        options={context.tagOptions}
        tags={cookie.tags || []}
      />
    ),
  },
  {
    id: 'assignee',
    label: 'Assigned',
    teamOnly: true,
    description: 'The teammate on the hook for this set.',
    sort: (cookie, context) => assigneeName(cookie.assigned_to, context.state.members),
    cell: (cookie) => <Assignee userId={cookie.assigned_to} />,
  },
  {
    id: 'updated',
    label: 'Updated',
    firstDirection: 'desc',
    sort: (cookie) => cookie.updated_at,
    cell: (cookie) => formatDateShort(cookie.updated_at),
  },
];
