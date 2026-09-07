// Dialogs that add things to the shared library: the cookie-set picker, the
// extension adder, the proxy-list importer and the bookmark importer. The
// profile CSV importer used to live here too and now has its own file
// (ImportProfilesModal.tsx) -- it grew a review table and a destination step,
// which is more screen than the rest of this file put together.
import {useEffect, useState} from 'react';
import {Download, Upload} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {CookieSetLabel} from '../ui/CookieSetLabel';
import {Modal} from '../ui/Modal';
import {parseBookmarkFile} from '../../lib/bookmarkImport';
import {parseWebstoreExtensionId} from '../../lib/extensions';
import {native} from '../../native';
import {useAsyncAction} from '../../useAsyncAction';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ParsedBookmark} from '../../lib/bookmarkImport';
import type {MontiCookie} from '../../types';

export function CookiePickerModal({search, onSearch, selectedId, onSelect, onClose}: {
  search: string;
  onSearch: (value: string) => void;
  selectedId: string;
  onSelect: (cookie: MontiCookie) => void;
  onClose: () => void;
}) {
  const {data, toast, cookies} = useWorkspace();
  const {run, isPending} = useAsyncAction();
  const query = search.trim().toLowerCase();
  // Trashed sets are not offerable: assigning one would put a profile back on
  // cookies the user has already thrown away, and the launch path refuses to
  // resolve it anyway.
  const live = data.state.cookies.filter((cookie) => !cookie.deleted_at);
  const results = query ?
    live.filter((cookie) => cookie.name.toLowerCase().includes(query)) :
    live;

  async function upload() {
    if (!native?.selectCookieFile) {
      toast.setMessage('Native cookie file picker is not available. Restart Scout Web and try again.');
      return;
    }
    try {
      const selection = await native.selectCookieFile();
      if (!selection) {
        return;
      }
      const entry = await cookies.addCookieSet(selection);
      if (!entry) {
        return;
      }
      onSelect(entry);
      toast.setMessage(`Added "${entry.name}" to the cookie library`);
    } catch (error) {
      toast.setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Modal
      className="small-modal cookie-picker-modal"
      onClose={onClose}
      title="Select cookies"
      subtitle="Pick a saved cookie-set, or upload a new JSON/Netscape file to the library."
      footer={
        <>
          <BusyButton
            className="ghost"
            busy={isPending('pick-cookie-file')}
            busyLabel="Uploading…"
            onClick={() => void run('pick-cookie-file', upload)}
          >
            Upload new
          </BusyButton>
          <button type="button" onClick={onClose}>Save</button>
        </>
      }
    >
      <input
        type="text"
        placeholder="Search cookie-sets…"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
      />
      <div className="cookie-picker-list">
        {results.length === 0 && (
          <p className="empty-state">
            No saved cookie-sets{search.trim() ? ' match your search' : ' yet'}.
          </p>
        )}
        {results.map((cookie) => {
          const folder = data.state.cookie_folders.find((item) => item.id === cookie.folder_id);
          return (
            <button
              type="button"
              key={cookie.id}
              className={selectedId === cookie.id ? 'cookie-picker-row active' : 'cookie-picker-row'}
              onClick={() => onSelect(cookie)}
            >
              <CookieSetLabel cookie={cookie} folders={data.state.cookie_folders} />
              {/* The folder, because two sets called "cookies.txt" are only
                * telling apart by where they were filed. */}
              <small>
                {[folder?.name, cookie.count ? `${cookie.count} cookies` : '']
                    .filter(Boolean).join(' · ')}
              </small>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

export function ExtensionAddModal({onClose}: {onClose: () => void}) {
  const {toast, library} = useWorkspace();
  const [link, setLink] = useState('');
  const [name, setName] = useState('');

  async function addFromLink() {
    const webstoreId = parseWebstoreExtensionId(link);
    if (!webstoreId) {
      toast.setMessage('That doesn\'t look like a Chrome Web Store link or extension id.');
      return;
    }
    if (await library.addExtensionFromWebStore(webstoreId, name)) {
      onClose();
    }
  }

  const submitOnEnter = (event: {key: string}) => {
    if (event.key === 'Enter' && link.trim()) {
      void addFromLink();
    }
  };

  return (
    <Modal
      className="small-modal extension-add-modal"
      onClose={onClose}
      title="Add from link"
      subtitle="Share a Chrome Web Store extension with the workspace."
    >
      <section className="extension-add-section">
        <label className="field wide">
          <span>Chrome Web Store link or extension ID</span>
          <input
            autoFocus
            type="text"
            placeholder="https://chromewebstore.google.com/detail/..."
            value={link}
            onChange={(event) => setLink(event.target.value)}
            onKeyDown={submitOnEnter}
          />
        </label>
        <label className="field wide">
          <span>Name (optional)</span>
          <input
            type="text"
            placeholder="Defaults to the extension id"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={submitOnEnter}
          />
        </label>
        {/* Link only -- "Add from folder" is its own button on the tab now,
            going straight to the OS picker with no dialog in between. */}
        <div className="extension-add-actions">
          <button disabled={!link.trim()} onClick={() => void addFromLink()}>
            Add from link
          </button>
        </div>
      </section>
    </Modal>
  );
}

// The file the "Download example" buttons write is not a starting point the
// user then has to correct: each one round-trips through its own importer
// unchanged, which is the only way to make "here is the format" verifiable
// rather than a claim.
//
// Shared by the importers in this file because the saving is the same either
// way: the native picker when the app is packaged, and an anchor when this is
// running in a browser tab during development. The profile importer has its own
// copy rather than importing this one, so this file is free to be about the
// library dialogs alone.
async function saveExample(
    fileName: string, content: string, mime: string, say: (message: string) => void) {
  const kind = fileName.endsWith('.csv') ? 'CSV' : 'list';
  if (native?.saveTextFile) {
    const savedPath = await native.saveTextFile(fileName, content);
    if (savedPath) {
      say(`Saved example ${kind} to ${savedPath.split('/').pop()}`);
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([content], {type: mime}));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  say(`Downloaded example ${kind}`);
}

// Bulk-adds bookmarks from a browser's exported HTML file. Pick a file, see
// what is in it, confirm -- because the failure the user needs to see is which
// rows are new and which are already here.
//
// The proxy importer used to sit above this and be its twin. It moved to
// ImportProxiesModal.tsx when it grew a review table and a destination step;
// this one stays here because one screen is genuinely all a bookmark file
// needs -- there is nothing about a bookmark to review.
export function BookmarkImportModal({onClose}: {onClose: () => void}) {
  const {data, toast, library} = useWorkspace();
  const [file, setFile] = useState<{path: string; entries: ParsedBookmark[]} | null>(null);
  const {run, isPending} = useAsyncAction();

  // Same bargain as the other importers: the button that opens this dialog
  // raises the picker straight away, and cancelling leaves the dialog up with
  // its own Choose file button.
  useEffect(() => {
    void pickFile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickFile() {
    if (!native?.selectBookmarkFile) {
      toast.setMessage('Native file picker is not available. Restart Scout Web and try again.');
      return;
    }
    const picked = await native.selectBookmarkFile();
    if (!picked) {
      return;
    }
    setFile({
      path: picked.path,
      entries: parseBookmarkFile(picked.content, data.state.shared_bookmarks),
    });
  }

  const importable = file?.entries.filter((entry) => !entry.duplicate) || [];
  const duplicates = file?.entries.filter((entry) => entry.duplicate).length || 0;

  async function runImport() {
    if (!importable.length) {
      return;
    }
    const created = await library.importBookmarks(importable.map((entry) => ({
      title: entry.title,
      url: entry.url,
      icon: entry.icon,
    })));
    if (!created) {
      return;
    }
    toast.setMessage(`Imported ${created} bookmark${created === 1 ? '' : 's'}`);
    onClose();
  }

  return (
    <Modal
      className="import-panel proxy-import-panel"
      onClose={onClose}
      title="Import bookmarks"
      subtitle={
        <>
          In Chrome, open <code>chrome://bookmarks</code> → ⋮ → <b>Export bookmarks</b>, then
          choose that file here. Edge, Firefox, Safari and Brave all export the same format.
          Folders are flattened — shared bookmarks are one list — and anything already in your
          workspace is skipped.
        </>
      }
    >
      <div className="import-actions">
        <button className="ghost" onClick={() => void pickFile()}>
          <Upload size={18} /> Choose bookmarks file
        </button>
        {file && (
          <span className="import-file-label">
            {file.path.split('/').pop()} — {file.entries.length}{' '}
            bookmark{file.entries.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {file && (
        <>
          <div className="import-summary">
            <div className="summary-item"><span>Ready to import</span><strong>{importable.length}</strong></div>
            <div className="summary-item"><span>Already in your list</span><strong>{duplicates}</strong></div>
          </div>
          <div className="proxy-import-preview">
            {file.entries.map((entry, index) => (
              <div className="proxy-import-row" key={`${entry.url}-${index}`}>
                <span className="proxy-import-line">{entry.folder || '—'}</span>
                <span className="proxy-import-target" title={entry.url}>{entry.title}</span>
                <span className={entry.duplicate ? 'proxy-badge unassigned' : 'proxy-badge assigned'}>
                  {entry.duplicate ? 'Already added' : 'New'}
                </span>
              </div>
            ))}
          </div>
          <BusyButton
            busy={isPending('run-bookmark-import')}
            busyLabel="Importing…"
            disabled={!importable.length}
            onClick={() => void run('run-bookmark-import', runImport)}
          >
            Import {importable.length} bookmark{importable.length === 1 ? '' : 's'}
          </BusyButton>
        </>
      )}
    </Modal>
  );
}

