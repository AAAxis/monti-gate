// The cookie-set library, laid out as the Profiles tab is: a filter toolbar, the
// folder rail, a selection toolbar that appears when rows are ticked, the table,
// and the pager. Deliberately the same order and the same class names -- two tabs
// that do the same kind of work should not need to be learned twice.
//
// The selection toolbar sits *under* the folder rail because it appears and
// disappears: above it, every tick and untick moved the folder navigation.
import {useState} from 'react';
import {
  BookOpen, Copy, Cookie, FolderInput, FolderPlus, Pencil, SearchX, Share2, Trash2, UserPlus,
} from 'lucide-react';
import {MoveCookieSetsModal} from '../modals/MoveCookieSetsModal';
import {BusyButton} from '../ui/BusyButton';
import {PurgeCookieSetsModal} from '../modals/ConfirmModals';
import {Checkbox} from '../ui/Checkbox';
import {ColumnsButton} from '../ui/ColumnsButton';
import {EmptyState} from '../ui/EmptyState';
import {FolderGlyph} from '../ui/FolderGlyph';
import {PaginationBar} from '../ui/PaginationBar';
import {FolderSelect, StatusFilter, TagFilter} from '../ui/TableFilters';
import {ColumnCells, ColumnHeaders} from '../../tables/TableColumns';
import {COOKIE_COLUMNS} from '../../tables/cookieColumns';
import {useCookieCellActions, useCookieCellOptions} from '../../tables/cookieCellActions';
import {sortColumnsFrom} from '../../tables/columns';
import {useTableColumns} from '../../tables/ColumnLayouts';
import {defaultCookieStatus} from '../../data/statuses';
import {TRASH_FOLDER_ID} from '../../lib/trash';
import {useOrg} from '../../org';
import {paginate} from '../../lib/paginate';
import {tagKey} from '../../lib/tags';
import {useAsyncAction} from '../../useAsyncAction';
import {useSelection} from '../../hooks/useSelection';
import {useTableSort} from '../../hooks/useTableSort';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {CookieColumnContext} from '../../tables/cookieColumns';
import type {PurgeRequest} from '../modals/ConfirmModals';
import type {ShareRequest} from '../modals/ShareModal';
import type {ScoutCookie, ScoutFolder} from '../../types';

// Whether a set is attached to anything. Its own filter rather than a column
// sort because "which of these is nobody using" is the question that decides
// what can safely be thrown away.
type UsageFilter = '' | 'used' | 'unused';

export type CookiesTabProps = {
  // Controlled by the shell, like the profiles one: creating a folder from the
  // dialog selects it here.
  folderId: string;
  onFolderId: (folderId: string) => void;
  onOpenCookieSet: (cookie: ScoutCookie) => void;
  onAssignCookieSet: (cookie: ScoutCookie) => void;
  onNewCookieSet: () => void;
  onNewFolder: () => void;
  onEditFolder: (folder: ScoutFolder) => void;
  // Raises the share sheet, hosted by App alongside the other cross-tab dialogs.
  onShare: (request: ShareRequest) => void;
  onShowAbout: () => void;
  // Which rows arrived since this machine last looked at this tab. See
  // ProfilesTabProps.newIds and src/lib/newSince.ts.
  newIds: ReadonlySet<string>;
};

export function CookiesTab({
  folderId,
  onFolderId,
  onOpenCookieSet,
  onAssignCookieSet,
  onNewCookieSet,
  onNewFolder,
  onEditFolder,
  onShare,
  onShowAbout,
  newIds,
}: CookiesTabProps) {
  const {data, toast, library, cookies, cookieTagOptions, cookieStatusOptions} = useWorkspace();
  const org = useOrg();
  const state = data.state;
  const {run, isPending} = useAsyncAction();
  const selection = useSelection<ScoutCookie>();

  const [search, setSearch] = useState('');
  // Held as a tagKey, so "Instagram" and "instagram" are one dropdown entry.
  const [tagFilter, setTagFilter] = useState('');
  // '' for "All statuses".
  const [statusFilter, setStatusFilter] = useState('');
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('');
  // "Only what I'm on the hook for." Distinct from usageFilter beside it, which
  // asks whether any PROFILE holds the set -- a different question about a
  // different subject.
  const [mineOnly, setMineOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [moveOpen, setMoveOpen] = useState(false);
  // The pending permanent delete, shared by the row button, the bulk button and
  // Empty Trash -- one dialog, three ways in.
  const [purge, setPurge] = useState<PurgeRequest | null>(null);

  const inTrash = folderId === TRASH_FOLDER_ID;
  const filtered = Boolean(search.trim() || tagFilter || statusFilter || usageFilter || mineOnly);
  const usage = cookies.usageCounts();

  // Gates the "Assigned to me" filter chip; the Assigned column is gated by the
  // same flag inside the registry, which is where teamOnly lives now.
  const showAssignee = state.members.length > 1;

  // Options memoised, actions rebuilt every render -- see
  // tables/cookieCellActions.tsx.
  const cellOptions = useCookieCellOptions(state, cookieStatusOptions);
  const cellActions = useCookieCellActions();
  const columnContext: CookieColumnContext = {
    state,
    folderFor: cookies.folderFor,
    usage,
    profilesUsing: cookies.profilesUsing,
    tagOptions: cookieTagOptions,
    options: cellOptions,
    actions: cellActions,
  };
  const {columns, isVisible, setVisible, reset} =
    useTableColumns('cookies', COOKIE_COLUMNS, {isTeam: showAssignee});

  // What each column sorts by lives in tables/cookieColumns.tsx, and the whole
  // registry is registered rather than the visible slice -- see the note there.
  const sorting = useTableSort<ScoutCookie>(
      sortColumnsFrom(COOKIE_COLUMNS, columnContext),
      {onSortChange: () => setPage(0)});

  // Two more than the columns: the selection box and the row actions.
  const columnCount = columns.length + 2;

  // Hiding the column the table is sorted by returns it to database order.
  function toggleColumn(columnId: string, visible: boolean) {
    if (!visible && sorting.sortKey === columnId) {
      sorting.clear();
    }
    setVisible(columnId, visible);
  }

  const visible = sorting.sort(visibleCookieSets(
      state.cookies, {folderId, tagFilter, statusFilter, usageFilter, search}, usage)
      .filter((cookie) => !mineOnly || cookie.assigned_to === org.userId));
  const {items, page: clampedPage, totalPages, total} = paginate(visible, page, pageSize);

  const activeFolder = inTrash ? null :
    state.cookie_folders.find((folder) => folder.id === folderId) || null;
  const movableCount = activeFolder ?
    state.cookies.filter((cookie) => !cookie.deleted_at && cookie.folder_id !== folderId).length :
    0;
  const allCount = state.cookies.filter((cookie) => !cookie.deleted_at).length;
  const trashCount = state.cookies.length - allCount;
  const workspaceEmpty = state.cookies.length === 0;

  async function moveSelectionToFolder(nextFolderId: string) {
    if (!selection.size) {
      return;
    }
    const target = nextFolderId || null;
    if (await cookies.assignToFolder([...selection.ids], target)) {
      const folder = state.cookie_folders.find((item) => item.id === target);
      toast.setMessage(`Moved ${selection.size} to ${folder ? folder.name : 'All cookie-sets'}`);
      selection.clear();
    }
  }

  // Named consequences rather than a bare "are you sure": the profiles about to
  // lose their session are the only thing worth reading before agreeing. A
  // plain confirm is what the folder delete and the permanent delete on the
  // Profiles tab already use -- the dedicated dialog over there exists for the
  // cascading-proxy offer, which has no counterpart here.
  async function trashSets(ids: string[], label: string) {
    const affected = ids.reduce((sum, id) => sum + (usage.get(id) || 0), 0);
    const consequence = affected === 0 ?
      '' :
      ` ${affected} ${affected === 1 ? 'profile' : 'profiles'} ` +
        `${affected === 1 ? 'uses' : 'use'} it and will lose their cookies until you assign ` +
        'another set.';
    if (!window.confirm(`Move ${label} to Trash?${consequence}`)) {
      return;
    }
    if (await cookies.softDelete(ids)) {
      toast.setMessage(affected === 0 ?
        `Moved ${label} to Trash` :
        `Moved ${label} to Trash · ${affected} ${affected === 1 ? 'profile' : 'profiles'} unassigned`);
      selection.clear();
    }
  }

  async function restoreSets(ids: string[], label: string) {
    if (await cookies.restore(ids)) {
      // Said out loud because it is the one thing Restore does not put back:
      // the row returns with its folder and tags, but not its profiles.
      toast.setMessage(`Restored ${label}. Assign it to a profile to use it again.`);
      selection.clear();
    }
  }

  // The styled dialog rather than a window.confirm, matching the Profiles tab:
  // this is the irreversible delete, so it is the one that should be hard to
  // dismiss by accident and the one that says what it costs.
  function purgeSets(ids: string[], label: string) {
    setPurge({ids, count: ids.length, label});
  }

  // No ids: scoped by deleted_at server-side, which is what makes it safe with
  // nothing selected. See db/cookieSets.purgeAll.
  function emptyTrash() {
    if (!trashCount) {
      return;
    }
    setPurge({ids: [], count: trashCount, label: 'everything in Trash'});
  }

  async function duplicateOne(cookie: ScoutCookie) {
    const copy = await cookies.duplicate(cookie);
    if (copy) {
      toast.setMessage(`Duplicated as "${copy.name}"`);
    }
  }

  async function deleteFolder(folder: ScoutFolder) {
    if (!window.confirm(
        `Delete folder ${folder.name}? Cookie-sets will move to All cookie-sets.`)) {
      return;
    }
    if (await library.removeFolder(folder.id)) {
      if (folderId === folder.id) {
        onFolderId('');
      }
      toast.setMessage(`${folder.name} folder deleted`);
    }
  }

  // Nothing in the library at all -- not a filter that matched nothing and not
  // an empty folder. Every control in the toolbar would be filtering a list of
  // zero, so the whole screen becomes the invitation to add the first set.
  if (workspaceEmpty) {
    return (
      // The Proxies tab's shape: a bare centred section rather than .table-wrap,
      // whose border and raised fill would box the message inside the outline of
      // a table that has nothing in it.
      <section className="tab-empty">
        <span className="tab-empty-mark">
          <Cookie size={26} strokeWidth={1.5} />
        </span>
        <h2>No cookie-sets yet</h2>
        <p>
          A cookie-set is a saved export of a logged-in browser session. Add one
          and any profile can launch already signed in.
        </p>
        <div className="tab-empty-actions">
          <button onClick={onNewCookieSet} type="button">
            <Cookie size={18} /> Add cookie-set
          </button>
          {/* The same pairing the empty Profiles tab uses: the action, and the
            * way to find out what the action is for. Someone who has never
            * exported cookies needs the second one first. */}
          <button className="ghost" onClick={onShowAbout} type="button">
            <BookOpen size={18} /> What are cookie-sets?
          </button>
        </div>
      </section>
    );
  }

  return (
    <>
      {/* The frame, exactly as the Profiles tab draws it -- the chrome on a
        * recessed shell, the table inset in it as the content card, and the
        * height stopping here so the rows scroll rather than the page. See
        * ProfilesTab for the full reasoning; this tab has borrowed its
        * vocabulary since it was written. */}
      <div className="table-frame">
        <section className="table-toolbar">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search cookie-sets by name or tag"
          />
          {/* Only tags actually on a set: a dropdown listing every brand when the
            * library uses two of them is a list of ways to empty the table. */}
          <TagFilter value={tagFilter} options={cookieTagOptions} onChange={setTagFilter} />
          <StatusFilter
            onChange={setStatusFilter}
            options={cookieStatusOptions}
            value={statusFilter}
          />
          <select
            value={usageFilter}
            onChange={(event) => setUsageFilter(event.target.value as UsageFilter)}
          >
            <option value="">All cookie-sets</option>
            <option value="used">In use</option>
            <option value="unused">Unused</option>
          </select>
          {/* Only offered on a team; on a one-person workspace every set is
            * yours and this would never change the list. */}
          {showAssignee && (
            <button
              aria-pressed={mineOnly}
              className={mineOnly ? 'choice-chip active' : 'choice-chip'}
              onClick={() => setMineOnly((value) => !value)}
              type="button"
            >Assigned to me</button>
          )}
          {/* In the toolbar, not the selection bar: the point is that it needs no
            * selection. Same placement as the Profiles tab's. */}
          {inTrash && trashCount > 0 && (
            <button className="danger ghost" onClick={emptyTrash}>
              <Trash2 size={16} /> Empty Trash ({trashCount})
            </button>
          )}
          <ColumnsButton
            registry={COOKIE_COLUMNS}
            context={{isTeam: showAssignee}}
            isVisible={isVisible}
            onToggle={toggleColumn}
            onReset={reset}
          />
        </section>

        <section className="folder-row" aria-label="Folders">
          <button
            aria-pressed={!folderId}
            className={folderId ? 'folder-card' : 'folder-card active'}
            onClick={() => onFolderId('')}
            type="button"
          >
            <span className="folder-glyph"><Cookie size={15} strokeWidth={1.75} /></span>
            <span className="folder-card-name">All cookie-sets</span>
            <span className="folder-card-count">{allCount}</span>
          </button>

          {state.cookie_folders.map((folder) => {
            const count = state.cookies.filter((cookie) =>
              !cookie.deleted_at && cookie.folder_id === folder.id).length;
            const active = folder.id === folderId;
            return (
              // A div, not a button: the pencil and the trash are buttons of their
              // own, and nesting those inside the card's button is both invalid
              // and unclickable.
              <div className={active ? 'folder-card active' : 'folder-card'} key={folder.id}>
                <button
                  aria-pressed={active}
                  className="folder-card-main"
                  onClick={() => onFolderId(folder.id)}
                  type="button"
                >
                  <FolderGlyph color={folder.color} icon={folder.icon} />
                  <span className="folder-card-name">{folder.name}</span>
                </button>
                <span className="folder-card-count">{count}</span>
                <span className="folder-card-actions">
                  <button
                    aria-label={`Edit ${folder.name}`}
                    onClick={() => onEditFolder(folder)}
                    title={`Edit ${folder.name}`}
                    type="button"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    aria-label={`Delete ${folder.name}`}
                    className="danger-icon"
                    onClick={() => void deleteFolder(folder)}
                    title={`Delete ${folder.name}`}
                    type="button"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            );
          })}

          <button
            aria-pressed={inTrash}
            className={inTrash ? 'folder-card active' : 'folder-card'}
            onClick={() => onFolderId(TRASH_FOLDER_ID)}
            type="button"
          >
            <span className="folder-glyph"><Trash2 size={15} strokeWidth={1.75} /></span>
            <span className="folder-card-name">Trash</span>
            <span className="folder-card-count">{trashCount}</span>
          </button>

          <button className="folder-card folder-card-new" onClick={onNewFolder} type="button">
            <span className="folder-glyph"><FolderPlus size={15} strokeWidth={1.75} /></span>
            <span className="folder-card-name">New folder</span>
          </button>
        </section>

        {/* Below the folder rail, not above it: ticking a row used to insert this
          * between the filters and the folders, pushing the folder cards and the
          * table down by its height. */}
        {selection.size > 0 && (
          <section className="selection-toolbar">
            <div className="selection-toolbar-actions">
              {inTrash ? (
                <>
                  <button
                    className="ghost"
                    onClick={() => void restoreSets([...selection.ids], selectionLabel(selection.size))}
                  >
                    Restore selected
                  </button>
                  <button
                    className="danger ghost"
                    onClick={() => void purgeSets([...selection.ids], selectionLabel(selection.size))}
                  >
                    <Trash2 size={16} /> Delete forever
                  </button>
                </>
              ) : (
                <>
                  <FolderSelect
                    folders={state.cookie_folders}
                    noFolderLabel="All cookie-sets"
                    onPick={(id) => void moveSelectionToFolder(id)}
                  />
                  {/* One set at a time, because a profile carries exactly one:
                    * assigning three sets to one profile has no meaning, and
                    * silently letting the last one win would be worse. */}
                  <button
                    className="ghost"
                    disabled={selection.size !== 1}
                    onClick={() => {
                      const picked = selection.selectedFrom(state.cookies)[0];
                      if (picked) {
                        onAssignCookieSet(picked);
                      }
                    }}
                    title={selection.size === 1 ?
                      'Choose which profiles use this cookie-set' :
                      'Select exactly one cookie-set: a profile carries one at a time'}
                  >
                    <UserPlus size={16} /> Assign to profiles
                  </button>
                  <select
                    value=""
                    onChange={(event) => {
                      const format = event.target.value as 'json' | 'netscape';
                      void run('export', () =>
                        cookies.exportSets(selection.selectedFrom(state.cookies), format));
                    }}
                  >
                    <option value="" disabled>Export selected…</option>
                    <option value="json">As JSON</option>
                    <option value="netscape">As cookies.txt</option>
                  </select>
                  {/* Every cookie set is a live session, so unlike the other tabs
                    * there is no version of this that does not hand over signed-in
                    * access -- the share sheet says so and the recipient is warned
                    * again before they accept. */}
                  <button
                    className="ghost"
                    onClick={() => onShare({kind: 'cookie_set', ids: [...selection.ids]})}
                  >
                    <Share2 size={16} /> Share…
                  </button>
                  <button
                    className="danger ghost"
                    onClick={() => void trashSets([...selection.ids], selectionLabel(selection.size))}
                  >
                    <Trash2 size={16} /> Delete selected
                  </button>
                </>
              )}
            </div>
          </section>
        )}

        <section className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  {visible.length > 0 && (
                    <Checkbox
                      label={`Select all ${visible.length} cookie-sets on this page`}
                      checked={selection.allSelected(visible)}
                      indeterminate={visible.some((item) => selection.has(item.id))}
                      onChange={() => selection.toggleAll(visible)}
                    />
                  )}
                </th>
                {/* Which columns, in what order, and what each sorts by all live
                  * in tables/cookieColumns.tsx. */}
                <ColumnHeaders columns={columns} sorting={sorting} />
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((cookie) => {
                const isNew = newIds.has(cookie.id);
                const rowClass = [
                  selection.has(cookie.id) ? 'row-checked' : '',
                  isNew ? 'is-new' : '',
                ].filter(Boolean).join(' ');
                return (
                  // The row's own click opens the set -- a cookie-set has no
                  // "selected row" concept the way a profile does, so the obvious
                  // gesture is free to be the primary action. Not in Trash,
                  // though: the inspector can assign, edit and re-delete, and
                  // none of those mean anything for a set that has been thrown
                  // away. Trash rows offer Restore and Delete forever, and
                  // nothing else.
                  <tr
                    key={cookie.id}
                    className={rowClass}
                    onClick={cookie.deleted_at ? undefined : () => onOpenCookieSet(cookie)}
                    // So the green is never the only thing saying so. See the same
                    // title on the Profiles row.
                    title={isNew ? 'Added since you last looked' : undefined}
                  >
                    <td className="checkbox-cell" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        label={`Select ${cookie.name || 'cookie-set'}`}
                        checked={selection.has(cookie.id)}
                        onChange={() => selection.toggle(cookie.id)}
                      />
                    </td>
                    <ColumnCells columns={columns} context={columnContext} row={cookie} />
                    <td className="actions-cell">
                      <div className="row-actions">
                        {cookie.deleted_at ? (
                          <>
                            <button className="ghost" onClick={(event) => {
                              event.stopPropagation();
                              void restoreSets([cookie.id], `"${cookie.name}"`);
                            }}>Restore</button>
                            <button
                              aria-label={`Permanently delete ${cookie.name}`}
                              className="icon-button danger-icon"
                              onClick={(event) => {
                                event.stopPropagation();
                                void purgeSets([cookie.id], `"${cookie.name}"`);
                              }}
                              title={`Permanently delete ${cookie.name}`}
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="launch"
                              onClick={(event) => {
                                event.stopPropagation();
                                onOpenCookieSet(cookie);
                              }}
                              type="button"
                            >
                              Open
                            </button>
                            <button
                              aria-label={`Assign ${cookie.name} to profiles`}
                              className="icon-button row-action"
                              onClick={(event) => {
                                event.stopPropagation();
                                onAssignCookieSet(cookie);
                              }}
                              title={`Assign ${cookie.name} to profiles`}
                            >
                              <UserPlus size={16} />
                            </button>
                            {/* Next to Assign on purpose: both answer "who else
                              * gets this session", one inside the workspace and
                              * one outside it. */}
                            <button
                              aria-label={`Share ${cookie.name}`}
                              className="icon-button row-action"
                              onClick={(event) => {
                                event.stopPropagation();
                                onShare({kind: 'cookie_set', ids: [cookie.id]});
                              }}
                              title="Share with another workspace"
                            >
                              <Share2 size={16} />
                            </button>
                            <BusyButton
                              ariaLabel={`Duplicate ${cookie.name}`}
                              busy={isPending(`duplicate-${cookie.id}`)}
                              className="icon-button row-action"
                              icon={<Copy size={16} />}
                              onClick={(event) => {
                                event.stopPropagation();
                                void run(`duplicate-${cookie.id}`, () => duplicateOne(cookie));
                              }}
                              title={`Duplicate ${cookie.name}`}
                            />
                            <button
                              aria-label={`Delete ${cookie.name}`}
                              className="icon-button row-action row-action-danger"
                              onClick={(event) => {
                                event.stopPropagation();
                                void trashSets([cookie.id], `"${cookie.name}"`);
                              }}
                              title={`Delete ${cookie.name}`}
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr className="empty-row-tr">
                  {/* Eight columns, nine on a team -- the Assigned column comes
                    * and goes. A short colSpan leaves a stray empty cell at
                    * the end of the row. */}
                  <td colSpan={columnCount}>
                    <EmptyState
                      icon={<SearchX size={22} />}
                      title={filtered ?
                        'Nothing matches those filters' :
                        inTrash ? 'Trash is empty' : 'This folder is empty'}
                      body={filtered ?
                        'Try a different search term, or clear the tag, status and usage filters.' :
                        inTrash ?
                          'Deleted cookie-sets wait here for 30 days before they are purged.' :
                          'Cookie-sets you add to this folder will show up here.'}
                    >
                      {!inTrash && !filtered && (
                        <>
                          <button onClick={onNewCookieSet} type="button">
                            <Cookie size={16} /> Add cookie-set
                          </button>
                          {activeFolder && movableCount > 0 && (
                            <button className="ghost" onClick={() => setMoveOpen(true)} type="button">
                              <FolderInput size={16} /> Move cookie-sets here
                            </button>
                          )}
                        </>
                      )}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <PaginationBar
          page={clampedPage}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          onPage={setPage}
          onPageSize={(size) => { setPageSize(size); setPage(0); }}
          extra={selection.size > 0 && (
            <span className="pagination-selected">{selection.size} selected</span>
          )}
        />
      </div>

      {moveOpen && activeFolder && (
        <MoveCookieSetsModal folder={activeFolder} onClose={() => setMoveOpen(false)} />
      )}

      {purge && (
        <PurgeCookieSetsModal
          request={purge}
          onClose={() => setPurge(null)}
          onPurged={() => {
            setPurge(null);
            selection.clear();
          }}
        />
      )}
    </>
  );

}

function selectionLabel(size: number): string {
  return `${size} selected cookie-${size === 1 ? 'set' : 'sets'}`;
}

// Trash is a folder in the picker but a flag on the row, so it filters first
// and the rest narrow whatever it left. Same shape as visibleProfiles, and
// deliberately so.
function visibleCookieSets(
    allCookies: ScoutCookie[],
    {folderId, tagFilter, statusFilter, usageFilter, search}: {
      folderId: string;
      tagFilter: string;
      statusFilter: string;
      usageFilter: UsageFilter;
      search: string;
    },
    usage: Map<string, number>) {
  const inTrash = folderId === TRASH_FOLDER_ID;
  const byTrash = allCookies.filter((cookie) => Boolean(cookie.deleted_at) === inTrash);
  const inFolder = folderId && !inTrash ?
    byTrash.filter((cookie) => cookie.folder_id === folderId) :
    byTrash;
  // Against the same fallback the cell renders, so filtering by Fresh finds the
  // sets nobody has marked at all.
  const byStatus = statusFilter ?
    inFolder.filter((cookie) =>
      (cookie.status || defaultCookieStatus).toLowerCase() === statusFilter.toLowerCase()) :
    inFolder;
  const byUsage = usageFilter ?
    byStatus.filter((cookie) =>
      (usageFilter === 'used') === Boolean(usage.get(cookie.id))) :
    byStatus;
  // Compared on tagKey, so a set tagged "Instagram" and one tagged "instagram"
  // both answer to the one dropdown entry.
  const byTag = tagFilter ?
    byUsage.filter((cookie) => cookie.tags?.some((tag) => tagKey(tag) === tagFilter)) :
    byUsage;
  const query = search.trim().toLowerCase();
  if (!query) {
    return byTag;
  }
  return byTag.filter((cookie) =>
    cookie.name?.toLowerCase().includes(query) ||
    cookie.tags?.some((tag) => tag.toLowerCase().includes(query)));
}
