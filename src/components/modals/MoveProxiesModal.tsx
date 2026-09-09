// "Move proxies here" -- filling a proxy folder from proxies that already
// exist. The proxy-side twin of MoveProfilesModal, and reached the same two
// ways: from the empty state of a folder you are standing in, and straight
// after creating a folder from a country suggestion.
//
// Not a generalisation of the profiles dialog. The candidate rule differs
// (proxies have no trash to exclude), the rows show a flag, a connection and an
// assignment rather than a status, and the seed is a country rather than a tag
// -- a shared component would be a props union that reads worse than both.
import {useMemo, useState} from 'react';
import {FolderInput, SearchX} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {Checkbox} from '../ui/Checkbox';
import {Modal} from '../ui/Modal';
import {FolderGlyph} from '../ui/FolderGlyph';
import {FlagIcon} from '../ui/icons';
import {countryName} from '../../data/folderIcons';
import {isProxyAssigned, proxyCountryLabel, proxySearchText} from '../../lib/proxies';
import {useAsyncAction} from '../../useAsyncAction';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ScoutFolder} from '../../types';

export function MoveProxiesModal({folder, seedCountry, onClose}: {
  folder: ScoutFolder;
  // Set when the folder was just created from a country suggestion: that
  // country's proxies arrive ticked and the search is pointed at them, so the
  // whole flow is one more click. Still only a proposal -- nothing moves until
  // Move is pressed.
  seedCountry?: string;
  onClose: () => void;
}) {
  const {data, toast, proxies} = useWorkspace();
  const state = data.state;
  const {run, isPending} = useAsyncAction();

  const candidates = useMemo(() => state.proxies.filter((proxy) =>
    proxy.folder_id !== folder.id), [state.proxies, folder.id]);

  const seedName = seedCountry ? countryName(seedCountry) : '';
  const [search, setSearch] = useState(seedName);
  // Ticked by country code, not by the search: the search box only narrows what
  // is on screen, and a proxy merely *named* "us-resi-04" is not one the user
  // asked for.
  const [picked, setPicked] = useState<string[]>(() => (seedCountry ?
    candidates
        .filter((proxy) => proxy.country_code?.toUpperCase() === seedCountry.toUpperCase())
        .map((proxy) => proxy.id) :
    []));

  const query = search.trim().toLowerCase();
  // proxySearchText, not a haystack of its own: the seeded search is a country
  // *name* and half the check endpoints only ever store the code, so a filter
  // that did not resolve one to the other hid every proxy it had just ticked.
  const visible = query ?
    candidates.filter((proxy) => proxySearchText(proxy).includes(query)) :
    candidates;

  function toggle(id: string) {
    setPicked((current) => current.includes(id) ?
      current.filter((item) => item !== id) :
      [...current, id]);
  }

  async function move() {
    if (!picked.length) {
      return;
    }
    if (!await proxies.assignToFolder(picked, folder.id)) {
      return;
    }
    toast.setMessage(
        `${picked.length} ${picked.length === 1 ? 'proxy' : 'proxies'} moved to ${folder.name}`);
    onClose();
  }

  return (
    <Modal
      className="small-modal move-profiles-modal"
      onClose={onClose}
      title={`Move proxies to ${folder.name}`}
      subtitle={seedCountry ?
        `Every proxy checked into ${seedName} is already ticked. Untick anything that should stay where it is — a folder is filing only, so nothing changes about what a proxy connects to or which profile is using it.` :
        'Pick proxies that live elsewhere. A folder is filing only — nothing changes about what a proxy connects to or which profile is using it.'}
      footer={
        <BusyButton
          busy={isPending('move-proxies')}
          busyLabel="Moving…"
          disabled={!picked.length}
          icon={<FolderInput size={16} />}
          onClick={() => void run('move-proxies', move)}
        >
          {picked.length ?
            `Move ${picked.length} ${picked.length === 1 ? 'proxy' : 'proxies'}` :
            'Move proxies'}
        </BusyButton>
      }
    >
      {candidates.length > 0 && (
        <input
          type="text"
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search proxies by name, host, or country"
          value={search}
        />
      )}
      <div className="move-profiles-list">
        {visible.map((proxy) => {
          const from = state.proxy_folders.find((item) => item.id === proxy.folder_id);
          return (
            <label className="move-profiles-row move-proxies-row" key={proxy.id}>
              <Checkbox
                checked={picked.includes(proxy.id)}
                onChange={() => toggle(proxy.id)}
              />
              <span className="move-proxies-flag" title={proxyCountryLabel(proxy) || 'Country not checked'}>
                <FlagIcon countryCode={proxy.country_code} />
              </span>
              <span className="move-profiles-name">{proxy.name || proxy.host}</span>
              <span className={isProxyAssigned(proxy, state.profiles) ?
                'proxy-badge assigned' :
                'proxy-badge unassigned'}>
                {isProxyAssigned(proxy, state.profiles) ? 'Assigned' : 'Not assigned'}
              </span>
              <span className="move-profiles-from">
                <FolderGlyph color={from?.color} icon={from?.icon} size={13} small />
                {from?.name || 'All proxies'}
              </span>
            </label>
          );
        })}
        {visible.length === 0 && (
          <p className="move-profiles-empty">
            <SearchX size={16} />
            {candidates.length ?
              'No proxies match that search.' :
              'Every proxy is already in this folder.'}
          </p>
        )}
      </div>
    </Modal>
  );
}
