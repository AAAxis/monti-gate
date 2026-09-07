// The cookie import dialog: pick one or more exported files, review what is in
// them, then say which folder and tags they get.
//
// There was no dialog here at all. "Add cookie-set" raised a native file picker
// and fired a toast, which meant the two questions worth asking about a cookie
// file -- is this the session I think it is, and is it still valid -- could only
// be answered after the set was already in the library, by opening it. A file
// full of cookies that expired last month looks exactly like a good one until
// you look inside, and the usual symptom is a profile that launches signed out.
//
// So the review step is the dialog: how many cookies, which domains, how many
// already expired, and whether the library already holds a set by that name.
// Nothing is uploaded until the last step.
import {useEffect, useMemo, useState} from 'react';
import {
  ArrowLeft, ArrowRight, Cookie, FolderPlus, Globe, ShieldAlert, Tags, Trash2, Upload,
} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {Field} from '../ui/Field';
import {FormGroup} from '../ui/FormGroup';
import {Modal} from '../ui/Modal';
import {TagInput} from '../ui/TagInput';
import {native} from '../../native';
import {cookieDomains, decodeCookieBase64, isCookieExpired, parseCookieContent} from '../../lib/cookieFile';
import {useAsyncAction} from '../../useAsyncAction';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import {
  DestinationCards, ImportDone, ImportHead, ImportStats,
} from './importParts';
import type {ImportOutcome} from './importParts';
import type {CookieFileSelection} from '../../native';

type Step = 'source' | 'review' | 'destination';
type DestinationKind = 'new' | 'existing' | 'unfiled';

// One picked file, read once. The parse happens at pick time rather than per
// render because it is the whole of what the review step shows, and re-decoding
// a megabyte of base64 on every keystroke in the folder name would be felt.
type CookieFileRow = {
  id: string;
  selection: CookieFileSelection;
  name: string;
  count: number;
  domains: string[];
  expired: number;
  // A set of this name already in the library. Not a blocker -- two exports of
  // the same site legitimately share a filename -- but it is the difference
  // between adding a set and thinking you replaced one.
  nameTaken: boolean;
  drop: boolean;
};

export function ImportCookiesModal({folderId, onClose}: {
  // The cookie folder the tab is standing in, offered as the default
  // destination so adding a set from inside a folder does not drop it into All.
  folderId?: string | null;
  onClose: () => void;
}) {
  const {data, toast, cookies, library, cookieTagOptions} = useWorkspace();
  const {state} = data;
  const {run, isPending} = useAsyncAction();

  const [step, setStep] = useState<Step>('source');
  const [rows, setRows] = useState<CookieFileRow[]>([]);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [destination, setDestination] = useState<{
    kind: DestinationKind;
    newName: string;
    existingId: string;
  }>({kind: 'unfiled', newName: '', existingId: ''});

  const cookieFolders = state.cookie_folders;

  // Same bargain as the other importers: the button that opens this dialog
  // raises the picker straight away, and cancelling leaves the dialog up with
  // its own Choose files button.
  useEffect(() => {
    void pickFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickFiles() {
    if (!native?.selectCookieFiles) {
      toast.setMessage('Native cookie file picker is not available. Restart Scout Web and try again.');
      return;
    }
    const picked = await native.selectCookieFiles();
    if (!picked?.length) {
      return;
    }
    const taken = new Set(state.cookies
        .filter((cookie) => !cookie.deleted_at)
        .map((cookie) => cookie.name.toLowerCase()));
    setRows(picked.map((selection, index) => {
      // The picker already counted the cookies; this re-parse is for the two
      // things a count cannot say -- which sites the set is for, and how much of
      // it is already dead.
      const entries = selection.base64 ?
        parseCookieContent(decodeCookieBase64(selection.base64)) :
        [];
      return {
        id: `${index}-${selection.path || selection.name}`,
        selection,
        name: selection.name || 'cookies.txt',
        count: entries.length || selection.count || 0,
        domains: cookieDomains(entries),
        expired: entries.filter(isCookieExpired).length,
        nameTaken: taken.has((selection.name || '').toLowerCase()),
        drop: false,
      };
    }));
    setOutcome(null);
    setDestination({
      kind: folderId ? 'existing' : 'unfiled',
      newName: '',
      existingId: folderId || cookieFolders[0]?.id || '',
    });
    setTags([]);
    setStep('review');
  }

  const keeping = rows.filter((row) => !row.drop);
  const totalCookies = keeping.reduce((sum, row) => sum + row.count, 0);
  const totalExpired = keeping.reduce((sum, row) => sum + row.expired, 0);
  const allDomains = useMemo(
      () => new Set(keeping.flatMap((row) => row.domains)).size, [keeping]);

  function patchRow(id: string, patch: Partial<CookieFileRow>) {
    setRows((current) => current.map((row) => row.id === id ? {...row, ...patch} : row));
  }

  async function commit() {
    let targetFolder: string | null = null;
    if (destination.kind === 'existing') {
      targetFolder = destination.existingId || null;
    }
    if (destination.kind === 'new') {
      const created = await library.createFolder({
        name: destination.newName.trim(),
        kind: 'cookie',
      });
      if (!created) {
        return;
      }
      targetFolder = created.id;
    }

    // One upload per file, sequentially. Each is a network round trip and a row
    // insert, and firing twenty at once at the storage bucket is how a folder
    // import turns into a partial one nobody can explain.
    let added = 0;
    const failed: Array<{name: string; reason: string}> = [];
    for (const row of keeping) {
      try {
        const entry = await cookies.addCookieSet(
            {...row.selection, name: row.name},
            {folderId: targetFolder, tags});
        if (entry) {
          added++;
        } else {
          failed.push({name: row.name, reason: 'The workspace refused the upload.'});
        }
      } catch (error) {
        failed.push({
          name: row.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    setOutcome({
      headline: [
        added && `${added} ${added === 1 ? 'set' : 'sets'} added`,
        totalCookies && `${totalCookies} cookies`,
        targetFolder && `filed under ${state.cookie_folders.find(
            (folder) => folder.id === targetFolder)?.name || destination.newName.trim()}`,
      ].filter(Boolean).join(' · '),
      stats: [
        {label: 'Sets added', value: added, icon: <Cookie size={15} />},
        {label: 'Cookies', value: totalCookies, icon: <Globe size={15} />},
        {label: 'Already expired', value: totalExpired, icon: <ShieldAlert size={15} />},
      ],
      partial: failed.length > 0,
      skipped: failed,
    });
    toast.setMessage(failed.length ?
      `Added ${added} of ${keeping.length} cookie-sets · ${failed.length} failed` :
      `Added ${added} ${added === 1 ? 'cookie-set' : 'cookie-sets'} to the library`);
  }

  const stepIndex = step === 'source' ? 0 : step === 'review' ? 1 : 2;
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
            mark={<span className="import-mark"><Cookie size={18} /></span>}
            // The dialog still says what it IS. What HAPPENED is the hero
            // below, which is where the eye lands -- printing "Import
            // finished" in both places said one thing twice and named the
            // file nowhere.
            title="Import cookies"
            // The other two name the file here. This import had several, so it
            // names the count instead -- an empty meta line still draws its
            // row, and the bar came out with a blank strip under the title.
            meta={<span>{keeping.length} {keeping.length === 1 ? 'set' : 'sets'}</span>}
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
      className="editor-modal import-panel"
      onClose={onClose}
      header={
        <ImportHead
          mark={<span className="import-mark"><Cookie size={18} /></span>}
          title="Import cookies"
          steps={3}
          step={stepIndex}
          meta={
            <>
              <span>{
                step === 'source' ? 'Choose files' :
                step === 'review' ? 'Check the sets' :
                'Choose a folder'
              }</span>
              {step !== 'source' && (
                <span className="import-head-count">
                  {keeping.length} {keeping.length === 1 ? 'set' : 'sets'} ·{' '}
                  {totalCookies} cookies
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
                  <button disabled={!keeping.length} onClick={() => setStep('destination')}>
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
                    busy={isPending('run-cookie-import')}
                    busyLabel="Uploading…"
                    disabled={!keeping.length || !destinationReady}
                    onClick={() => void run('run-cookie-import', commit)}
                  >
                    Import {keeping.length} {keeping.length === 1 ? 'set' : 'sets'}
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
          <FormGroup
            title="The files"
            icon={<Cookie size={14} />}
            hint="Nothing is uploaded until you have seen what is in them and chosen a folder."
          >
            <div className="form-group-full">
              <p className="import-lead">
                Cookie files exported as JSON or as Netscape <code>cookies.txt</code> — the two
                formats every cookie extension writes. Pick as many as you like at once; a folder
                of exported sessions goes in one pass.
              </p>
              <div className="import-actions">
                <button className="ghost" onClick={() => void pickFiles()}>
                  <Upload size={18} /> Choose cookie files
                </button>
              </div>
            </div>
          </FormGroup>
        )}

        {step === 'review' && (
          <>
            <FormGroup
              title="What these files hold"
              icon={<Cookie size={14} />}
              hint="Counted from the files themselves, not from what they are called."
            >
              <div className="form-group-full">
                <ImportStats stats={[
                  {label: 'Sets to add', value: keeping.length, icon: <Cookie size={15} />},
                  {label: 'Cookies', value: totalCookies, icon: <Globe size={15} />},
                  {label: 'Domains', value: allDomains, icon: <Globe size={15} />},
                  {label: 'Already expired', value: totalExpired, icon: <ShieldAlert size={15} />},
                ]} />
              </div>
            </FormGroup>

            {totalExpired > 0 && (
              <p className="import-warning-note">
                <ShieldAlert size={14} />
                {totalExpired} of these cookies have already expired. That is the usual reason a
                set launches signed out — it does not stop the import, but re-exporting the
                session is probably what you want.
              </p>
            )}

            <div className="table-wrap import-review-table cookie-review-table">
              <table>
                <thead>
                  <tr>
                    <th className="import-state-cell" aria-label="Row state" />
                    <th className="th-value">Name</th>
                    <th className="th-value">Cookies</th>
                    <th className="th-value">Domains</th>
                    <th className="th-value">Expired</th>
                    <th className="import-toggle-cell" aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className={row.drop ? 'row-skipped' : ''}>
                      <td className="import-state-cell">
                        {row.count === 0 ?
                          <i className="import-dot blocked" title="No cookies could be read from this file" /> :
                          row.expired ?
                            <i className="import-dot warned" title={`${row.expired} expired`} /> :
                            <i className="import-dot ok" title="Ready" />}
                      </td>
                      <td className="cookie-name-cell">
                        <input
                          value={row.name}
                          aria-label={`Name for ${row.selection.name}`}
                          // The library already holds one by this name. Said on
                          // the field that causes it, because renaming here is
                          // the fix and the field is where you would do it.
                          className={row.nameTaken ? 'warned' : ''}
                          title={row.nameTaken ?
                            'A cookie-set with this name is already in your library. This adds a second one.' :
                            row.selection.path}
                          onChange={(event) => patchRow(row.id, {name: event.target.value})}
                        />
                      </td>
                      <td className="import-count-cell">{row.count || <i>none</i>}</td>
                      <td className="cookie-domain-cell" title={row.domains.join(', ')}>
                        {row.domains.slice(0, 2).join(', ') || '—'}
                        {row.domains.length > 2 && ` +${row.domains.length - 2}`}
                      </td>
                      <td className="import-count-cell">
                        {row.expired ?
                          <span className="cookie-expired">{row.expired}</span> :
                          <i>—</i>}
                      </td>
                      <td className="import-toggle-cell">
                        <button
                          className="ghost icon-button row-action row-action-danger"
                          aria-label={row.drop ? `Keep ${row.name}` : `Leave out ${row.name}`}
                          title={row.drop ? 'Put this file back in the import' : 'Leave this file out'}
                          onClick={() => patchRow(row.id, {drop: !row.drop})}
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {step === 'destination' && (
          <>
            <FormGroup
              title="Folder"
              icon={<FolderPlus size={14} />}
              hint={`Where ${keeping.length} ${keeping.length === 1 ? 'set goes' : 'sets go'}. Nothing has been uploaded yet — including the folder.`}
            >
              <div className="form-group-full">
                <DestinationCards
                  label="Cookie folder"
                  value={destination.kind}
                  onSelect={(kind) => setDestination((current) => ({...current, kind}))}
                  options={[
                    {
                      kind: 'existing',
                      title: 'An existing folder',
                      body: cookieFolders.length ?
                        'Add them to a folder you already have' :
                        'You have no cookie folders yet',
                      disabled: !cookieFolders.length,
                    },
                    {
                      kind: 'new',
                      title: 'One new folder',
                      body: 'Everything in this import goes into a folder you name',
                    },
                    {
                      kind: 'unfiled',
                      title: 'No folder',
                      body: 'Leave them under All cookie-sets',
                    },
                  ]}
                />
              </div>

              {destination.kind === 'existing' && (
                <Field label="Folder" icon={<FolderPlus size={14} />} wide>
                  <select
                    value={destination.existingId}
                    onChange={(event) => setDestination((current) =>
                      ({...current, existingId: event.target.value}))}
                  >
                    {cookieFolders.map((folder) => (
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
                    placeholder="e.g. Facebook sessions"
                    onChange={(event) => setDestination((current) =>
                      ({...current, newName: event.target.value}))}
                  />
                </Field>
              )}
            </FormGroup>

            <FormGroup
              title="Tags"
              icon={<Tags size={14} />}
              hint="Applied to every set in this import. The same tags your profiles use."
            >
              {/* No Field wrapper: the section heading already says "Tags", and
                  a labelled field inside it printed the word twice, four lines
                  apart, for one control. */}
              <div className="form-group-full">
                <TagInput options={cookieTagOptions} value={tags} onChange={setTags} />
              </div>
            </FormGroup>
          </>
        )}
      </div>
    </Modal>
  );
}
