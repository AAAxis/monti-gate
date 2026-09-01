// The profile import dialog: pick a file, review it as a table, then say where
// the profiles go.
//
// It replaces a single screen that showed a row count and an Import button. The
// file it is most often given is this app's own export, whose proxies carry no
// credentials, whose folder column names folders that may not exist yet, and
// whose rows may already be in the workspace -- none of which a count can say.
// So the middle step is the dialog: every field editable, every problem on the
// field that caused it, and the proxies checkable before anything is written.
//
// Nothing is created until the last step. previewCsvImport mints no ids, and
// the folder decision is deliberately the *last* thing asked rather than
// inferred from the file -- see the destination step.
import {useEffect, useMemo, useState} from 'react';
import {
  ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Download, FileSpreadsheet, Filter, FolderPlus,
  Globe, KeyRound, Link2, Table2, Tags, TriangleAlert, Upload, UserPlus, UserRound, UserRoundCog,
  Users, Wand2,
} from 'lucide-react';
import {Modal} from '../ui/Modal';
import {FormGroup} from '../ui/FormGroup';
import {BusyButton} from '../ui/BusyButton';
import {Checkbox} from '../ui/Checkbox';
import {Field} from '../ui/Field';
import {Popover} from '../ui/Popover';
import {StatusPicker} from '../ui/StatusChip';
import {PaginationBar} from '../ui/PaginationBar';
import {PlatformSelect} from '../ui/PlatformSelect';
import {FolderGlyph} from '../ui/FolderGlyph';
import {FlagIcon} from '../ui/icons';
import {ProxyCheckCell} from '../ui/ProxyCheckCell';
import {AssigneeSelect} from '../ui/AssigneeSelect';
import {useOrg} from '../../org';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import {useAsyncAction} from '../../useAsyncAction';
import {useSelection} from '../../hooks/useSelection';
import {native} from '../../native';
import {parseCsv} from '../../lib/csv';
import {paginate} from '../../lib/paginate';
import {mapWithConcurrency} from '../../lib/concurrency';
import {osPresets} from '../../lib/fingerprintPresets';
import {proxyOptionLabel, proxySearchText, splitPastedConnection} from '../../lib/proxies';
import {importColumns, profileImportExampleCsv} from '../../data/importTemplate';
import {
  applyFolderMapping,
  distributeProxies,
  importableCount,
  needsProxy,
  planCredentialFix,
  proxyBadge,
  proxyBadgeLabel,
  proxyBadgeTitle,
  proxyCheckTarget,
  proxyTextFromFields,
  proxyTextWithCredentials,
  reviewRows,
  reviseReviewRow,
  rowsToImport,
  setDuplicateAction,
} from '../../workspace/importReview';
import {summarize} from '../../workspace/csvImport';
import {
  CredentialBanner, DestinationCards, ImportDone, ImportHead, ImportStats, saveExampleFile,
} from './importParts';
import type {ImportStat} from './importParts';
import type {ClipboardEvent, KeyboardEvent} from 'react';
import type {DuplicateAction, ReviewRow} from '../../workspace/importReview';
import type {FolderDecision, ImportLibrary, ImportResult} from '../../workspace/csvImport';
import type {OrgMember} from '../../types';
import type {ProxyCheckResult} from '../../native';

// How many proxy checks run at once. Each one is a curl with a 10s ceiling, so
// this is the difference between a 200-row file taking half a minute and taking
// half an hour -- and between five curls and two hundred.
const CHECK_CONCURRENCY = 5;

type Step = 'source' | 'review' | 'destination';
type RowFilter = 'all' | 'attention' | 'new' | 'updates';
type CheckState = {status: 'checking'} | ({status: 'ok' | 'fail'} & ProxyCheckResult);

// Selection and pagination both want an `id`, and a row's identity here is the
// line it came from -- names are editable and not unique.
type Keyed = ReviewRow & {id: string};
const keyed = (rows: ReviewRow[]): Keyed[] =>
  rows.map((review) => ({...review, id: String(review.row.line)}));

export function ImportProfilesModal({onClose}: {onClose: () => void}) {
  const {data, toast, profiles, proxies, shared, statusOptions, reload} = useWorkspace();
  const {state} = data;
  const org = useOrg();
  const orgId = org.orgId;
  const {run, isPending} = useAsyncAction();

  const [step, setStep] = useState<Step>('source');
  const [path, setPath] = useState('');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [checks, setChecks] = useState<Map<number, CheckState>>(new Map());
  const [filter, setFilter] = useState<RowFilter>('all');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  // Lives here rather than in DestinationStep so the footer can carry the
  // primary button on every step -- a dialog whose confirm moves between the
  // body and the footer is one the eye has to re-find.
  const [destination, setDestination] = useState<Destination>({
    kind: 'per-row',
    // Deliberately empty. The file's value is offered as a placeholder and
    // never as a default: naming a folder is a decision, and the version this
    // replaces made it silently -- every import minted "Imported 5 July"
    // whether anyone wanted it or not.
    newName: '',
    existingId: '',
    mapping: new Map(),
    assignTo: org.userId || '',
  });
  const selection = useSelection<Keyed>();

  const library: ImportLibrary = useMemo(
      () => ({profiles: state.profiles, proxies: state.proxies, folders: state.folders}),
      [state.profiles, state.proxies, state.folders]);

  // Opening this dialog is always the Import button, and that button's first
  // act has always been to raise the OS file picker -- so it still does.
  // Cancelling leaves the dialog on its own source step.
  useEffect(() => {
    void pickCsv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickCsv() {
    if (!native?.selectImportCsv) {
      toast.setMessage('Native CSV picker is not available. Restart EasyDeck and try again.');
      return;
    }
    const picked = await native.selectImportCsv();
    if (!picked) {
      return;
    }
    const preview = profiles.previewImport(parseCsv(picked.content));
    if (!preview.rows.length) {
      toast.fail('Nothing to import',
          `${picked.path.split('/').pop()} has a header but no rows.`);
      return;
    }
    const reviewed = reviewRows(preview.rows, library);
    setPath(picked.path);
    setRows(reviewed);
    setChecks(new Map());
    setResult(null);
    setFilter('all');
    setPage(0);
    selection.clear();
    // Seeded from the file's own folder names, so "keep them" is a no-op rename
    // until the user edits one. A file with no folder column falls back to
    // naming a single new folder.
    setDestination({
      kind: preview.folders.length ? 'per-row' : 'new',
      newName: '',
      existingId: state.folders.find((folder) => (folder.kind || 'profile') === 'profile')?.id || '',
      mapping: new Map(preview.folders.map((request) =>
        [request.name.toLowerCase(), request.name])),
      // Back to the importer on every new file. Carrying the previous file's
      // choice into this one would silently hand a colleague a second import
      // they never saw the dialog for.
      assignTo: org.userId || '',
    });
    setStep('review');
  }

  function patchRow(line: number, patch: Parameters<typeof reviseReviewRow>[1]) {
    setRows((current) => current.map((review) =>
      review.row.line === line ? reviseReviewRow(review, patch, library) : review));
    // The old result no longer describes what the row would do.
    setChecks((current) => {
      if (!current.has(line)) {
        return current;
      }
      const next = new Map(current);
      next.delete(line);
      return next;
    });
  }

  function patchSelected(patch: Parameters<typeof reviseReviewRow>[1]) {
    setRows((current) => current.map((review) =>
      selection.has(String(review.row.line)) ?
        reviseReviewRow(review, patch, library) :
        review));
  }

  function setRowDuplicateAction(line: number, action: DuplicateAction) {
    setRows((current) => current.map((review) =>
      review.row.line === line ? setDuplicateAction(review, action, library) : review));
  }

  const summary = useMemo(() => summarize(rowsToImport(rows), library), [rows, library]);
  const importable = importableCount(rows);
  const attention = rows.filter((review) => {
    const badge = proxyBadge(review, library);
    return review.row.blocked || review.row.issues.length > 0 ||
      badge === 'no-credentials' || badge === 'missing';
  });
  const emptyProxies = rows.filter(needsProxy);
  // Recomputed from `library`, not stored, so applying credentials to a saved
  // proxy makes the banner and the badges fall away without re-reviewing rows.
  const credentialFix = useMemo(() => planCredentialFix(rows, library), [rows, library]);

  const filtered = rows.filter((review) => {
    if (filter === 'attention') {
      return attention.includes(review);
    }
    if (filter === 'new') {
      return !review.row.updatesProfileId && review.duplicateAction !== 'skip';
    }
    if (filter === 'updates') {
      return Boolean(review.row.updatesProfileId);
    }
    return true;
  });
  const view = paginate(keyed(filtered), page, pageSize);

  // Checks the rows the user is looking at: the selection when there is one,
  // everything otherwise. Results are dialog state, never written back into the
  // row -- the engine stays pure and a check is not a correction.
  async function checkProxies() {
    const targets = (selection.size ? rows.filter((review) =>
      selection.has(String(review.row.line))) : rows)
        .map((review) => ({line: review.row.line, target: proxyCheckTarget(review, library)}))
        .filter((entry): entry is {line: number; target: NonNullable<typeof entry.target>} =>
          Boolean(entry.target));

    if (!targets.length) {
      toast.setMessage('No rows with a proxy to check.');
      return;
    }
    setChecks((current) => {
      const next = new Map(current);
      targets.forEach(({line}) => next.set(line, {status: 'checking'}));
      return next;
    });
    await mapWithConcurrency(targets, CHECK_CONCURRENCY, async ({line, target}) => {
      // Recorded against the stored row when the proxy is one, so the result
      // lands exactly as the background sweep would have written it; an unsaved
      // proxy is only checked.
      const check: ProxyCheckResult = target.id ?
        await proxies.testConnectionAndRecord(target, target.id) :
        await proxies.testConnection(target);
      setChecks((current) => new Map(current).set(line, {
        ...check,
        status: check.ok ? 'ok' : 'fail',
      }));
    });
  }

  // Gives every credential-less proxy in the import one username and password.
  //
  // The common shape of a file exported from another tool: it names the host and
  // port of every proxy and none of the logins, because the tool that wrote it
  // would not put credentials in a CSV. All the rows are then from one provider
  // with one login, so entering it once is the whole fix.
  //
  // Two paths, decided by planCredentialFix -- unsaved rows get their connection
  // string rewritten, saved proxies are updated in place so an earlier import's
  // profiles are fixed too instead of being left on a dead duplicate.
  async function applyProxyCredentials(username: string, password: string) {
    const {lines, storedProxyIds} = credentialFix;
    if (!lines.length && !storedProxyIds.length) {
      return;
    }
    for (const proxyId of storedProxyIds) {
      const proxy = state.proxies.find((each) => each.id === proxyId);
      if (proxy) {
        // Every check column cleared, not just the error: the whole result
        // described a proxy with no login, and leaving a country behind with no
        // timestamp would read as a check that had passed.
        await proxies.update({
          ...proxy,
          username,
          password,
          country: undefined,
          country_code: undefined,
          egress_ip: undefined,
          ping_ms: undefined,
          checked_at: undefined,
          check_error: undefined,
        });
      }
    }
    if (lines.length) {
      const wanted = new Set(lines);
      setRows((current) => current.map((review) => {
        if (!wanted.has(review.row.line)) {
          return review;
        }
        const proxyText = proxyTextWithCredentials(review.row, username, password);
        return proxyText ? reviseReviewRow(review, {proxyText}, library) : review;
      }));
    }
    // Every affected row's previous result described a proxy with no login.
    // patchRow drops a rewritten row's check on its own, but the rows sharing an
    // updated *saved* proxy never went through it.
    setChecks((current) => {
      const next = new Map(current);
      for (const review of rows) {
        const stored = review.row.matchedProxyId;
        if (lines.includes(review.row.line) || (stored && storedProxyIds.includes(stored))) {
          next.delete(review.row.line);
        }
      }
      return next;
    });
    const total = credentialFix.proxyCount;
    toast.setMessage(
        `Applied credentials to ${total} ${total === 1 ? 'proxy' : 'proxies'}` +
        (storedProxyIds.length ?
          ` · ${storedProxyIds.length} already saved ${storedProxyIds.length === 1 ? 'proxy was' : 'proxies were'} updated` :
          ''));
  }

  function fillEmptyProxies() {
    const assignments = distributeProxies(rows, library);
    if (!assignments.size) {
      toast.setMessage(state.proxies.length ?
        'Every proxy in your library is already used by one of these rows.' :
        'There are no proxies in your library to hand out yet.');
      return;
    }
    setRows((current) => current.map((review) => {
      const proxyId = assignments.get(review.row.line);
      return proxyId ? reviseReviewRow(review, {proxyId}, library) : review;
    }));
    toast.setMessage(`Filled ${assignments.size} ${assignments.size === 1 ? 'proxy' : 'proxies'} from your library`);
  }

  async function commit(decision: FolderDecision, mapped: ReviewRow[]) {
    const imported = await profiles.importFromCsv(rowsToImport(mapped), decision);
    // Only when the target is somebody other than the importer: every row was
    // stamped with auth.uid() by the column default as it was inserted, so
    // leaving the picker alone needs no second write at all.
    //
    // Created rows only -- imported.createdIds excludes the profiles this run
    // merely updated, which keep whoever already held them.
    const createdIds = imported.createdIds || [];
    if (destination.assignTo !== (org.userId || '') && createdIds.length && orgId) {
      await shared.setAssignees(orgId, 'profile', createdIds, destination.assignTo || null);
      // importFromCsv already patched the new profiles into local state, but it
      // put them there carrying the assignee they were INSERTED with. Without
      // this the Assigned column would show the importer until the next window
      // focus, contradicting the choice just made in this dialog.
      reload();
    }
    setResult(imported);
    toast.setMessage(imported.partial ?
      `Imported ${imported.created} new, updated ${imported.updated} — the write stopped partway` :
      `Imported ${imported.created} new, updated ${imported.updated} profiles`);
  }

  const stepIndex = step === 'source' ? 0 : step === 'review' ? 1 : 2;
  const fileName = path.split('/').pop() || '';

  if (result) {
    return (
      <Modal
        className="editor-modal import-panel"
        onClose={onClose}
        header={
          <ImportHead
            mark={<span className="import-mark"><FileSpreadsheet size={18} /></span>}
            // The dialog still says what it IS. What HAPPENED is the hero
            // below, which is where the eye lands -- printing "Import
            // finished" in both places said one thing twice and named the
            // file nowhere.
            title="Import profiles"
            meta={fileName && <span>{fileName}</span>}
            actions={<button onClick={onClose}>Done</button>}
          />
        }
      >
        <div className="import-body">
          <ImportDone outcome={importOutcome(result)} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      className={step === 'review' ?
        'editor-modal import-panel import-review-panel' :
        'editor-modal import-panel'}
      onClose={onClose}
      header={
        <ImportHead
          mark={<span className="import-mark"><FileSpreadsheet size={18} /></span>}
          title="Import profiles"
          steps={3}
          step={stepIndex}
          meta={
            <>
              <span>{
                step === 'source' ? 'Choose a file' :
                step === 'review' ? 'Check the data' :
                'Choose a folder'
              }</span>
              {fileName && <span className="import-head-file">{fileName}</span>}
              {step !== 'source' && (
                <span className="import-head-count">
                  {importable} {importable === 1 ? 'profile' : 'profiles'} ready
                  {rows.length - importable > 0 &&
                    ` · ${rows.length - importable} skipped`}
                </span>
              )}
            </>
          }
          actions={
            <>
              {step === 'review' && (
                <>
                  <button className="ghost" onClick={() => setStep('source')}>
                    <ArrowLeft size={16} /> Back
                  </button>
                  <button disabled={!importable} onClick={() => setStep('destination')}>
                    Choose folder <ArrowRight size={16} />
                  </button>
                </>
              )}
              {step === 'destination' && (
                <>
                  <button className="ghost" onClick={() => setStep('review')}>
                    <ArrowLeft size={16} /> Back
                  </button>
                  <BusyButton
                    busy={isPending('run-import')}
                    busyLabel="Importing…"
                    disabled={!destinationReady(destination)}
                    onClick={() => void run('run-import', () => {
                      const {decision, folderNames} = folderDecisionFor(destination);
                      return commit(decision, folderNames ?
                        applyFolderMapping(rows, folderNames, library) :
                        rows);
                    })}
                  >
                    Import {importable} {importable === 1 ? 'profile' : 'profiles'}
                  </BusyButton>
                </>
              )}
              {step === 'source' && (
                <button className="ghost" onClick={onClose}>Cancel</button>
              )}
            </>
          }
        />
      }
    >
      <div className="import-body">
      {step === 'source' && <SourceStep path={path} onPick={() => void pickCsv()} toast={toast} />}

      {step === 'review' && (
        <>
          <FormGroup
            title="What this file will do"
            icon={<Table2 size={14} />}
            hint="Counted from the rows below, and recounted as you edit them."
          >
            <div className="form-group-full">
              <ImportStats stats={[
                {label: 'To create', value: summary.createCount, icon: <UserPlus size={15} />},
                {label: 'To update', value: summary.updateCount, icon: <UserRoundCog size={15} />},
                {label: 'Need attention', value: attention.length, icon: <TriangleAlert size={15} />},
                {label: 'New proxies', value: summary.newProxyCount, icon: <Globe size={15} />},
                {label: 'Reused proxies', value: summary.reusedProxyCount, icon: <Link2 size={15} />},
              ]} />
            </div>
          </FormGroup>

          {credentialFix.proxyCount > 0 && (
            <CredentialBanner
              count={credentialFix.proxyCount}
              busy={isPending('apply-credentials')}
              onApply={(username, password) => void run('apply-credentials',
                  () => applyProxyCredentials(username, password))}
            />
          )}

          <div className="import-review-toolbar">
            <div className="filter-chips" role="group" aria-label="Filter rows">
              {([
                ['all', `All ${rows.length}`],
                ['attention', `Needs attention ${attention.length}`],
                ['new', `New ${summary.createCount}`],
                ['updates', `Updates ${summary.updateCount}`],
              ] as Array<[RowFilter, string]>).map(([key, label]) => (
                <button
                  key={key}
                  className={filter === key ? 'chip on' : 'chip'}
                  aria-pressed={filter === key}
                  onClick={() => {
                    setFilter(key);
                    setPage(0);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <BusyButton
              className="ghost"
              busy={isPending('check-proxies')}
              busyLabel="Checking…"
              onClick={() => void run('check-proxies', checkProxies)}
            >
              {selection.size ? `Check ${selection.size} selected` : 'Check proxies'}
            </BusyButton>
            {emptyProxies.length > 0 && (
              <button className="ghost" onClick={fillEmptyProxies}>
                <Wand2 size={16} /> Fill {emptyProxies.length} from library
              </button>
            )}
          </div>

          {selection.size > 0 && (
            <BulkBar
              count={selection.size}
              statusOptions={statusOptions}
              onPatch={patchSelected}
              onClear={selection.clear}
            />
          )}

          <div className="table-wrap import-review-table">
            <table>
              <thead>
                <tr>
                  <th className="checkbox-cell">
                    <Checkbox
                      label="Select all rows on this page"
                      checked={selection.allSelected(view.items)}
                      indeterminate={view.items.some((item) => selection.has(item.id))}
                      onChange={() => selection.toggleAll(view.items)}
                    />
                  </th>
                  <th className="import-state-cell" aria-label="Row state" />
                  {/* th-value indents the label to where the value under it
                    * actually starts -- a cell's control carries its own border
                    * and padding, so a header aligned to the cell box sits a
                    * clear 9px to the left of every value in its column. */}
                  <th className="th-value">Name</th>
                  <th className="th-value">Platform</th>
                  <th className="th-value">Status</th>
                  <th className="th-value">Proxy</th>
                  <th className="th-value">Check</th>
                  <th className="th-value">Tags</th>
                  <th className="th-value">Folder</th>
                  <th className="import-toggle-cell" aria-label="Details" />
                </tr>
              </thead>
              <tbody>
                {view.items.map((review) => (
                  <ReviewTableRow
                    key={review.id}
                    review={review}
                    check={checks.get(review.row.line)}
                    library={library}
                    statusOptions={statusOptions}
                    checked={selection.has(review.id)}
                    expanded={expanded === review.row.line}
                    onToggleChecked={() => selection.toggle(review.id)}
                    onToggleExpanded={() =>
                      setExpanded(expanded === review.row.line ? null : review.row.line)}
                    onPatch={(patch) => patchRow(review.row.line, patch)}
                    onDuplicateAction={(action) =>
                      setRowDuplicateAction(review.row.line, action)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <PaginationBar
            page={view.page}
            totalPages={view.totalPages}
            total={view.total}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size);
              setPage(0);
            }}
            extra={selection.size > 0 ?
              <span className="pagination-selected">{selection.size} selected</span> :
              undefined}
          />
        </>
      )}

      {step === 'destination' && (
        <DestinationStep
          rows={rows}
          library={library}
          folders={state.folders}
          members={state.members}
          destination={destination}
          onChange={(patch) => setDestination((current) => ({...current, ...patch}))}
        />
      )}
      </div>
    </Modal>
  );
}

function SourceStep(
    {path, onPick, toast}:
    {path: string; onPick: () => void; toast: {setMessage: (message: string) => void}}) {
  return (
    <>
      <FormGroup
        title="The file"
        icon={<FileSpreadsheet size={14} />}
        hint="Nothing is written until you have seen the rows and chosen a folder."
      >
        <div className="form-group-full">
          <p className="import-lead">
            Import profiles in bulk from an inventory CSV. A file this app exported can be fed
            straight back in, and updates the profiles it came from rather than duplicating them.
          </p>
          <div className="import-actions">
            <button className="ghost" onClick={onPick}>
              <Upload size={18} /> Choose CSV file
            </button>
            <button
              className="ghost"
              onClick={() => void saveExampleFile('monti-profiles-example.csv',
                  profileImportExampleCsv(), toast.setMessage, native?.saveTextFile)}
            >
              <Download size={18} /> Download example
            </button>
            {path && <span className="import-file-label">{path.split('/').pop()}</span>}
          </div>
        </div>
      </FormGroup>

      <FormGroup
        title="Columns"
        icon={<Table2 size={14} />}
        hint="Matched by name, in any order. Anything missing falls back to a default."
      >
        <div className="form-group-full">
          <dl className="import-columns">
            {importColumns.map((column) => (
              <div key={column.name}>
                <dt>
                  <code>{column.name}</code>
                  {column.required && <em>required</em>}
                </dt>
                <dd>{column.note}</dd>
              </div>
            ))}
          </dl>
        </div>
      </FormGroup>
    </>
  );
}

function BulkBar({count, statusOptions, onPatch, onClear}: {
  count: number;
  statusOptions: string[];
  onPatch: (patch: Parameters<typeof reviseReviewRow>[1]) => void;
  onClear: () => void;
}) {
  const [tags, setTags] = useState('');
  const [startUrl, setStartUrl] = useState('');
  return (
    <div className="selection-toolbar">
      <strong>{count} selected</strong>
      <label className="field inline-field">
        <span>Status</span>
        <select value="" onChange={(event) => onPatch({status: event.target.value})}>
          <option value="" disabled>Set status…</option>
          {statusOptions.map((status) => <option key={status}>{status}</option>)}
        </select>
      </label>
      {/* A logo-only trigger would be wrong here: this sets a value rather than
          showing one, so an empty platform mark would read as "the selection is
          Windows" instead of "choose a platform for the selection". */}
      <label className="field inline-field">
        <span>Platform</span>
        <select value="" onChange={(event) => onPatch({os: event.target.value})}>
          <option value="" disabled>Set platform…</option>
          {osPresets.map((os) => <option key={os}>{os}</option>)}
        </select>
      </label>
      <label className="field inline-field">
        <span>Tags</span>
        <input
          value={tags}
          placeholder="Replace tags…"
          onChange={(event) => setTags(event.target.value)}
          onBlur={() => tags && onPatch({tagsText: tags})}
        />
      </label>
      <label className="field inline-field">
        <span>Start URL</span>
        <input
          value={startUrl}
          placeholder="Replace start URL…"
          onChange={(event) => setStartUrl(event.target.value)}
          onBlur={() => startUrl && onPatch({startUrl})}
        />
      </label>
      <button className="ghost" onClick={onClear}>Clear selection</button>
    </div>
  );
}

function ReviewTableRow({
  review, check, library, statusOptions, checked, expanded,
  onToggleChecked, onToggleExpanded, onPatch, onDuplicateAction,
}: {
  review: ReviewRow;
  check: CheckState | undefined;
  library: ImportLibrary;
  statusOptions: string[];
  checked: boolean;
  expanded: boolean;
  onToggleChecked: () => void;
  onToggleExpanded: () => void;
  onPatch: (patch: Parameters<typeof reviseReviewRow>[1]) => void;
  onDuplicateAction: (action: DuplicateAction) => void;
}) {
  const {row} = review;
  const issueFor = (field: string) => row.issues.find((issue) => issue.field === field);
  const nameIssue = issueFor('name') || issueFor('profile_id');
  const badge = proxyBadge(review, library);
  const skipped = review.duplicateAction === 'skip';

  return (
    <>
      <tr className={[
        checked ? 'row-checked' : '',
        row.blocked ? 'row-blocked' : '',
        skipped ? 'row-skipped' : '',
      ].filter(Boolean).join(' ')}
      >
        <td className="checkbox-cell">
          <Checkbox
            label={`Select ${row.name || `row ${row.line}`}`}
            checked={checked}
            onChange={onToggleChecked}
          />
        </td>
        <td className="import-state-cell">
          <RowStateDot review={review} library={library} />
        </td>
        <td>
          <input
            className={nameIssue?.blocking ? 'invalid' : ''}
            value={row.input.name}
            title={nameIssue?.message}
            placeholder="Required"
            onChange={(event) => onPatch({name: event.target.value})}
          />
        </td>
        <td>
          <PlatformSelect
            value={row.input.os}
            fromFileLabel="From file"
            onChange={(os) => onPatch({os})}
          />
        </td>
        <td onClick={(event) => event.stopPropagation()}>
          <StatusPicker
            status={row.status}
            options={statusOptions}
            onChange={(status) => onPatch({status})}
          />
        </td>
        <td>
          <ProxyCell review={review} library={library} onPatch={onPatch} />
        </td>
        <td className="import-check-cell">
          <CheckCell check={check} badge={badge} />
        </td>
        <td>
          <input
            className={row.tagsTrimmed ? 'warned' : ''}
            value={row.input.tagsText}
            // The raw column text stays in the input so typing behaves, but a
            // file that separates with semicolons reads as one tag until you
            // are told otherwise -- so the title says what will be created.
            title={issueFor('tags')?.message ||
              (row.tags.length ? `Tags: ${row.tags.join(', ')}` : undefined)}
            placeholder="Comma-separated"
            onChange={(event) => onPatch({tagsText: event.target.value})}
          />
        </td>
        <td className="import-folder-cell">
          {row.folder || <i>—</i>}
        </td>
        <td className="import-toggle-cell">
          {/* A lucide chevron rather than the ⌃/⌄ characters this used to
            * print: those two glyphs have different vertical metrics in the UI
            * font, so the control jumped a couple of pixels on expand and sat
            * off the line the rest of the row shares either way. */}
          <button
            className="icon-button import-detail-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide details' : 'Show details'}
            title={expanded ? 'Hide details' : 'Show details'}
            onClick={onToggleExpanded}
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </td>
      </tr>
      {review.nameMatch && (
        <tr className="import-duplicate-row">
          <td colSpan={10}>
            <div className="import-duplicate-note">
              <span className="proxy-badge unassigned">Already exists</span>
              <span>
                A profile called <b>{review.nameMatch.name}</b> is already in this workspace.
              </span>
              <select
                value={review.duplicateAction}
                onChange={(event) => onDuplicateAction(event.target.value as DuplicateAction)}
              >
                <option value="update">Update it</option>
                <option value="new">Import as new</option>
                <option value="skip">Skip this row</option>
              </select>
            </div>
          </td>
        </tr>
      )}
      {expanded && (
        <tr className="import-detail-row">
          <td colSpan={10}>
            <div className="import-detail-grid">
              <Field label="Profile id" hint="Reclaims the browser directory, cookies and session.">
                <input
                  className={issueFor('profile_id')?.blocking ? 'invalid' : ''}
                  value={row.input.profileId}
                  placeholder="Generated on import"
                  onChange={(event) => onPatch({profileId: event.target.value})}
                />
              </Field>
              <Field label="Start URL">
                <input
                  value={row.input.startUrl}
                  placeholder="Opens the launcher home page"
                  onChange={(event) => onPatch({startUrl: event.target.value})}
                />
              </Field>
              <Field label="User agent" hint="Left empty, it is derived from the platform.">
                <input
                  value={row.input.userAgent}
                  placeholder="Auto"
                  onChange={(event) => onPatch({userAgent: event.target.value})}
                />
              </Field>
              <Field label="Language">
                <input
                  className={issueFor('language') ? 'warned' : ''}
                  value={row.input.language}
                  title={issueFor('language')?.message}
                  placeholder="Auto from proxy"
                  onChange={(event) => onPatch({language: event.target.value})}
                />
              </Field>
              <Field label="Timezone">
                <input
                  className={issueFor('timezone') ? 'warned' : ''}
                  value={row.input.timezone}
                  title={issueFor('timezone')?.message}
                  placeholder="Auto from proxy"
                  onChange={(event) => onPatch({timezone: event.target.value})}
                />
              </Field>
              <Field label="Browser version">
                <input
                  className={issueFor('browser_version') ? 'warned' : ''}
                  value={row.input.browserVersion}
                  title={issueFor('browser_version')?.message}
                  placeholder="Auto"
                  onChange={(event) => onPatch({browserVersion: event.target.value})}
                />
              </Field>
              <Field label="Created">
                <input
                  className={issueFor('created_at') ? 'warned' : ''}
                  value={row.input.createdAt}
                  title={issueFor('created_at')?.message}
                  placeholder="Time of import"
                  onChange={(event) => onPatch({createdAt: event.target.value})}
                />
              </Field>
            </div>
            {row.issues.length > 0 && (
              <ul className="import-issue-list">
                {row.issues.map((issue, index) => (
                  <li key={index} className={issue.blocking ? 'blocking' : ''}>
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function RowStateDot({review, library}: {review: ReviewRow; library: ImportLibrary}) {
  if (review.duplicateAction === 'skip') {
    return <i className="import-dot skipped" title="Skipped — not imported" />;
  }
  if (review.row.blocked) {
    const blocking = review.row.issues.filter((issue) => issue.blocking);
    return <i className="import-dot blocked" title={blocking.map((i) => i.message).join('; ')} />;
  }
  const badge = proxyBadge(review, library);
  const warnings = [
    ...review.row.issues.map((issue) => issue.message),
    badge === 'no-credentials' ?
      'This proxy has no username or password — if it needs one, the check will fail ' +
      'and launch will be blocked. Use the banner above to apply a login to every ' +
      'proxy in this file at once.' :
      '',
    badge === 'missing' ? 'No proxy' : '',
  ].filter(Boolean);
  if (warnings.length) {
    return <i className="import-dot warned" title={warnings.join('; ')} />;
  }
  return <i className="import-dot ok" title="Ready" />;
}

// The same chip the two tables use, so "685 ms · US" looks identical whether the
// proxy is being reviewed or already saved. No `age`: these results are dialog
// state that never reaches a row, so there is no checked_at to date them by.
function CheckCell({check, badge}: {check: CheckState | undefined; badge: string}) {
  if (!check) {
    // A direct or free-proxy row has nothing to check, which is different from
    // having a proxy nobody has checked yet.
    return badge === 'direct' || badge === 'free' ?
      <i>—</i> :
      <ProxyCheckCell state={{status: 'unchecked'}} />;
  }
  if (check.status === 'checking') {
    return <ProxyCheckCell state={{status: 'checking'}} />;
  }
  if (check.status === 'ok') {
    return (
      <ProxyCheckCell
        state={{
          status: 'ok',
          pingMs: check.pingMs,
          country: check.country,
          countryCode: check.countryCode,
        }}
      />
    );
  }
  return <ProxyCheckCell state={{status: 'fail', error: check.error}} />;
}

function ProxyCell({review, library, onPatch}: {
  review: ReviewRow;
  library: ImportLibrary;
  onPatch: (patch: Parameters<typeof reviseReviewRow>[1]) => void;
}) {
  const {row} = review;
  const badge = proxyBadge(review, library);
  const label = row.proxy ? `${row.proxy.host}:${row.proxy.port}` :
    row.proxyMode === 'assigned' ? (row.input.proxyText || 'None') : '—';
  const tone = badge === 'unreadable' || badge === 'missing' ? 'unassigned' :
    badge === 'no-credentials' ? 'unassigned' : 'assigned';

  return (
    <Popover
      label="Change proxy"
      width={360}
      panelClassName="import-proxy-pop"
      triggerClassName="import-proxy-trigger"
      trigger={
        <>
          <span className="import-proxy-host">{label}</span>
          {/* The badge is abbreviated to keep the trigger on one line; the full
              phrase is the title, on the badge itself rather than the trigger so
              it does not fight the popover's own "Change proxy" label. */}
          <span className={`proxy-badge ${tone}`} title={proxyBadgeTitle[badge]}>
            {proxyBadgeLabel[badge]}
          </span>
        </>
      }
    >
      {(close) => (
        <ProxyPicker
          review={review}
          library={library}
          onPatch={(patch) => {
            onPatch(patch);
            close();
          }}
        />
      )}
    </Popover>
  );
}

// The per-row proxy editor, as four fields rather than one connection string.
//
// A file exported from another tool names the host and port of every proxy and
// none of their logins -- so the fields that are empty here are the whole point
// of the screen, and a single text box hid them behind a syntax the user had to
// know. The bulk banner above the table answers "all of these share one login";
// this answers the row that does not.
//
// Pasting a full vendor line into any of the four still splits it across all of
// them, through the same splitPastedConnection the proxy editor uses.
function ProxyPicker({review, library, onPatch}: {
  review: ReviewRow;
  library: ImportLibrary;
  onPatch: (patch: Parameters<typeof reviseReviewRow>[1]) => void;
}) {
  const [search, setSearch] = useState('');
  // Seeded from the *resolved* proxy, not the raw text: resolveRow has already
  // filled row.proxy from the picked proxy id when there is one, so a row that
  // borrowed a saved login opens showing that login. Falling back to the raw
  // text matters only when the line could not be read at all -- there is no
  // parsed proxy then, and what the file actually said is what the user needs to
  // see in order to fix it.
  const parsed = review.row.proxy;
  const [type, setType] = useState<'http' | 'socks5'>(parsed?.type || 'socks5');
  const [address, setAddress] = useState(
      parsed ? `${parsed.host}:${parsed.port}` : review.row.input.proxyText);
  const [username, setUsername] = useState(parsed?.username || '');
  const [password, setPassword] = useState(parsed?.password || '');

  const needle = search.trim().toLowerCase();
  const matches = library.proxies
      .filter((proxy) => !needle || proxySearchText(proxy).includes(needle))
      .slice(0, 40);

  // True when this row is pointing at a proxy that is already saved, which is
  // what makes the username warning below worth showing.
  const matched = Boolean(review.row.matchedProxyId);

  function absorb(raw: string, strict: boolean) {
    const split = splitPastedConnection(raw, {strict});
    if (!split) {
      return false;
    }
    // Only when the pasted line named a protocol. A bare host:port:user:pass
    // parses as socks5 by default, and letting that default overwrite the
    // selector would silently retype an HTTP proxy.
    if (split.explicitType && split.type) {
      setType(split.type);
    }
    setAddress(`${split.host}:${split.port}`);
    // Only a line that actually carried a login touches the credential fields.
    // Address re-splits on every blur, and "host:port" always has the colon that
    // makes it parse -- so overwriting unconditionally meant clicking back into
    // Address to fix a typo silently emptied the username and password that had
    // just been typed beside it. Clearing them is what the fields themselves are
    // for.
    if (split.username || split.password) {
      setUsername(split.username || '');
      setPassword(split.password || '');
    }
    return true;
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>, strict: boolean) {
    if (absorb(event.clipboardData.getData('text'), strict)) {
      event.preventDefault();
    }
  }

  function apply() {
    onPatch({
      proxyText: proxyTextFromFields(address, type, username, password),
      proxyId: '',
      proxyMode: 'assigned',
    });
  }

  // Enter commits from any of the four fields, not just the first one.
  function onFieldKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      apply();
    }
  }

  return (
    <div className="import-proxy-picker">
      <div className="import-proxy-endpoint">
        <Field label="Type" compact>
          <select
            value={type}
            onChange={(event) => setType(event.target.value as 'http' | 'socks5')}
          >
            <option value="socks5">SOCKS5</option>
            <option value="http">HTTP</option>
          </select>
        </Field>
        <Field label="Address" compact hint="host:port — or paste the whole line">
          <input
            value={address}
            placeholder="198.51.100.10:1080"
            onChange={(event) => setAddress(event.target.value)}
            // Not strict: whatever is pasted here was meant to be an address.
            // Split on paste rather than on every keystroke, or the fields would
            // be rewritten while the user was still typing the port.
            onPaste={(event) => onPaste(event, false)}
            // Catches the paths onPaste misses -- drag-and-drop, and a line
            // typed out by hand -- once the user has moved on from the field.
            onBlur={(event) => absorb(event.target.value, false)}
            onKeyDown={onFieldKeyDown}
          />
        </Field>
      </div>
      <Field
        label="Username"
        hint={matched ?
          'A different username is saved as a separate proxy for this host.' :
          undefined}
      >
        <input
          autoComplete="off"
          value={username}
          placeholder="Optional"
          onChange={(event) => setUsername(event.target.value)}
          onPaste={(event) => onPaste(event, true)}
          onKeyDown={onFieldKeyDown}
        />
      </Field>
      <Field label="Password">
        <input
          autoComplete="off"
          type="password"
          value={password}
          placeholder="Optional"
          onChange={(event) => setPassword(event.target.value)}
          onPaste={(event) => onPaste(event, true)}
          onKeyDown={onFieldKeyDown}
        />
      </Field>
      <button className="ghost" onClick={apply}>
        Use this proxy
      </button>

      <div className="import-proxy-modes">
        <button className="ghost" onClick={() => onPatch({proxyMode: 'direct'})}>
          No proxy (direct)
        </button>
        <button className="ghost" onClick={() => onPatch({proxyMode: 'free_proxy'})}>
          Free proxy
        </button>
      </div>

      <Field label="Or use one of your proxies">
        <input
          value={search}
          placeholder="Search your library…"
          onChange={(event) => setSearch(event.target.value)}
        />
      </Field>
      <div className="import-proxy-options">
        {matches.map((proxy) => (
          <button
            key={proxy.id}
            className="import-proxy-option"
            onClick={() => onPatch({proxyId: proxy.id, proxyMode: 'assigned'})}
          >
            {proxy.country_code && <FlagIcon countryCode={proxy.country_code} />}
            {proxyOptionLabel(proxy)}
          </button>
        ))}
        {!matches.length && <i className="import-proxy-empty">No proxies match.</i>}
      </div>
    </div>
  );
}

type DestinationKind = 'new' | 'existing' | 'per-row' | 'unfiled';
type Destination = {
  kind: DestinationKind;
  newName: string;
  existingId: string;
  mapping: Map<string, string>;
  // Who the created profiles end up assigned to: an auth user id, or '' for
  // nobody. Defaults to the importer, which is also what the profiles.assigned_to
  // column default does on its own -- this only has to act when it is changed.
  //
  // Deliberately NOT read from the file. There is no assignee column in
  // importColumns and this does not add one: a CSV would carry a name or an
  // email rather than an auth id, and a file from another tool naming people
  // who are not on this team would import a column of "Former member".
  assignTo: string;
};

// The chosen destination as the engine wants it, plus the per-value renaming
// the engine deliberately knows nothing about.
function folderDecisionFor(destination: Destination): {
  decision: FolderDecision;
  folderNames?: Map<string, string>;
} {
  if (destination.kind === 'new') {
    return {decision: {kind: 'new', name: destination.newName.trim()}};
  }
  if (destination.kind === 'existing') {
    return {decision: {kind: 'existing', folderId: destination.existingId}};
  }
  if (destination.kind === 'per-row') {
    return {decision: {kind: 'per-row'}, folderNames: destination.mapping};
  }
  return {decision: {kind: 'unfiled'}};
}

function destinationReady(destination: Destination) {
  if (destination.kind === 'new') {
    return Boolean(destination.newName.trim());
  }
  if (destination.kind === 'existing') {
    return Boolean(destination.existingId);
  }
  return true;
}

function DestinationStep({rows, library, folders, members, destination, onChange}: {
  rows: ReviewRow[];
  library: ImportLibrary;
  folders: ImportLibrary['folders'];
  members: OrgMember[];
  destination: Destination;
  onChange: (patch: Partial<Destination>) => void;
}) {
  // One summarize for both questions this step asks: which folders the file
  // wants, and how many rows are new. `createCount` is what the assignee field
  // is about -- it only touches created rows, so on a re-import of an export it
  // can be zero while `count` below is two hundred.
  const {folders: requests, createCount} = useMemo(
      () => summarize(rowsToImport(rows), library), [rows, library]);
  const {kind, newName, existingId, mapping, assignTo} = destination;
  const setKind = (next: DestinationKind) => onChange({kind: next});

  const count = importableCount(rows);
  const profileFolders = folders.filter((folder) => (folder.kind || 'profile') === 'profile');

  return (
    <>
      <FormGroup
        title="Folder"
        icon={<FolderPlus size={14} />}
        hint={`Where ${count} ${count === 1 ? 'profile goes' : 'profiles go'}. Nothing has been created yet — including folders.`}
      >
        <div className="form-group-full">
          <DestinationCards
            label="Folder destination"
            value={kind}
            onSelect={setKind}
            options={[
              ...(requests.length > 0 ? [{
                kind: 'per-row' as const,
                title: 'Keep the folders from the file',
                body: `${requests.length} folder ${requests.length === 1 ? 'name' : 'names'} in this file`,
              }] : []),
              {
                kind: 'new' as const,
                title: 'One new folder',
                body: 'Everything in this import goes into a folder you name',
              },
              {
                kind: 'existing' as const,
                title: 'An existing folder',
                body: profileFolders.length ?
                  'Add them to a folder you already have' :
                  'You have no folders yet',
                disabled: !profileFolders.length,
              },
              {
                kind: 'unfiled' as const,
                title: 'No folder',
                body: 'Leave them under All profiles',
              },
            ]}
          />
        </div>

        {kind === 'new' && (
          <Field
            label="Folder name"
            wide
            hint="Left empty on purpose — a folder name is a decision, not a default."
          >
            <input
              autoFocus
              value={newName}
              placeholder={requests[0]?.name || 'e.g. Facebook warmup'}
              onChange={(event) => onChange({newName: event.target.value})}
            />
          </Field>
        )}

        {kind === 'existing' && (
          <Field label="Folder" wide>
            <select
              value={existingId}
              onChange={(event) => onChange({existingId: event.target.value})}
            >
              {profileFolders.map((folder) => (
                <option key={folder.id} value={folder.id}>{folder.name}</option>
              ))}
            </select>
          </Field>
        )}

        {kind === 'per-row' && (
          <div className="form-group-full">
            <div className="folder-mapping">
              {requests.map((request) => (
                <div className="folder-mapping-row" key={request.name}>
                  <span className="folder-mapping-source">
                    <FolderGlyph
                      color={undefined}
                      icon={undefined}
                      size={13}
                      small
                    />
                    {request.name}
                    <i>{request.rowCount} {request.rowCount === 1 ? 'profile' : 'profiles'}</i>
                  </span>
                  <ArrowRight size={14} aria-hidden="true" />
                  <input
                    value={mapping.get(request.name.toLowerCase()) ?? ''}
                    placeholder="Leave empty for no folder"
                    onChange={(event) => onChange({
                      mapping: new Map(mapping).set(
                          request.name.toLowerCase(), event.target.value),
                    })}
                  />
                  {request.existingFolderId && (
                    <span className="proxy-badge assigned">Existing folder</span>
                  )}
                </div>
              ))}
              <p className="field-hint">
                A name that already exists adds to that folder. An empty name leaves those
                profiles unfiled.
              </p>
            </div>
          </div>
        )}
      </FormGroup>

      {/* Only on a team, matching the profile editor and the Assigned column.
          Placed after the folder decision because it is the smaller of the two
          questions and has a working default -- the folder does not. */}
      {members.length > 1 && (
        <FormGroup
          title="Assignment"
          icon={<Users size={14} />}
          hint="Who these profiles show up under in the Assigned column."
        >
          <Field
            label="Assign these profiles to"
            icon={<UserRound size={14} />}
            wide
            hint={createCount === 0 ?
              'Nothing new to assign — every row in this file updates a profile that already exists, and those keep whoever is looking after them.' :
              `Applies to the ${createCount} new ${createCount === 1 ? 'profile' : 'profiles'}. Rows that update an existing profile keep their current assignee. This is a label, not a lock — everyone on the team can open them either way.`}
          >
            <AssigneeSelect
              members={members}
              onChange={(next) => onChange({assignTo: next})}
              unassignedLabel="Nobody"
              value={assignTo}
            />
          </Field>
        </FormGroup>
      )}
    </>
  );
}

// What the finished screen says, as the shared ImportDone wants it.
//
// Icons repeat across the two proxy stats and the two profile stats on purpose:
// the pairs are the same noun counted twice, and giving each its own mark made
// five tiles read as five unrelated things.
function importOutcome(result: ImportResult) {
  const stats: ImportStat[] = [
    {label: 'Profiles created', value: result.created, icon: <UserPlus size={15} />},
    {label: 'Profiles updated', value: result.updated, icon: <UserRoundCog size={15} />},
    {label: 'Proxies created', value: result.proxiesCreated, icon: <Globe size={15} />},
    {label: 'Proxies reused', value: result.proxiesReused, icon: <Link2 size={15} />},
    {label: 'Folders created', value: result.foldersCreated, icon: <FolderPlus size={15} />},
  ];
  if (result.proxiesUpdated) {
    stats.push({label: 'Proxy passwords updated', value: result.proxiesUpdated,
      icon: <KeyRound size={15} />});
  }
  if (result.tagsTrimmed) {
    stats.push({label: 'Rows with tags trimmed', value: result.tagsTrimmed,
      icon: <Tags size={15} />});
  }

  // The one line worth reading if you read nothing else. Zero-valued stats are
  // left out of it rather than reported as "0 profiles updated", which is not
  // news; the tiles below still carry every number.
  const headline = [
    result.created && `${result.created} ${result.created === 1 ? 'profile' : 'profiles'} created`,
    result.updated && `${result.updated} updated`,
    result.proxiesCreated &&
      `${result.proxiesCreated} ${result.proxiesCreated === 1 ? 'proxy' : 'proxies'} added`,
    result.foldersCreated &&
      `${result.foldersCreated} ${result.foldersCreated === 1 ? 'folder' : 'folders'} created`,
  ].filter(Boolean).join(' \u00b7 ');

  return {headline, stats, partial: result.partial, skipped: result.skipped};
}
