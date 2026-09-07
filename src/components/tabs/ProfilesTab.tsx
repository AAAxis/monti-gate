import {useState} from 'react';
import {
  BookOpen, Cookie, Download, FolderInput, FolderPlus, Pencil, Play, SearchX, Share2,
  ShieldCheck, Trash2, UserPlus, UsersRound,
} from 'lucide-react';
import {MoveProfilesModal} from '../modals/MoveProfilesModal';
import {PurgeProfilesModal} from '../modals/ConfirmModals';
import {BusyButton} from '../ui/BusyButton';
import {Checkbox} from '../ui/Checkbox';
import {ColumnsButton} from '../ui/ColumnsButton';
import {EmptyState} from '../ui/EmptyState';
import {FolderGlyph} from '../ui/FolderGlyph';
import {PaginationBar} from '../ui/PaginationBar';
import {FolderSelect, StatusFilter, TagFilter} from '../ui/TableFilters';
import {ColumnCells, ColumnHeaders} from '../../tables/TableColumns';
import {PROFILE_COLUMNS} from '../../tables/profileColumns';
import {useProfileCellActions, useProfileCellOptions} from '../../tables/profileCellActions';
import {sortColumnsFrom} from '../../tables/columns';
import {useTableColumns} from '../../tables/ColumnLayouts';
import {TRASH_FOLDER_ID} from '../../lib/trash';
import {useOrg} from '../../org';
import {paginate} from '../../lib/paginate';
import {tagKey} from '../../lib/tags';
import {native} from '../../native';
import {useAsyncAction} from '../../useAsyncAction';
import {useSelection} from '../../hooks/useSelection';
import {useTableSort} from '../../hooks/useTableSort';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ProfileColumnContext} from '../../tables/profileColumns';
import type {PurgeRequest} from '../modals/ConfirmModals';
import type {ShareRequest} from '../modals/ShareModal';
import type {MontiCookie, MontiFolder, MontiProfile, MontiProxy} from '../../types';

export type ProfilesTabProps = {
  // Controlled by the shell: creating a folder from the dialog selects it here.
  folderId: string;
  onFolderId: (folderId: string) => void;
  onEditProfile: (profile: MontiProfile) => void;
  // The Browser and Screen cells are read-only -- a screen set on its own would
  // contradict the platform preset that re-rolls it -- so they open the editor
  // at the section they belong to instead of editing in place.
  onEditFingerprint: (profile: MontiProfile) => void;
  // Which tab is showing and which cookie inspector is open are both App's,
  // so the Cookie set cell hands its jump upwards.
  onOpenCookieSet: (cookie: MontiCookie) => void;
  onNewProfile: () => void;
  onNewFolder: () => void;
  // Was onRenameFolder. The dialog edits the icon and colour as well now.
  onEditFolder: (folder: MontiFolder) => void;
  // Set for one render after a folder is created from a tag suggestion: the
  // move dialog opens on the folder with that tag's profiles already ticked,
  // so filling it is one click. Cleared through onFillTagDone when it closes.
  fillTag: string;
  onFillTagDone: () => void;
  // Both delete paths funnel through the shared confirmation dialog, which the
  // app shell owns because the profile editor can raise it too.
  onRequestDelete: (profileIds: string[], label: string, onDeleted?: () => void) => void;
  // Raises the share sheet, hosted by App for the same reason the delete
  // confirmation is: four tabs open the one dialog.
  onShare: (request: ShareRequest) => void;
  onShowIntro: () => void;
  // Which rows arrived since this machine last looked at this tab, frozen for
  // the length of the visit so they cannot un-highlight under the cursor. Owned
  // by useNewArrivals in App, because the sidebar has to count the same
  // arrivals on tabs nobody is standing on. See src/lib/newSince.ts.
  newIds: ReadonlySet<string>;
};

export function ProfilesTab({
  folderId,
  onFolderId,
  onEditProfile,
  onEditFingerprint,
  onOpenCookieSet,
  onNewProfile,
  onNewFolder,
  onEditFolder,
  fillTag,
  onFillTagDone,
  onRequestDelete,
  onShare,
  onShowIntro,
  newIds,
}: ProfilesTabProps) {
  const {
    data, toast, library, profiles, proxies, checkingProxyIds, selectedProfileId,
    setSelectedProfileId, statusOptions, tagOptions,
  } = useWorkspace();
  const state = data.state;
  const {run, isPending} = useAsyncAction();
  const selection = useSelection<MontiProfile>();

  const org = useOrg();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // "Only what I'm on the hook for." A toggle rather than another dropdown
  // entry: it is a different question from status or tag, and stacking it into
  // one of those would hide it.
  const [mineOnly, setMineOnly] = useState(false);
  // Held as a tagKey, not the tag as typed, so "Instagram" and "instagram" are
  // one entry in the dropdown and one filter rather than two.
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [moveOpen, setMoveOpen] = useState(false);
  // The pending permanent delete, shared by the row button, the bulk button and
  // Empty Trash -- one dialog, three ways in.
  const [purge, setPurge] = useState<PurgeRequest | null>(null);

  // Team-only -- on a one-person workspace every row answers "you". It gates
  // the "Assigned to me" filter chip; the Assigned *column* is gated by the
  // same flag inside the registry, which is where teamOnly lives now.
  const showAssignee = state.members.length > 1;

  // What the cells need beyond the profile itself. Rebuilt each render on
  // purpose: every field on it is already state the tab re-renders for, and a
  // memoised set of handlers would close over a stale `state` the moment
  // anything is edited. The option lists inside it are memoised, because those
  // are pure derivations. See tables/profileCellActions.ts.
  const cellOptions = useProfileCellOptions(state, statusOptions);
  const cellActions = useProfileCellActions({
    // Clicking a folder points the whole table at it, which is the same thing
    // the sidebar's folder list does -- so it resets the page for the same
    // reason every other filter does.
    filterFolder: (nextFolderId) => {
      onFolderId(nextFolderId);
      setPage(0);
    },
    openFingerprint: onEditFingerprint,
    openCookieSet: onOpenCookieSet,
  });
  const columnContext: ProfileColumnContext = {
    state,
    proxyFor: profiles.proxyFor,
    folderFor: profiles.folderFor,
    checkingProxyIds,
    tagOptions,
    userId: org.userId || '',
    options: cellOptions,
    actions: cellActions,
  };
  const {columns, isVisible, setVisible, reset} =
    useTableColumns('profiles', PROFILE_COLUMNS, {isTeam: showAssignee});

  // Every column in the registry, not just the visible ones: the sort key is
  // held in the hook's own state, so hiding the column a table is sorted by
  // would otherwise leave a key nothing answers to.
  const sorting = useTableSort<MontiProfile>(
      sortColumnsFrom(PROFILE_COLUMNS, columnContext),
      {onSortChange: () => setPage(0)});

  // Two more than the columns: the selection box and the row actions, neither
  // of which is configurable. This used to be a hand-maintained integer that
  // had to be edited in step with the header, the row and the Assigned flag.
  const columnCount = columns.length + 2;

  // Hiding the column you were sorted by returns the table to database order,
  // which is honest -- the alternative is a header that claims a sort nothing
  // is performing.
  function toggleColumn(columnId: string, visible: boolean) {
    if (!visible && sorting.sortKey === columnId) {
      sorting.clear();
    }
    setVisible(columnId, visible);
  }

  const inTrash = folderId === TRASH_FOLDER_ID;
  const filtered = Boolean(search.trim() || statusFilter || tagFilter || mineOnly);
  const visible = sorting.sort(
      visibleProfiles(state.profiles, {folderId, statusFilter, tagFilter, search})
          .filter((profile) => !mineOnly || profile.assigned_to === org.userId));
  const {items, page: clampedPage, totalPages, total} = paginate(visible, page, pageSize);

  // The real folder the view is pointed at, if any: "" is All profiles and
  // TRASH_FOLDER_ID is a flag on the row, and neither is somewhere a profile
  // can be moved to.
  const activeFolder = inTrash ? null :
    state.folders.find((folder) => folder.id === folderId) || null;
  const movableCount = activeFolder ?
    state.profiles.filter((profile) => !profile.deleted_at && profile.folder_id !== folderId).length :
    0;
  const allCount = state.profiles.filter((profile) => !profile.deleted_at).length;
  const trashCount = state.profiles.length - allCount;

  // Nothing in the workspace at all -- not a filter that matched nothing, and
  // not an empty folder. There is no table worth drawing headers for, and every
  // control in the toolbar filters a list of zero, so the whole screen becomes
  // the invitation to make the first profile.
  const workspaceEmpty = state.profiles.length === 0;

  async function importCookiesForSelection() {
    if (!selection.size) {
      return;
    }
    if (!native?.selectCookieFolder || !native?.matchCookieFiles) {
      toast.setMessage('Native cookie import is not available. Restart Scout Web and try again.');
      return;
    }
    const folderPath = await native.selectCookieFolder();
    if (!folderPath) {
      return;
    }
    try {
      const {matched, total: count} = await profiles.matchCookies(folderPath, [...selection.ids]);
      toast.setMessage(`Matched cookies for ${matched} of ${count} selected profiles`);
    } catch (error) {
      toast.setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function moveSelectionToFolder(nextFolderId: string) {
    if (!selection.size) {
      return;
    }
    const target = nextFolderId || null;
    if (!await profiles.assignToFolder([...selection.ids], target)) {
      return;
    }
    const folderName = target ?
      state.folders.find((folder) => folder.id === target)?.name :
      'All profiles';
    toast.setMessage(`${selection.size} ${selection.size === 1 ? 'profile' : 'profiles'} moved to ${folderName || 'All profiles'}`);
  }

  async function restoreSelection() {
    const count = selection.size;
    if (!count || !await profiles.restore([...selection.ids])) {
      return;
    }
    selection.clear();
    toast.setMessage(`${count} ${count === 1 ? 'profile' : 'profiles'} restored`);
  }

  // The three permanent-delete paths all raise the same dialog rather than a
  // window.confirm. It is the irreversible action, so it gets the "I understand"
  // checkbox the reversible one already had -- and a native confirm cannot say
  // that the on-disk browser directory and logged-in sessions go too.
  function purgeSelection() {
    if (!selection.size) {
      return;
    }
    setPurge({
      ids: [...selection.ids],
      count: selection.size,
      label: `${selection.size} selected ${selection.size === 1 ? 'profile' : 'profiles'}`,
    });
  }

  // No ids: the delete is scoped by deleted_at server-side, which is what makes
  // it safe without a selection. See db/profiles.purgeAll.
  function emptyTrash() {
    if (!trashCount) {
      return;
    }
    setPurge({ids: [], count: trashCount, label: 'everything in Trash'});
  }

  // The proxies behind the selected profiles, deduplicated -- several profiles
  // sharing one proxy should check it once, not once each.
  function checkSelectionProxies() {
    const targets = new Map<string, MontiProxy>();
    for (const profile of selection.selectedFrom(state.profiles)) {
      const proxy = profiles.proxyFor(profile);
      if (proxy) {
        targets.set(proxy.id, proxy);
      }
    }
    if (!targets.size) {
      toast.setMessage('None of the selected profiles has a proxy assigned.');
      return;
    }
    void proxies.checkMany([...targets.values()]);
  }

  async function restoreOne(profile: MontiProfile) {
    if (await profiles.restore([profile.id])) {
      toast.setMessage(`${profile.name} restored`);
    }
  }

  // Deleting a folder never deletes what is in it: profiles.folder_id is nulled
  // (ON DELETE SET NULL server-side, mirrored locally by removeFolder), so they
  // reappear under All profiles rather than vanishing with the folder. The
  // confirmation says so, because "delete folder" reads like it should take
  // them with it.
  async function deleteFolder(folder: MontiFolder) {
    const count = state.profiles.filter((profile) =>
      !profile.deleted_at && profile.folder_id === folder.id).length;
    const consequence = count ?
      `Its ${count} ${count === 1 ? 'profile' : 'profiles'} will move to All profiles.` :
      'It is empty.';
    if (!window.confirm(`Delete folder ${folder.name}? ${consequence}`)) {
      return;
    }
    if (!await library.removeFolder(folder.id)) {
      return;
    }
    // The view was pointed at a folder that no longer exists.
    if (folderId === folder.id) {
      onFolderId('');
    }
    toast.setMessage(`${folder.name} folder deleted`);
  }

  function purgeOne(profile: MontiProfile) {
    setPurge({ids: [profile.id], count: 1, label: profile.name});
  }

  // The same shape the empty Proxies tab uses: a bare centred section, not a
  // table shell wrapped around a message. .table-wrap draws a raised, bordered
  // card, and with no rows in it that border reads as the outline of a table
  // that failed to load rather than as an invitation.
  if (workspaceEmpty) {
    return (
      <section className="tab-empty">
        <span className="tab-empty-mark">
          <UsersRound size={26} strokeWidth={1.5} />
        </span>
        <h2>No profiles yet</h2>
        <p>
          A profile is a separate browser with its own cookies, fingerprint and
          proxy. Make one and it appears here, ready to launch.
        </p>
        <div className="tab-empty-actions">
          <button onClick={onNewProfile} type="button">
            <UserPlus size={18} /> Add profile
          </button>
          <button className="ghost" onClick={onShowIntro} type="button">
            <BookOpen size={18} /> How profiles work
          </button>
        </div>
      </section>
    );
  }

  return (
    <>
      {/* The tab as two objects, the same pair an automation card is drawn as: a
        * frame carrying everything the app says *about* the table -- the filters,
        * the folder rail, the selection bar, the pager -- and the table itself
        * inset in it, holding the profiles. Reaching for a control means reaching
        * outside the rows it acts on.
        *
        * It also takes over being the flex child that fills the page, because
        * `.content > .table-wrap` no longer matches with this in between. The
        * frame holds the height and hands the scrolling down to the table, so the
        * toolbar and the pager stay put and only the rows move -- which is what
        * they did before, and has to keep being true. */}
      <div className="table-frame">
        <section className="table-toolbar">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search profiles by name or tag"
          />
          <StatusFilter value={statusFilter} options={statusOptions} onChange={setStatusFilter} />
          {/* Only tags that are actually on a profile: a dropdown listing all
            * twenty brands when the workspace uses two of them is a list of
            * eighteen ways to empty the table. */}
          <TagFilter value={tagFilter} options={tagOptions} onChange={setTagFilter} />
          {/* Only offered on a team. On a one-person workspace every row is
            * yours, so this would be a control that never changes anything. */}
          {showAssignee && (
            <button
              aria-pressed={mineOnly}
              className={mineOnly ? 'choice-chip active' : 'choice-chip'}
              onClick={() => setMineOnly((value) => !value)}
              type="button"
            >Assigned to me</button>
          )}
          {/* In the toolbar rather than the selection bar, because the whole point
            * is that it needs no selection: emptying Trash after a failed import
            * meant ticking every row across every page first. */}
          {inTrash && trashCount > 0 && (
            <button className="danger ghost" onClick={emptyTrash}>
              <Trash2 size={16} /> Empty Trash ({trashCount})
            </button>
          )}
          {/* Last, and pushed to the far end by its own margin: everything to its
            * left narrows the rows, this one decides what a row shows. (Refresh
            * briefly sat here too; it lives in the .topbar with Import and Add
            * profile now -- it acts on the workspace, not on this table.) */}
          <ColumnsButton
            registry={PROFILE_COLUMNS}
            context={{isTeam: showAssignee}}
            isVisible={isVisible}
            onToggle={toggleColumn}
            onReset={reset}
          />
        </section>

        {/* The folder navigation, in full: All profiles, the folders themselves,
          * Trash, and the way to make another one. This replaced a dropdown --
          * finding out what folders existed took opening it, and the only route
          * to editing or deleting one was to select it first. */}
        <section className="folder-row" aria-label="Folders">
          <button
            aria-pressed={!folderId}
            className={folderId ? 'folder-card' : 'folder-card active'}
            onClick={() => onFolderId('')}
            type="button"
          >
            <span className="folder-glyph"><UsersRound size={15} strokeWidth={1.75} /></span>
            <span className="folder-card-name">All profiles</span>
            <span className="folder-card-count">{allCount}</span>
          </button>

          {state.folders.map((folder) => {
            const count = state.profiles.filter((profile) =>
              !profile.deleted_at && profile.folder_id === folder.id).length;
            const active = folder.id === folderId;
            return (
              // A div, not a button: the pencil and the trash are buttons of
              // their own, and nesting those inside the card's own button is
              // both invalid and unclickable.
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

        {/* Below the folder rail, not above it. Ticking a row used to insert this
          * between the filters and the folders, which pushed the folder cards --
          * and the whole table under them -- down by its height. */}
        {selection.size > 0 && (
          <section className="selection-toolbar">
            <div className="selection-toolbar-actions">
              {inTrash ? (
                <>
                  <button className="ghost" onClick={restoreSelection}>Restore selected</button>
                  <button className="danger ghost" onClick={purgeSelection}>
                    <Trash2 size={16} /> Delete forever
                  </button>
                </>
              ) : (
                <>
                  <FolderSelect
                    folders={state.folders}
                    noFolderLabel="All profiles"
                    onPick={(id) => void moveSelectionToFolder(id)}
                  />
                  <button className="ghost" onClick={checkSelectionProxies}>
                    <ShieldCheck size={16} /> Check proxies
                  </button>
                  <BusyButton
                    className="ghost"
                    busy={isPending('import-cookies')}
                    icon={<Cookie size={16} />}
                    busyLabel="Importing…"
                    onClick={() => void run('import-cookies', importCookiesForSelection)}
                  >
                    Import cookies
                  </BusyButton>
                  <button
                    className="ghost"
                    onClick={() => void profiles.exportToCsv(selection.selectedFrom(state.profiles))}
                  >
                    <Download size={16} /> Export selected
                  </button>
                  <button
                    className="ghost"
                    onClick={() => onShare({kind: 'profile', ids: [...selection.ids]})}
                  >
                    <Share2 size={16} /> Share…
                  </button>
                  <button
                    className="danger ghost"
                    onClick={() => onRequestDelete(
                        [...selection.ids],
                        `${selection.size} selected ${selection.size === 1 ? 'profile' : 'profiles'}`,
                        selection.clear)}
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
                      label={`Select all ${visible.length} profiles on this page`}
                      checked={selection.allSelected(visible)}
                      indeterminate={visible.some((item) => selection.has(item.id))}
                      onChange={() => selection.toggleAll(visible)}
                    />
                  )}
                </th>
                {/* Which columns these are, in what order, and what each sorts
                  * by all live in tables/profileColumns.tsx. */}
                <ColumnHeaders columns={columns} sorting={sorting} />
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((profile) => {
                // Still read here, by the row's check-proxy button. The Proxy and
                // Proxy check cells look it up themselves, through the context.
                const proxy = profiles.proxyFor(profile);
                const isNew = newIds.has(profile.id);
                const rowClass = [
                  profile.id === selectedProfileId ? 'selected' : '',
                  selection.has(profile.id) ? 'row-checked' : '',
                  isNew ? 'is-new' : '',
                ].filter(Boolean).join(' ');
                return (
                  <tr
                    key={profile.id}
                    className={rowClass}
                    onClick={() => setSelectedProfileId(profile.id)}
                    // So the green is never the only thing saying so. There is no
                    // column to hang a "New" chip off -- the registry is the
                    // user's to arrange -- and the row itself is the thing the
                    // marker is about.
                    title={isNew ? 'Added since you last looked' : undefined}
                  >
                    <td className="checkbox-cell" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        label={`Select ${profile.name || profile.id}`}
                        checked={selection.has(profile.id)}
                        onChange={() => selection.toggle(profile.id)}
                      />
                    </td>
                    <ColumnCells columns={columns} context={columnContext} row={profile} />
                    <td className="actions-cell">
                      <div className="row-actions">
                        {profile.deleted_at ? (
                          <>
                            <button className="ghost" onClick={(event) => {
                              event.stopPropagation();
                              void restoreOne(profile);
                            }}>Restore</button>
                            <button
                              className="icon-button danger-icon"
                              aria-label={`Permanently delete ${profile.name}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                purgeOne(profile);
                              }}
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        ) : (
                          <>
                            <BusyButton
                              className="launch"
                              busy={isPending(`launch-${profile.id}`)}
                              icon={<Play size={16} />}
                              onClick={() => void run(`launch-${profile.id}`, () => profiles.launch(profile))}
                            >
                              Launch
                            </BusyButton>
                            {/* The manual proxy re-check used to be a fifth button
                              * here. It is now the Proxy check chip itself, which
                              * is the thing it acts on -- and a row of five
                              * controls was already one too many (see below). */}
                            {/* Bare, with the affordance moved into the hover
                              * plate -- see .row-action in styles.css. This was
                              * bordered on the argument that a naked glyph beside
                              * a filled Launch reads as decoration; what settled
                              * it the other way is that the argument cost three
                              * outlines in every row of a twenty-five row table,
                              * and Launch is the only one of the four you came to
                              * the row for. */}
                            <button
                              aria-label={`Edit ${profile.name}`}
                              className="icon-button row-action"
                              onClick={(event) => {
                                event.stopPropagation();
                                onEditProfile(profile);
                              }}
                              title={`Edit ${profile.name}`}
                            >
                              <Pencil size={16} />
                            </button>
                            {/* Four controls, which is what this row wants. It was
                              * five while the proxy re-check lived here; moving
                              * that onto the Proxy check chip is what bought the
                              * space back. Share stays a button rather than
                              * something you reach by ticking a checkbox first,
                              * because a feature you cannot see is worse than a
                              * row that is a little busy. If a fifth arrives
                              * again, that is the moment for an overflow menu. */}
                            <button
                              aria-label={`Share ${profile.name}`}
                              className="icon-button row-action"
                              onClick={(event) => {
                                event.stopPropagation();
                                onShare({kind: 'profile', ids: [profile.id]});
                              }}
                              title="Share with another workspace"
                            >
                              <Share2 size={16} />
                            </button>
                            <button
                              aria-label={`Delete ${profile.name}`}
                              className="icon-button row-action row-action-danger"
                              onClick={(event) => {
                                event.stopPropagation();
                                onRequestDelete([profile.id], profile.name);
                              }}
                              title={`Delete ${profile.name}`}
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
                  {/* Counted, not written down: the number of columns is now the
                    * user's to choose. A short colSpan leaves a stray empty cell
                    * at the end of the row. */}
                  <td colSpan={columnCount}>
                    <EmptyState
                      icon={<SearchX size={22} />}
                      title={filtered ?
                        'Nothing matches those filters' :
                        inTrash ? 'Trash is empty' : 'This folder is empty'}
                      body={filtered ?
                        'Try a different search term, or clear the status and tag filters.' :
                        inTrash ? 'Deleted profiles wait here for 30 days before they are purged.' :
                          'Profiles you add to this folder will show up here.'}
                    >
                      {!inTrash && !filtered && (
                        <>
                          <button onClick={onNewProfile} type="button">
                            <UserPlus size={16} /> Add profile
                          </button>
                          {/* A brand-new folder is far more often filled from
                            * profiles that already exist than from scratch, and
                            * the only route to that was selecting rows in a
                            * table you have to leave this folder to see. */}
                          {activeFolder && movableCount > 0 && (
                            <button className="ghost" onClick={() => setMoveOpen(true)} type="button">
                              <FolderInput size={16} /> Move profiles here
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

      {/* Outside the frame: a modal is not part of the table's furniture, and
        * nesting it in a flex column that owns the page height would make it one. */}
      {(moveOpen || fillTag) && activeFolder && (
        <MoveProfilesModal
          folder={activeFolder}
          seedTag={fillTag || undefined}
          onClose={() => {
            setMoveOpen(false);
            onFillTagDone();
          }}
        />
      )}

      {purge && (
        <PurgeProfilesModal
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

// Trash is a folder in the picker but a flag on the row, so it filters first
// and the rest narrow whatever it left.
function visibleProfiles(
    allProfiles: MontiProfile[],
    {folderId, statusFilter, tagFilter, search}: {
      folderId: string;
      statusFilter: string;
      tagFilter: string;
      search: string;
    }) {
  const inTrash = folderId === TRASH_FOLDER_ID;
  const byTrash = allProfiles.filter((profile) => Boolean(profile.deleted_at) === inTrash);
  const inFolder = folderId && !inTrash ?
    byTrash.filter((profile) => profile.folder_id === folderId) :
    byTrash;
  const byStatus = statusFilter ?
    inFolder.filter((profile) =>
      (profile.status || 'Ready').toLowerCase() === statusFilter.toLowerCase()) :
    inFolder;
  // Compared on tagKey, so a row tagged "Instagram" and a row tagged
  // "instagram" both answer to the one dropdown entry.
  const byTag = tagFilter ?
    byStatus.filter((profile) => profile.tags?.some((tag) => tagKey(tag) === tagFilter)) :
    byStatus;
  const query = search.trim().toLowerCase();
  if (!query) {
    return byTag;
  }
  return byTag.filter((profile) =>
    profile.name?.toLowerCase().includes(query) ||
    profile.tags?.some((tag) => tag.toLowerCase().includes(query)));
}
