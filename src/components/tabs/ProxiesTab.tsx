import {useState} from 'react';
import {
  Download, FolderInput, FolderPlus, KeyRound, Pencil, Plus, SearchX, Share2, ShieldCheck,
  Trash2, Upload, Waypoints, X,
} from 'lucide-react';
import {MoveProxiesModal} from '../modals/MoveProxiesModal';
import {SetProxyCredentialsModal} from '../modals/SetProxyCredentialsModal';
import {Checkbox} from '../ui/Checkbox';
import {ColumnsButton} from '../ui/ColumnsButton';
import {EmptyState} from '../ui/EmptyState';
import {FolderGlyph} from '../ui/FolderGlyph';
import {PaginationBar} from '../ui/PaginationBar';
import {FolderSelect, StatusFilter} from '../ui/TableFilters';
import {ColumnCells, ColumnHeaders} from '../../tables/TableColumns';
import {PROXY_COLUMNS} from '../../tables/proxyColumns';
import {useProxyCellActions, useProxyCellOptions} from '../../tables/proxyCellActions';
import {sortColumnsFrom} from '../../tables/columns';
import {useTableColumns} from '../../tables/ColumnLayouts';
import {
  isProxyAssigned, profilesUsingProxy, proxySearchText,
} from '../../lib/proxies';
import {paginate} from '../../lib/paginate';
import {profileColorStyle} from '../../lib/profileColors';
import {initials} from '../../lib/text';
import {SITE_URL} from '../../lib/auth';
import {PROXY_PROVIDERS, providerPath} from '../../data/proxyProviders';
import {defaultProxyStatus} from '../../data/statuses';
import {native} from '../../native';
import {useOrg} from '../../org';
import {useSelection} from '../../hooks/useSelection';
import {useTableSort} from '../../hooks/useTableSort';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ProxyColumnContext} from '../../tables/proxyColumns';
import type {ShareRequest} from '../modals/ShareModal';
import type {ScoutFolder, ScoutProfile, ScoutProxy} from '../../types';

export type ProxiesTabProps = {
  // Controlled by the shell, exactly like the Profiles tab's: creating a folder
  // from the dialog selects it here.
  folderId: string;
  onFolderId: (folderId: string) => void;
  onAddProxy: () => void;
  onImportProxies: () => void;
  onEditProxy: (proxy: ScoutProxy) => void;
  onNewFolder: () => void;
  onEditFolder: (folder: ScoutFolder) => void;
  // Set for one render after a folder is created from a country suggestion: the
  // move dialog opens on that folder with the country's proxies already ticked.
  // Cleared through onFillCountryDone when it closes.
  fillCountry: string;
  onFillCountryDone: () => void;
  onRequestDelete: (proxyIds: string[], label: string, onDeleted?: () => void) => void;
  // Raises the share sheet. Hosted by App, like the delete confirmations, since
  // four tabs open the same dialog.
  onShare: (request: ShareRequest) => void;
  // Which rows arrived since this machine last looked at this tab. See
  // ProfilesTabProps.newIds and src/lib/newSince.ts.
  newIds: ReadonlySet<string>;
};

export function ProxiesTab({
  folderId,
  onFolderId,
  onAddProxy,
  onImportProxies,
  onEditProxy,
  onNewFolder,
  onEditFolder,
  fillCountry,
  onFillCountryDone,
  onRequestDelete,
  onShare,
  newIds,
}: ProxiesTabProps) {
  const {data, toast, library, proxies, checkingProxyIds, proxyStatusOptions} = useWorkspace();
  const org = useOrg();
  const state = data.state;
  const selection = useSelection<ScoutProxy>();

  // "Only what I'm on the hook for". A toggle rather than a third entry in the
  // assigned dropdown beside it: that one filters by whether a PROFILE holds
  // the proxy, which is a different question about a different subject, and
  // stacking both meanings in one control is how the label collision this
  // column just fixed happened in the first place.
  const [mineOnly, setMineOnly] = useState(false);
  const [search, setSearch] = useState('');
  // '' for "All statuses". The user's own mark, not the check result -- the
  // dropdown beside it filters by whether a profile holds the proxy, and the
  // check state has no filter at all because sorting the Check column answers
  // that question better.
  const [statusFilter, setStatusFilter] = useState('');
  // Gates the "Assigned to me" filter chip. The Assigned *column* is gated by
  // the same flag inside the registry, which is where teamOnly lives now.
  const showAssignee = state.members.length > 1;
  const [assignedFilter, setAssignedFilter] = useState<'' | 'assigned' | 'unassigned'>('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [moveOpen, setMoveOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);

  const assigned = (proxy: ScoutProxy) => isProxyAssigned(proxy, state.profiles);

  // Rebuilt every render on purpose -- see tables/proxyCellActions.tsx: the
  // actions close over state, and memoising them is how a cell writes through
  // a stale snapshot.
  const cellOptions = useProxyCellOptions(state, proxyStatusOptions);
  const cellActions = useProxyCellActions();
  const columnContext: ProxyColumnContext = {
    state,
    checkingProxyIds,
    userId: org.userId || '',
    options: cellOptions,
    actions: cellActions,
  };
  const {columns, isVisible, setVisible, reset} =
    useTableColumns('proxies', PROXY_COLUMNS, {isTeam: showAssignee});

  // What each column sorts by lives in tables/proxyColumns.tsx, and the whole
  // registry is registered rather than the visible slice -- see the note there.
  const sorting = useTableSort<ScoutProxy>(
      sortColumnsFrom(PROXY_COLUMNS, columnContext),
      {onSortChange: () => setPage(0)});

  // Two more than the columns: the selection box and the row actions.
  const columnCount = columns.length + 2;

  // Hiding the column the table is sorted by returns it to database order,
  // rather than leaving a header claiming a sort nothing performs.
  function toggleColumn(columnId: string, visible: boolean) {
    if (!visible && sorting.sortKey === columnId) {
      sorting.clear();
    }
    setVisible(columnId, visible);
  }

  const filtered = Boolean(search.trim() || assignedFilter || statusFilter || mineOnly);
  const visible = sorting.sort(
      visibleProxies(state.proxies, {folderId, search, statusFilter, assignedFilter, assigned})
          .filter((proxy) => !mineOnly || proxy.assigned_to === org.userId));
  const {items, page: clampedPage, totalPages, total} = paginate(visible, page, pageSize);

  const activeFolder = state.proxy_folders.find((folder) => folder.id === folderId) || null;
  const movableCount = activeFolder ?
    state.proxies.filter((proxy) => proxy.folder_id !== folderId).length :
    0;

  async function moveSelectionToFolder(nextFolderId: string) {
    if (!selection.size) {
      return;
    }
    const target = nextFolderId || null;
    if (!await proxies.assignToFolder([...selection.ids], target)) {
      return;
    }
    const folderName = target ?
      state.proxy_folders.find((folder) => folder.id === target)?.name :
      'All proxies';
    toast.setMessage(`${selection.size} ${selection.size === 1 ? 'proxy' : 'proxies'} moved to ${folderName || 'All proxies'}`);
  }

  // Deleting a folder never deletes what is in it: proxies.folder_id is nulled
  // (ON DELETE SET NULL server-side, mirrored locally by removeFolder), so they
  // reappear under All proxies rather than vanishing with the folder. The
  // confirmation says so, because "delete folder" reads like it should take
  // them with it -- and here it would read like cancelling the subscription.
  async function deleteFolder(folder: ScoutFolder) {
    const count = state.proxies.filter((proxy) => proxy.folder_id === folder.id).length;
    const consequence = count ?
      `Its ${count} ${count === 1 ? 'proxy' : 'proxies'} will move to All proxies.` :
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

  // Owning no proxies at all is a different situation from having filtered them
  // all away, and it gets the whole tab. The toolbar, the folder row and the
  // pager are dropped rather than disabled: a search box, an empty folder row
  // and a page selector over zero rows are the loudest thing on a screen whose
  // real job is to explain what a proxy is for and where to get one.
  if (state.proxies.length === 0) {
    return <ProxiesEmptyState onAddProxy={onAddProxy} onImportProxies={onImportProxies} />;
  }

  return (
    <>
      {/* The frame, exactly as the Profiles tab draws it -- the chrome on a
        * recessed shell, the table inset in it as the content card, and the
        * height stopping here so the rows scroll rather than the page. See
        * ProfilesTab for the full reasoning; this tab has borrowed its
        * vocabulary since it was written.
        *
        * Only this return takes a frame. The empty state is its own early
        * return -- a centred .tab-empty with the provider strip under it -- and
        * has no table to inset, so framing it would draw a shell around a
        * sentence. */}
      <div className="table-frame">
        <section className="table-toolbar">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search proxies by name, host, or country"
          />
          <StatusFilter
            onChange={setStatusFilter}
            options={proxyStatusOptions}
            value={statusFilter}
          />
          <select
            value={assignedFilter}
            onChange={(event) => setAssignedFilter(event.target.value as '' | 'assigned' | 'unassigned')}
          >
            <option value="">All proxies</option>
            <option value="assigned">Used by a profile</option>
            <option value="unassigned">Not used by any profile</option>
          </select>
          {/* Only offered on a team. On a one-person workspace every row is
              yours, so the filter would be a control that never changes
              anything. */}
          {state.members.length > 1 && (
            <button
              aria-pressed={mineOnly}
              className={mineOnly ? 'choice-chip active' : 'choice-chip'}
              onClick={() => setMineOnly((value) => !value)}
              type="button"
            >Assigned to me</button>
          )}
          {visible.length > 0 && (
            <button
              className="ghost"
              onClick={() => void proxies.checkMany(visible)}
              title="Check every proxy this filter is showing"
            >
              <ShieldCheck size={16} /> Check all
            </button>
          )}
          {visible.length > 0 && (
            <button className="ghost" onClick={() => void proxies.exportToCsv(visible)}>
              <Download size={16} /> Export all
            </button>
          )}
          <ColumnsButton
            registry={PROXY_COLUMNS}
            context={{isTeam: showAssignee}}
            isVisible={isVisible}
            onToggle={toggleColumn}
            onReset={reset}
          />
        </section>

        {/* The same folder navigation the Profiles tab has, minus Trash: a proxy
          * is deleted outright, there is no soft-delete to hold it. */}
        <section className="folder-row" aria-label="Folders">
          <button
            aria-pressed={!folderId}
            className={folderId ? 'folder-card' : 'folder-card active'}
            onClick={() => onFolderId('')}
            type="button"
          >
            <span className="folder-glyph"><Waypoints size={15} strokeWidth={1.75} /></span>
            <span className="folder-card-name">All proxies</span>
            <span className="folder-card-count">{state.proxies.length}</span>
          </button>

          {state.proxy_folders.map((folder) => {
            const count = state.proxies.filter((proxy) => proxy.folder_id === folder.id).length;
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

          <button className="folder-card folder-card-new" onClick={onNewFolder} type="button">
            <span className="folder-glyph"><FolderPlus size={15} strokeWidth={1.75} /></span>
            <span className="folder-card-name">New folder</span>
          </button>
        </section>

        {/* Below the folder rail, not above it. Ticking a row used to insert this
          * between the filters and the folders, which pushed the folder cards and
          * the whole table down by its height -- the navigation moving because of
          * a selection made inside it. */}
        {selection.size > 0 && (
          <section className="selection-toolbar">
            <div className="selection-toolbar-actions">
              <FolderSelect
                folders={state.proxy_folders}
                noFolderLabel="All proxies"
                onPick={(id) => void moveSelectionToFolder(id)}
              />
              <button
                className="ghost"
                onClick={() => void proxies.checkMany(selection.selectedFrom(state.proxies))}
              >
                <ShieldCheck size={16} /> Check selected
              </button>
              {/* The fix for a library imported from a file that carried no
                * credentials: the proxies are already saved and already assigned,
                * so setting the login here repairs those profiles in place. */}
              <button className="ghost" onClick={() => setCredentialsOpen(true)}>
                <KeyRound size={16} /> Set credentials…
              </button>
              <button
                className="ghost"
                onClick={() => void proxies.exportToCsv(selection.selectedFrom(state.proxies))}
              >
                <Download size={16} /> Export selected
              </button>
              <button
                className="ghost"
                onClick={() => onShare({kind: 'proxy', ids: [...selection.ids]})}
              >
                <Share2 size={16} /> Share…
              </button>
              <button
                className="danger ghost"
                onClick={() => onRequestDelete(
                    [...selection.ids],
                    `${selection.size} selected ${selection.size === 1 ? 'proxy' : 'proxies'}`,
                    selection.clear)}
              >
                <Trash2 size={16} /> Delete selected
              </button>
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
                      label={`Select all ${visible.length} proxies on this page`}
                      checked={selection.allSelected(visible)}
                      indeterminate={visible.some((item) => selection.has(item.id))}
                      onChange={() => selection.toggleAll(visible)}
                    />
                  )}
                </th>
                {/* Which columns, in what order, and what each sorts by all live
                  * in tables/proxyColumns.tsx. */}
                <ColumnHeaders columns={columns} sorting={sorting} />
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((proxy) => {
                const label = proxy.name || proxy.host;
                const isNew = newIds.has(proxy.id);
                const rowClass = [
                  selection.has(proxy.id) ? 'row-checked' : '',
                  isNew ? 'is-new' : '',
                ].filter(Boolean).join(' ');
                return (
                  <tr
                    key={proxy.id}
                    className={rowClass}
                    // So the green is never the only thing saying so. See the same
                    // title on the Profiles row.
                    title={isNew ? 'Added since you last looked' : undefined}
                  >
                    <td className="checkbox-cell">
                      <Checkbox
                        label={`Select ${proxy.name || proxy.host}`}
                        checked={selection.has(proxy.id)}
                        onChange={() => selection.toggle(proxy.id)}
                      />
                    </td>
                    <ColumnCells columns={columns} context={columnContext} row={proxy} />
                    <td className="actions-cell">
                      {/* No per-row Check button: the check chip re-checks on
                        * click now, the same trade the Profiles row made when
                        * its chip learned to -- the affordance lives on the
                        * thing it acts on. */}
                      <div className="row-actions">
                        <button
                          aria-label={`Share ${label}`}
                          className="icon-button row-action"
                          onClick={() => onShare({kind: 'proxy', ids: [proxy.id]})}
                          title="Share with another workspace"
                        >
                          <Share2 size={16} />
                        </button>
                        <button
                          aria-label={`Edit ${label}`}
                          className="icon-button row-action"
                          onClick={() => onEditProxy(proxy)}
                          title={`Edit ${label}`}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          aria-label={`Delete ${label}`}
                          className="icon-button row-action row-action-danger"
                          onClick={() => onRequestDelete([proxy.id], label)}
                          title={`Delete ${label}`}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr className="empty-row-tr">
                  {/* Counted rather than written down -- the number of columns is
                    * the user's to choose now. A short colSpan leaves a stray
                    * empty cell at the end of the row. */}
                  <td colSpan={columnCount}>
                    <EmptyState
                      icon={<SearchX size={22} />}
                      title={filtered ? 'Nothing matches those filters' : 'This folder is empty'}
                      body={filtered ?
                        'Try a different search term, or clear the status and assignment filters.' :
                        'Proxies you move into this folder will show up here.'}
                    >
                      {!filtered && (
                        <>
                          <button onClick={onAddProxy} type="button">
                            <Plus size={16} /> Add proxy
                          </button>
                          {/* A brand-new folder is far more often filled from
                            * proxies that already exist than from scratch, and
                            * the only route to that was selecting rows in a
                            * table you have to leave this folder to see. */}
                          {activeFolder && movableCount > 0 && (
                            <button className="ghost" onClick={() => setMoveOpen(true)} type="button">
                              <FolderInput size={16} /> Move proxies here
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

      {(moveOpen || fillCountry) && activeFolder && (
        <MoveProxiesModal
          folder={activeFolder}
          seedCountry={fillCountry || undefined}
          onClose={() => {
            setMoveOpen(false);
            onFillCountryDone();
          }}
        />
      )}

      {credentialsOpen && (
        <SetProxyCredentialsModal
          targets={selection.selectedFrom(state.proxies)}
          onClose={() => setCredentialsOpen(false)}
          onDone={selection.clear}
        />
      )}
    </>
  );
}

// Dismissal is a per-device UI preference, not workspace data, so it lives in
// localStorage the same way the theme choice does -- read once on mount, written
// on change. A user who has their own provider should not have to re-close this
// on every visit.
const PROVIDERS_DISMISSED_KEY = 'scout.proxy-providers-dismissed';

function readProvidersDismissed() {
  try {
    return window.localStorage.getItem(PROVIDERS_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function ProxiesEmptyState({onAddProxy, onImportProxies}: {
  onAddProxy: () => void;
  onImportProxies: () => void;
}) {
  const [dismissed, setDismissed] = useState(readProvidersDismissed);

  function setProvidersDismissed(next: boolean) {
    setDismissed(next);
    try {
      if (next) {
        window.localStorage.setItem(PROVIDERS_DISMISSED_KEY, '1');
      } else {
        window.localStorage.removeItem(PROVIDERS_DISMISSED_KEY);
      }
    } catch {
      // Private-mode or a wiped profile dir: the preference is not worth
      // failing the render over, it just will not survive a restart.
    }
  }

  return (
    <section className="tab-empty">
      <span className="tab-empty-mark">
        <Waypoints size={26} strokeWidth={1.5} />
      </span>
      <h2>No proxies yet</h2>
      <p>
        A profile needs a proxy before it can launch. Add one you already own,
        import the list your provider sent you, or pick up traffic from a
        provider below.
      </p>
      <div className="tab-empty-actions">
        <button onClick={onAddProxy}><Plus size={18} /> Add proxy</button>
        <button className="ghost" onClick={onImportProxies}>
          <Upload size={18} /> Import from file
        </button>
      </div>

      {dismissed ? (
        <button className="link-button" onClick={() => setProvidersDismissed(false)}>
          Show proxy providers
        </button>
      ) : (
        <ProviderStrip onDismiss={() => setProvidersDismissed(true)} />
      )}
    </section>
  );
}

// Every link goes to our own /go redirect rather than the provider directly:
// the main process only opens hosts we own, and it keeps the destination
// editable on the site. See providerPath in data/proxyProviders.
function ProviderStrip({onDismiss}: {onDismiss: () => void}) {
  return (
    <section className="provider-strip">
      <div className="provider-strip-head">
        <h3>Where to buy</h3>
        <button className="icon-button" aria-label="Hide proxy providers" onClick={onDismiss}>
          <X size={16} />
        </button>
      </div>
      <div className="provider-grid">
        {PROXY_PROVIDERS.map((provider) => {
          const Icon = provider.icon;
          return (
            <article className="provider-card" key={provider.slug}>
              {/* A wordmark says the name itself, so it replaces the heading
                * rather than sitting beside it. A provider we have no artwork
                * for keeps the Lucide glyph and the written name. */}
              <div className="provider-card-head">
                {provider.logo ? (
                  <img
                    alt={provider.name}
                    className={provider.adapt ?
                      `provider-logo ${provider.adapt}` :
                      'provider-logo'}
                    src={provider.logo}
                  />
                ) : (
                  <>
                    <Icon size={20} />
                    <h4>{provider.name}</h4>
                  </>
                )}
              </div>
              <p className="provider-kinds">{provider.kinds}</p>
              <p>{provider.blurb}</p>
              <button
                className="ghost"
                onClick={() => void native?.openExternal?.(`${SITE_URL}${providerPath(provider.slug)}`)}
              >
                Visit
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// describeLastCheck and sinceLabel used to live here. They are in
// components/ui/ProxyCheckCell.tsx now, because the Profiles tab and the import
// review table ask the same question of the same data and were each answering it
// their own way.

// Folder first, then the assignment filter, then the search narrows whatever
// those left -- the same order the Profiles tab filters in.
function visibleProxies(
    allProxies: ScoutProxy[],
    {folderId, search, statusFilter, assignedFilter, assigned}: {
      folderId: string;
      search: string;
      statusFilter: string;
      assignedFilter: '' | 'assigned' | 'unassigned';
      assigned: (proxy: ScoutProxy) => boolean;
    }) {
  const inFolder = folderId ?
    allProxies.filter((proxy) => proxy.folder_id === folderId) :
    allProxies;
  // Case-insensitive against the same fallback the cell renders, so filtering
  // by Ready finds the proxies that have never been marked at all -- the same
  // compare visibleProfiles makes.
  const byStatus = statusFilter ?
    inFolder.filter((proxy) =>
      (proxy.status || defaultProxyStatus).toLowerCase() === statusFilter.toLowerCase()) :
    inFolder;
  const byAssignment = assignedFilter ?
    byStatus.filter((proxy) => assigned(proxy) === (assignedFilter === 'assigned')) :
    byStatus;
  const query = search.trim().toLowerCase();
  if (!query) {
    return byAssignment;
  }
  // Port and username are matched too. Vendor lists name every proxy after its
  // host, so the port is often the only thing telling two of them apart.
  return byAssignment.filter((proxy) => proxySearchText(proxy).includes(query));
}
