// "Move cookie-sets here" -- filling a cookie folder from sets that already
// exist. The profiles-side twin of MoveProfilesModal, down to the class names;
// the only differences are which library it reads and that a cookie folder is
// never suggested from anything, so there is no seed to pre-tick.
import {useMemo, useState} from 'react';
import {FolderInput, SearchX} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {Checkbox} from '../ui/Checkbox';
import {Modal} from '../ui/Modal';
import {FolderGlyph} from '../ui/FolderGlyph';
import {TagCell} from '../ui/TagChip';
import {useAsyncAction} from '../../useAsyncAction';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ScoutFolder} from '../../types';

export function MoveCookieSetsModal({folder, onClose}: {
  folder: ScoutFolder;
  onClose: () => void;
}) {
  const {data, toast, cookies} = useWorkspace();
  const state = data.state;
  const {run, isPending} = useAsyncAction();

  // Everything not already here, and not in the trash -- filing a trashed set
  // into a folder would list it somewhere it is not supposed to appear until it
  // is restored.
  const candidates = useMemo(() => state.cookies.filter((cookie) =>
    !cookie.deleted_at && cookie.folder_id !== folder.id), [state.cookies, folder.id]);

  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const query = search.trim().toLowerCase();
  const visible = query ?
    candidates.filter((cookie) =>
      [cookie.name, ...(cookie.tags || [])].join(' ').toLowerCase().includes(query)) :
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
    if (!await cookies.assignToFolder(picked, folder.id)) {
      return;
    }
    toast.setMessage(
        `${picked.length} cookie-${picked.length === 1 ? 'set' : 'sets'} moved to ${folder.name}`);
    onClose();
  }

  return (
    <Modal
      className="small-modal move-profiles-modal"
      onClose={onClose}
      title={`Move cookie-sets to ${folder.name}`}
      subtitle={'Pick cookie-sets that live elsewhere. Only the folder changes — whichever ' +
        'profiles are using them keep using them.'}
      footer={
        <BusyButton
          busy={isPending('move-cookie-sets')}
          busyLabel="Moving…"
          disabled={!picked.length}
          icon={<FolderInput size={16} />}
          onClick={() => void run('move-cookie-sets', move)}
        >
          {picked.length ?
            `Move ${picked.length} cookie-${picked.length === 1 ? 'set' : 'sets'}` :
            'Move cookie-sets'}
        </BusyButton>
      }
    >
      {candidates.length > 0 && (
        <input
          type="text"
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search cookie-sets by name or tag"
          value={search}
        />
      )}
      <div className="move-profiles-list">
        {visible.map((cookie) => {
          const from = state.cookie_folders.find((item) => item.id === cookie.folder_id);
          return (
            <label className="move-profiles-row" key={cookie.id}>
              <Checkbox
                checked={picked.includes(cookie.id)}
                onChange={() => toggle(cookie.id)}
              />
              <span className="move-profiles-name">{cookie.name}</span>
              <TagCell tags={cookie.tags} />
              <span className="move-profiles-from">
                <FolderGlyph color={from?.color} icon={from?.icon} size={13} small />
                {from?.name || 'All cookie-sets'}
              </span>
            </label>
          );
        })}
        {visible.length === 0 && (
          <p className="move-profiles-empty">
            <SearchX size={16} />
            {candidates.length ?
              'No cookie-sets match that search.' :
              'Every cookie-set is already in this folder.'}
          </p>
        )}
      </div>
    </Modal>
  );
}
