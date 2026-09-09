// "Move profiles here" -- filling a folder from profiles that already exist.
//
// Until now the only way into a new folder was to create a profile in it, or to
// select rows in the table and use the Assign to folder dropdown. Neither is
// reachable from the place the need actually arises: standing inside an empty
// folder, looking at the empty state.
import {useMemo, useState} from 'react';
import {FolderInput, SearchX} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {Checkbox} from '../ui/Checkbox';
import {Modal} from '../ui/Modal';
import {FolderGlyph} from '../ui/FolderGlyph';
import {StatusChip} from '../ui/StatusChip';
import {tagKey, tagLabel} from '../../lib/tags';
import {useAsyncAction} from '../../useAsyncAction';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ScoutFolder} from '../../types';

export function MoveProfilesModal({folder, seedTag, onClose}: {
  folder: ScoutFolder;
  // Set when the folder was just created from a tag suggestion: its profiles
  // arrive ticked and the search is pointed at them, so the whole flow is one
  // more click. Still only a proposal -- nothing moves until Move is pressed.
  seedTag?: string;
  onClose: () => void;
}) {
  const {data, toast, profiles} = useWorkspace();
  const state = data.state;
  const {run, isPending} = useAsyncAction();

  // Everything not already here, and not in the trash -- moving a deleted
  // profile into a folder would resurrect it in a listing it is not supposed
  // to appear in until it is restored.
  const candidates = useMemo(() => state.profiles.filter((profile) =>
    !profile.deleted_at && profile.folder_id !== folder.id), [state.profiles, folder.id]);

  const [search, setSearch] = useState(seedTag ? tagLabel(seedTag) : '');
  // Ticked by tag, not by the search: the search box only narrows what is on
  // screen, and a profile merely *named* "instagram-3" is not one the user
  // asked for.
  const [picked, setPicked] = useState<string[]>(() => (seedTag ?
    candidates.filter((profile) =>
      profile.tags?.some((tag) => tagKey(tag) === tagKey(seedTag))).map((profile) => profile.id) :
    []));

  const query = search.trim().toLowerCase();
  const visible = query ?
    candidates.filter((profile) =>
      [profile.name, ...(profile.tags || [])].join(' ').toLowerCase().includes(query)) :
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
    if (!await profiles.assignToFolder(picked, folder.id)) {
      return;
    }
    toast.setMessage(
        `${picked.length} ${picked.length === 1 ? 'profile' : 'profiles'} moved to ${folder.name}`);
    onClose();
  }

  return (
    <Modal
      className="small-modal move-profiles-modal"
      onClose={onClose}
      title={`Move profiles to ${folder.name}`}
      subtitle={seedTag ?
        `Everything tagged ${tagLabel(seedTag)} is already ticked. Untick anything that should stay where it is — profiles keep their fingerprint, proxy and cookies either way.` :
        'Pick profiles that live elsewhere. They keep their fingerprint, proxy and cookies — only the folder changes.'}
      footer={
        <BusyButton
          busy={isPending('move-profiles')}
          busyLabel="Moving…"
          disabled={!picked.length}
          icon={<FolderInput size={16} />}
          onClick={() => void run('move-profiles', move)}
        >
          {picked.length ?
            `Move ${picked.length} ${picked.length === 1 ? 'profile' : 'profiles'}` :
            'Move profiles'}
        </BusyButton>
      }
    >
      {candidates.length > 0 && (
        <input
          type="text"
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search profiles by name or tag"
          value={search}
        />
      )}
      <div className="move-profiles-list">
        {visible.map((profile) => {
          const from = state.folders.find((item) => item.id === profile.folder_id);
          return (
            <label className="move-profiles-row" key={profile.id}>
              <Checkbox
                checked={picked.includes(profile.id)}
                onChange={() => toggle(profile.id)}
              />
              <span className="move-profiles-name">{profile.name}</span>
              <StatusChip status={profile.status || 'Ready'} />
              <span className="move-profiles-from">
                <FolderGlyph color={from?.color} icon={from?.icon} size={13} small />
                {from?.name || 'All profiles'}
              </span>
            </label>
          );
        })}
        {visible.length === 0 && (
          <p className="move-profiles-empty">
            <SearchX size={16} />
            {candidates.length ?
              'No profiles match that search.' :
              'Every profile is already in this folder.'}
          </p>
        )}
      </div>
    </Modal>
  );
}
