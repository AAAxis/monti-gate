// The proxy list importer: pick a file, review it as an editable table, then say
// which folder the proxies go in.
//
// It replaces a single screen that listed what the file contained and offered
// one button. That screen could tell you line 14 was unreadable and could do
// nothing about it -- the only way to fix a line was to leave, edit the file and
// start again -- and it filed every proxy under All proxies whatever folder you
// were standing in. Both of those are the difference between a preview and a
// review, so this is a review: every field editable, a bad line fixable where it
// is reported, and the destination asked rather than assumed.
//
// Deliberately not merged with the profile importer (ImportProfilesModal.tsx).
// That one reads a structured CSV of profiles whose proxy is one column of
// twelve; this one reads a file that is nothing but proxies. What they share is
// in importParts.tsx, which is the right amount: the header, the stat tiles, the
// credential banner and the destination cards.
import {useEffect, useMemo, useState} from 'react';
import {
  ArrowLeft, ArrowRight, Download, FolderPlus, Globe, Layers, Link2, Network, Table2,
  TriangleAlert, Upload,
} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {Checkbox} from '../ui/Checkbox';
import {Field} from '../ui/Field';
import {FormGroup} from '../ui/FormGroup';
import {Modal} from '../ui/Modal';
import {PaginationBar} from '../ui/PaginationBar';
import {native} from '../../native';
import {paginate} from '../../lib/paginate';
import {
  defaultProxyName, parseProxyLink, proxyDedupeKey, proxyDedupeKeys, splitPastedConnection,
} from '../../lib/proxies';
import {parseProxyList} from '../../lib/proxyList';
import {proxyImportExampleCsv, proxyImportExampleList} from '../../data/importTemplate';
import {useAsyncAction} from '../../useAsyncAction';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import {
  CredentialBanner, DestinationCards, ImportDone, ImportHead, ImportStats, saveExampleFile,
} from './importParts';
import type {ImportOutcome} from './importParts';
import type {ClipboardEvent} from 'react';
import type {MontiProxy} from '../../types';

type Step = 'source' | 'review' | 'destination';
type DestinationKind = 'new' | 'existing' | 'unfiled';

// One line of the file as the dialog holds it: the parsed fields, editable, plus
// the two decisions the user can make about it. `raw` is kept so a line that
// could not be read has something to show and something to fix.
type ProxyRow = {
  id: string;
  line: number;
  raw: string;
  type: 'http' | 'socks5';
  // False when the type is only the parser's socks5 default, so the toolbar's
  // one-type-for-the-file selector knows which rows it may reassign.
  explicitType: boolean;
  address: string;
  username: string;
  password: string;
  name: string;
  skip: boolean;
};

// The parsed endpoint of a row, or null if the address is not one yet. Every
// derived question -- is this row importable, is it a duplicate, what does it
// dedupe as -- goes through here, so an edit and its consequences cannot drift.
function endpointOf(row: ProxyRow) {
  const parsed = parseProxyLink(row.address);
  return parsed ? {host: parsed.host, port: parsed.port} : null;
}

function rowsFromFile(content: string, existing: MontiProxy[]): ProxyRow[] {
  return parseProxyList(content, existing).map((entry) => ({
    id: String(entry.line),
    line: entry.line,
    raw: entry.raw,
    type: (entry.proxy?.type as 'http' | 'socks5') || 'socks5',
    explicitType: entry.explicitType,
    // An unreadable line keeps its raw text in the address field rather than
    // arriving empty: what the file actually said is what the user needs in
    // front of them to fix it.
    address: entry.proxy ? `${entry.proxy.host}:${entry.proxy.port}` : entry.raw,
    username: entry.proxy?.username || '',
    password: entry.proxy?.password || '',
    name: entry.proxy?.name || '',
    // A row already in the library starts skipped. It is still shown -- "8 new,
    // 2 already in your list" is worth saying -- but importing it again would
    // make a second row for a proxy the user already has.
    skip: entry.duplicate,
  }));
}

export function ImportProxiesModal({folderId, onClose}: {
  // The proxy folder the tab is standing in, offered as the default
  // destination. Adding proxies from inside a folder and finding them in All
  // proxies is the small daily annoyance this fixes.
  folderId?: string | null;
  onClose: () => void;
}) {
  const {data, toast, proxies, library} = useWorkspace();
  const {state} = data;
  const {run, isPending} = useAsyncAction();

  const [step, setStep] = useState<Step>('source');
  const [path, setPath] = useState('');
  const [rows, setRows] = useState<ProxyRow[]>([]);
  // Vendor lists are bare host:port:user:pass with no scheme, so the type is a
  // property of the file rather than of any line in it -- one selector for the
  // lot, and it leaves alone any row whose own line named a protocol.
  const [fileType, setFileType] = useState<'http' | 'socks5'>('socks5');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [destination, setDestination] = useState<{
    kind: DestinationKind;
    newName: string;
    existingId: string;
  }>({kind: 'unfiled', newName: '', existingId: ''});

  const proxyFolders = state.proxy_folders;

  // Same bargain as the other importers: the button that opens this dialog
  // raises the picker straight away, and cancelling leaves the dialog up with
  // its own Choose file button.
  useEffect(() => {
    void pickFile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickFile() {
    if (!native?.selectProxyFile) {
      toast.setMessage('Native file picker is not available. Restart Scout Web and try again.');
      return;
    }
    const picked = await native.selectProxyFile();
    if (!picked) {
      return;
    }
    const parsed = rowsFromFile(picked.content, state.proxies);
    if (!parsed.length) {
      toast.fail('Nothing to import',
          `${picked.path.split('/').pop()} has no proxy lines in it.`);
      return;
    }
    setPath(picked.path);
    setRows(parsed);
    setPage(0);
    setOutcome(null);
    setDestination({
      // Standing in a folder pre-selects it; standing in All proxies asks
      // nothing and leaves them unfiled.
      kind: folderId ? 'existing' : 'unfiled',
      newName: '',
      existingId: folderId || proxyFolders[0]?.id || '',
    });
    setStep('review');
  }

  function patchRow(id: string, patch: Partial<ProxyRow>) {
    setRows((current) => current.map((row) => row.id === id ? {...row, ...patch} : row));
  }

  // Duplicates, recomputed rather than stored: an edit to a row's address or
  // username changes what it collides with, and a badge that remembered the
  // file's original answer would be wrong the moment anything was typed.
  //
  // Against the library AND against this file's own earlier rows, so a list that
  // repeats a proxy shows the second one as the duplicate.
  const duplicates = useMemo(() => {
    const seen = new Set(state.proxies.flatMap(proxyDedupeKeys));
    const flags = new Map<string, boolean>();
    for (const row of rows) {
      const endpoint = endpointOf(row);
      if (!endpoint) {
        flags.set(row.id, false);
        continue;
      }
      const key = proxyDedupeKey(row.type, endpoint.host, endpoint.port, row.username);
      flags.set(row.id, seen.has(key));
      seen.add(key);
    }
    return flags;
  }, [rows, state.proxies]);

  const unreadable = rows.filter((row) => !endpointOf(row));
  const importable = rows.filter((row) => !row.skip && endpointOf(row));
  const duplicateCount = rows.filter((row) => duplicates.get(row.id)).length;
  // Rows with neither half of a login. The banner offers one answer for all of
  // them, which is what a vendor CSV with no password column needs.
  const credentialLess = importable.filter((row) => !row.username && !row.password);

  const view = paginate(rows, page, pageSize);

  function applyCredentials(username: string, password: string) {
    const wanted = new Set(credentialLess.map((row) => row.id));
    setRows((current) => current.map((row) =>
      wanted.has(row.id) ? {...row, username, password} : row));
    const count = wanted.size;
    toast.setMessage(`Applied credentials to ${count} ${count === 1 ? 'proxy' : 'proxies'}`);
  }

  async function commit() {
    let targetFolder: string | null = null;
    if (destination.kind === 'existing') {
      targetFolder = destination.existingId || null;
    }
    if (destination.kind === 'new') {
      const created = await library.createFolder({
        name: destination.newName.trim(),
        kind: 'proxy',
      });
      if (!created) {
        // createFolder has already said why. Stopping here rather than importing
        // into All proxies: the user asked for a folder, and quietly ignoring
        // that leaves them hunting for rows that are not where they asked.
        return;
      }
      targetFolder = created.id;
    }

    const entries = importable.map((row) => {
      const endpoint = endpointOf(row);
      return {
        type: row.type,
        host: endpoint?.host || '',
        port: endpoint?.port || 0,
        username: row.username || undefined,
        password: row.password || undefined,
        name: row.name || defaultProxyName(endpoint?.host || '', endpoint?.port || 0),
        folder_id: targetFolder,
      };
    });

    const result = await proxies.importList(entries);
    setOutcome({
      headline: [
        result.created &&
          `${result.created} ${result.created === 1 ? 'proxy' : 'proxies'} added`,
        destination.kind !== 'unfiled' && targetFolder &&
          `filed under ${proxyFolders.find((folder) => folder.id === targetFolder)?.name ||
            destination.newName.trim()}`,
      ].filter(Boolean).join(' · '),
      stats: [
        {label: 'Proxies added', value: result.created, icon: <Globe size={15} />},
        {label: 'Already in your list', value: duplicateCount, icon: <Link2 size={15} />},
        {label: 'Unreadable lines', value: unreadable.length, icon: <TriangleAlert size={15} />},
      ],
      // A partial write is not a success. importList keeps going after a failed
      // row, so some proxies did land -- which is exactly the case the amber
      // treatment exists for.
      partial: result.failed.length > 0,
      skipped: result.failed.map((failure) => ({name: failure.name, reason: failure.error})),
    });
    // The country column stays empty for a moment on purpose: the rows land
    // unchecked and useBackgroundProxyChecks fills in country, IP and ping a few
    // at a time, rather than firing one curl per proxy at import.
    toast.setMessage(result.failed.length ?
      `Imported ${result.created} · ${result.failed.length} failed · checking countries in the background` :
      `Imported ${result.created} ${result.created === 1 ? 'proxy' : 'proxies'} · checking countries in the background`);
  }

  const stepIndex = step === 'source' ? 0 : step === 'review' ? 1 : 2;
  const fileName = path.split('/').pop() || '';
  const destinationReady = destination.kind === 'new' ?
    Boolean(destination.newName.trim()) :
    destination.kind === 'existing' ? Boolean(destination.existingId) : true;

  if (outcome) {
    return (
      <Modal
        className="editor-modal import-panel"
        onClose={onClose}
        header={
          <ImportHead
            mark={<span className="import-mark"><Network size={18} /></span>}
            // The dialog still says what it IS. What HAPPENED is the hero
            // below, which is where the eye lands -- printing "Import
            // finished" in both places said one thing twice and named the
            // file nowhere.
            title="Import proxies"
            meta={fileName && <span>{fileName}</span>}
            actions={<button onClick={onClose}>Done</button>}
          />
        }
      >
        <div className="import-body">
          <ImportDone outcome={outcome} />
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
          mark={<span className="import-mark"><Network size={18} /></span>}
          title="Import proxies"
          steps={3}
          step={stepIndex}
          meta={
            <>
              <span>{
                step === 'source' ? 'Choose a file' :
                step === 'review' ? 'Check the lines' :
                'Choose a folder'
              }</span>
              {fileName && <span className="import-head-file">{fileName}</span>}
              {step !== 'source' && (
                <span className="import-head-count">
                  {importable.length} ready
                  {rows.length - importable.length > 0 &&
                    ` · ${rows.length - importable.length} skipped`}
                </span>
              )}
            </>
          }
          actions={
            <>
              {step === 'source' && <button className="ghost" onClick={onClose}>Cancel</button>}
              {step === 'review' && (
                <>
                  <button className="ghost" onClick={() => setStep('source')}>
                    <ArrowLeft size={16} /> Back
                  </button>
                  <button
                    disabled={!importable.length}
                    onClick={() => setStep('destination')}
                  >
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
                    busy={isPending('run-proxy-import')}
                    busyLabel="Importing…"
                    disabled={!importable.length || !destinationReady}
                    onClick={() => void run('run-proxy-import', commit)}
                  >
                    Import {importable.length} {importable.length === 1 ? 'proxy' : 'proxies'}
                  </BusyButton>
                </>
              )}
            </>
          }
        />
      }
    >
      <div className="import-body">
        {step === 'source' && (
          <SourceStep onPick={() => void pickFile()} say={toast.setMessage} path={path} />
        )}

        {step === 'review' && (
          <>
            <FormGroup
              title="What this file will do"
              icon={<Table2 size={14} />}
              hint="Counted from the lines below, and recounted as you edit them."
            >
              <div className="form-group-full">
                <ImportStats stats={[
                  {label: 'Ready to import', value: importable.length, icon: <Globe size={15} />},
                  {label: 'Already in your list', value: duplicateCount, icon: <Link2 size={15} />},
                  {label: 'Unreadable lines', value: unreadable.length,
                    icon: <TriangleAlert size={15} />},
                ]} />
              </div>
            </FormGroup>

            {credentialLess.length > 0 && (
              <CredentialBanner
                count={credentialLess.length}
                busy={false}
                onApply={applyCredentials}
              />
            )}

            <div className="import-review-toolbar">
              <label className="field inline-field">
                <span>Type</span>
                <select
                  value={fileType}
                  onChange={(event) => {
                    const next = event.target.value as 'http' | 'socks5';
                    setFileType(next);
                    // Only the rows whose own line said nothing about the
                    // protocol. A "socks5://" line, or a CSV with a type column,
                    // has already answered this question.
                    setRows((current) => current.map((row) =>
                      row.explicitType ? row : {...row, type: next}));
                  }}
                >
                  <option value="socks5">SOCKS5</option>
                  <option value="http">HTTP</option>
                </select>
              </label>
              {unreadable.length > 0 && (
                <span className="import-toolbar-note">
                  <TriangleAlert size={14} />
                  {unreadable.length} {unreadable.length === 1 ? 'line' : 'lines'} could not be
                  read — fix the address in the table, or leave them skipped.
                </span>
              )}
            </div>

            <div className="table-wrap import-review-table proxy-review-table">
              <table>
                <thead>
                  <tr>
                    <th className="checkbox-cell">Import</th>
                    <th className="import-state-cell" aria-label="Row state" />
                    <th className="th-value">Line</th>
                    <th className="th-value">Type</th>
                    <th className="th-value">Address</th>
                    <th className="th-value">Username</th>
                    <th className="th-value">Password</th>
                    <th className="th-value">Name</th>
                    <th className="th-value">State</th>
                  </tr>
                </thead>
                <tbody>
                  {view.items.map((row) => (
                    <ProxyReviewRow
                      key={row.id}
                      row={row}
                      duplicate={Boolean(duplicates.get(row.id))}
                      onPatch={(patch) => patchRow(row.id, patch)}
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
            />
          </>
        )}

        {step === 'destination' && (
          <FormGroup
            title="Folder"
            icon={<FolderPlus size={14} />}
            hint={`Where ${importable.length} ${importable.length === 1 ? 'proxy goes' : 'proxies go'}. Nothing has been created yet — including the folder.`}
          >
            <div className="form-group-full">
              <DestinationCards
                label="Proxy folder"
                value={destination.kind}
                onSelect={(kind) => setDestination((current) => ({...current, kind}))}
                options={[
                  {
                    kind: 'existing',
                    title: 'An existing folder',
                    body: proxyFolders.length ?
                      'Add them to a folder you already have' :
                      'You have no proxy folders yet',
                    disabled: !proxyFolders.length,
                  },
                  {
                    kind: 'new',
                    title: 'One new folder',
                    body: 'Everything in this import goes into a folder you name',
                  },
                  {
                    kind: 'unfiled',
                    title: 'No folder',
                    body: 'Leave them under All proxies',
                  },
                ]}
              />
            </div>

            {destination.kind === 'existing' && (
              <Field label="Folder" icon={<Layers size={14} />} wide>
                <select
                  value={destination.existingId}
                  onChange={(event) => setDestination((current) =>
                    ({...current, existingId: event.target.value}))}
                >
                  {proxyFolders.map((folder) => (
                    <option key={folder.id} value={folder.id}>{folder.name}</option>
                  ))}
                </select>
              </Field>
            )}

            {destination.kind === 'new' && (
              <Field
                label="Folder name"
                icon={<FolderPlus size={14} />}
                wide
                hint="Left empty on purpose — a folder name is a decision, not a default."
              >
                <input
                  autoFocus
                  value={destination.newName}
                  placeholder="e.g. Residential EU"
                  onChange={(event) => setDestination((current) =>
                    ({...current, newName: event.target.value}))}
                />
              </Field>
            )}
          </FormGroup>
        )}
      </div>
    </Modal>
  );
}

function SourceStep({onPick, say, path}: {
  onPick: () => void;
  say: (message: string) => void;
  path: string;
}) {
  return (
    <>
      <FormGroup
        title="The file"
        icon={<Network size={14} />}
        hint="Nothing is added until you have seen the lines and chosen a folder."
      >
        <div className="form-group-full">
          <p className="import-lead">
            One proxy per line, or a spreadsheet with a header row — both work, in any of
            the separators a vendor uses. Lines starting with <code>#</code> are ignored, and
            each proxy is named after its host and port unless the file gives it a name.
          </p>
          <div className="import-actions">
            <button className="ghost" onClick={onPick}>
              <Upload size={18} /> Choose proxy file
            </button>
            <button
              className="ghost"
              onClick={() => void saveExampleFile('monti-proxies-example.txt',
                  proxyImportExampleList(), say, native?.saveTextFile)}
            >
              <Download size={18} /> Example list
            </button>
            <button
              className="ghost"
              onClick={() => void saveExampleFile('monti-proxies-example.csv',
                  proxyImportExampleCsv(), say, native?.saveTextFile)}
            >
              <Download size={18} /> Example CSV
            </button>
            {path && <span className="import-file-label">{path.split('/').pop()}</span>}
          </div>
        </div>
      </FormGroup>

      <FormGroup
        title="Formats"
        icon={<Table2 size={14} />}
        hint="All of these read the same. The field order is what matters, not the separator."
      >
        <div className="form-group-full">
          {/* import-formats, not the two-column .import-columns the profile
              importer uses: a column NAME is a short word and fits a 182px
              gutter, while a connection string is thirty characters of
              monospace and ran straight through the description beside it. */}
          <dl className="import-columns import-formats">
            <div>
              <dt><code>host:port:username:password</code></dt>
              <dd>What most vendors hand out. Commas, semicolons, tabs and pipes work too.</dd>
            </div>
            <div>
              <dt><code>user:pass@host:port</code></dt>
              <dd>Either way round the @ falls — the side with the port is the endpoint.</dd>
            </div>
            <div>
              <dt><code>socks5://host:port</code></dt>
              <dd>A scheme in front sets that line&apos;s type, whatever the Type selector says.</dd>
            </div>
            <div>
              <dt><code>host,port,username,password</code> <em>with a header</em></dt>
              <dd>
                A first row naming its columns is read as one: <code>host</code>,
                {' '}<code>port</code>, <code>username</code>, <code>password</code>,
                {' '}<code>type</code> and <code>name</code>, in any order, and
                {' '}<code>ip</code>/<code>login</code>/<code>pass</code> mean the same.
              </dd>
            </div>
          </dl>
        </div>
      </FormGroup>
    </>
  );
}

function ProxyReviewRow({row, duplicate, onPatch}: {
  row: ProxyRow;
  duplicate: boolean;
  onPatch: (patch: Partial<ProxyRow>) => void;
}) {
  const endpoint = endpointOf(row);
  const badge = !endpoint ? 'Unreadable' : duplicate ? 'Already added' : 'New';

  // A pasted vendor line splits across all four fields rather than sitting in
  // whichever one it was dropped into -- the same splitPastedConnection the
  // proxy editor and the profile importer's proxy popover use.
  function onPaste(event: ClipboardEvent<HTMLInputElement>, strict: boolean) {
    const split = splitPastedConnection(event.clipboardData.getData('text'), {strict});
    if (!split) {
      return;
    }
    event.preventDefault();
    onPatch({
      address: `${split.host}:${split.port}`,
      // Only a line that actually carried a login touches the credential
      // fields; clearing them is what the fields themselves are for.
      ...(split.username || split.password ?
        {username: split.username || '', password: split.password || ''} :
        {}),
      // Only when the pasted line named a protocol. A bare host:port:user:pass
      // parses as socks5 by default, and letting that default overwrite the
      // selector would silently retype an HTTP proxy.
      ...(split.explicitType && split.type ?
        {type: split.type as 'http' | 'socks5', explicitType: true} :
        {}),
    });
  }

  return (
    <tr className={[
      row.skip ? 'row-skipped' : '',
      endpoint ? '' : 'row-blocked',
    ].filter(Boolean).join(' ')}
    >
      <td className="checkbox-cell">
        {/* An unreadable row reads as unticked, not as ticked-and-greyed. It is
            not importable, and a disabled tick says the opposite of that --
            `!row.skip` alone drew one, because a line nobody has skipped has
            skip: false whether or not it can be read. */}
        <Checkbox
          label={`Import line ${row.line}`}
          checked={!row.skip && Boolean(endpoint)}
          disabled={!endpoint}
          onChange={() => onPatch({skip: !row.skip})}
        />
      </td>
      <td className="import-state-cell">
        {!endpoint ?
          <i className="import-dot blocked" title="This line could not be read" /> :
          row.skip ?
            <i className="import-dot skipped" title="Skipped — not imported" /> :
            duplicate ?
              <i className="import-dot warned" title="Already in your list" /> :
              <i className="import-dot ok" title="Ready" />}
      </td>
      <td className="import-line-cell">{row.line}</td>
      <td>
        <select
          value={row.type}
          onChange={(event) => onPatch({
            type: event.target.value as 'http' | 'socks5',
            // Choosing by hand is as explicit as a scheme in the file, so the
            // toolbar's file-wide selector stops overwriting this row.
            explicitType: true,
          })}
        >
          <option value="socks5">SOCKS5</option>
          <option value="http">HTTP</option>
        </select>
      </td>
      <td>
        <input
          className={endpoint ? '' : 'invalid'}
          value={row.address}
          placeholder="198.51.100.10:1080"
          title={endpoint ? undefined : `Could not read: ${row.raw}`}
          onChange={(event) => onPatch({address: event.target.value})}
          // Not strict: whatever is pasted here was meant to be an address.
          onPaste={(event) => onPaste(event, false)}
        />
      </td>
      <td>
        <input
          autoComplete="off"
          value={row.username}
          placeholder="Optional"
          onChange={(event) => onPatch({username: event.target.value})}
          onPaste={(event) => onPaste(event, true)}
        />
      </td>
      <td>
        <input
          autoComplete="off"
          type="password"
          value={row.password}
          placeholder="Optional"
          onChange={(event) => onPatch({password: event.target.value})}
          onPaste={(event) => onPaste(event, true)}
        />
      </td>
      <td>
        <input
          value={row.name}
          placeholder={endpoint ? defaultProxyName(endpoint.host, endpoint.port) : 'From address'}
          onChange={(event) => onPatch({name: event.target.value})}
        />
      </td>
      <td className="import-check-cell">
        <span className={badge === 'New' ? 'proxy-badge assigned' : 'proxy-badge unassigned'}>
          {badge}
        </span>
      </td>
    </tr>
  );
}
