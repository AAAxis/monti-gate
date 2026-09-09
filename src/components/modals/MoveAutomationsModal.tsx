// "Move automations here" -- filling a folder from automations that already
// exist.
//
// MoveProfilesModal's twin, and it exists for a sharper reason than that one
// did. The three table tabs can also file things in bulk by ticking rows and
// using the Assign to folder dropdown; the automations grid has no selection
// model at all (see AutomationsTab's onShare). Without this, filing eight
// existing automations would mean opening eight editors.
import {useMemo, useState} from 'react';
import {FolderInput, SearchX} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {Checkbox} from '../ui/Checkbox';
import {Modal} from '../ui/Modal';
import {AutomationMark} from '../automations/AutomationMark';
import {FolderGlyph} from '../ui/FolderGlyph';
import {useAsyncAction} from '../../useAsyncAction';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ScoutFolder} from '../../types';

export function MoveAutomationsModal({folder, onClose}: {
  folder: ScoutFolder;
  onClose: () => void;
}) {
  const {data, toast, automations} = useWorkspace();
  const state = data.state;
  const {run, isPending} = useAsyncAction();

  // Everything not already here, and nothing in Trash -- filing a trashed
  // automation would put it in a folder listing it is not supposed to appear
  // in until it is restored.
  const candidates = useMemo(() => state.automations.filter((automation) =>
    !automation.deleted_at && automation.folder_id !== folder.id),
  [state.automations, folder.id]);

  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const query = search.trim().toLowerCase();
  const visible = query ?
    candidates.filter((automation) =>
      [automation.name, automation.description || '', ...(automation.tags || [])]
          .join(' ').toLowerCase().includes(query)) :
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
    if (!await automations.assignToFolder(picked, folder.id)) {
      return;
    }
    toast.setMessage(
        `${picked.length} ${picked.length === 1 ? 'automation' : 'automations'} ` +
        `moved to ${folder.name}`);
    onClose();
  }

  return (
    <Modal
      className="small-modal move-profiles-modal"
      onClose={onClose}
      title={`Move automations to ${folder.name}`}
      subtitle={'Pick automations that live elsewhere. A folder is filing only — ' +
        'steps, schedules and start-page pins are untouched.'}
      footer={
        <BusyButton
          busy={isPending('move-automations')}
          busyLabel="Moving…"
          disabled={!picked.length}
          icon={<FolderInput size={16} />}
          onClick={() => void run('move-automations', move)}
        >
          {picked.length ?
            `Move ${picked.length} ${picked.length === 1 ? 'automation' : 'automations'}` :
            'Move automations'}
        </BusyButton>
      }
    >
      {candidates.length > 0 && (
        <input
          type="text"
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search automations by name or tag"
          value={search}
        />
      )}
      <div className="move-profiles-list">
        {visible.map((automation) => {
          const from = state.automation_folders.find((item) => item.id === automation.folder_id);
          return (
            // Three columns, not the profile row's four: there is no status
            // chip here. The mark rides INSIDE the name cell rather than
            // taking a column of its own -- as its own child it would land in
            // the 1fr slot and shove the name into a max-content one.
            <label className="move-profiles-row move-automations-row" key={automation.id}>
              <Checkbox
                checked={picked.includes(automation.id)}
                onChange={() => toggle(automation.id)}
              />
              <span className="move-profiles-name">
                <AutomationMark icon={automation.icon} color={automation.color} size={20} />
                <span className="move-automations-label">{automation.name}</span>
              </span>
              <span className="move-profiles-from">
                <FolderGlyph color={from?.color} icon={from?.icon} size={13} small />
                {from?.name || 'All automations'}
              </span>
            </label>
          );
        })}
        {visible.length === 0 && (
          <p className="move-profiles-empty">
            <SearchX size={16} />
            {candidates.length ?
              'No automations match that search.' :
              'Every automation is already in this folder.'}
          </p>
        )}
      </div>
    </Modal>
  );
}
