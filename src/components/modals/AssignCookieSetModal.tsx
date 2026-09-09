// Which profiles launch with this cookie-set.
//
// A profile carries exactly one set (profiles.cookie_set_id), while a set may
// be used by any number of profiles -- so this dialog is one-to-many in the
// direction that has room for it, and the checkbox list IS the assignment: what
// is ticked when Assign is pressed is what ends up using the set, and unticking
// a profile that currently holds it takes its cookies away.
//
// The warning is the point of the whole screen. Ticking a profile that already
// carries a different set does not add to it, it replaces it -- which is a
// signed-out browser next launch if it was not what was meant.
import {useMemo, useState} from 'react';
import {AlertTriangle, SearchX, UserPlus} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {Checkbox} from '../ui/Checkbox';
import {Modal} from '../ui/Modal';
import {StatusChip} from '../ui/StatusChip';
import {useAsyncAction} from '../../useAsyncAction';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ScoutCookie} from '../../types';

export function AssignCookieSetModal({cookie, onClose}: {
  cookie: ScoutCookie;
  onClose: () => void;
}) {
  const {data, toast, cookies} = useWorkspace();
  const state = data.state;
  const {run, isPending} = useAsyncAction();

  // A trashed profile cannot launch, so assigning cookies to one would be a
  // change with nowhere to show up.
  const candidates = useMemo(
      () => state.profiles.filter((profile) => !profile.deleted_at),
      [state.profiles]);
  const alreadyUsing = useMemo(
      () => candidates.filter((profile) => profile.cookie_id === cookie.id).map((p) => p.id),
      [candidates, cookie.id]);

  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>(alreadyUsing);

  const query = search.trim().toLowerCase();
  const visible = query ?
    candidates.filter((profile) =>
      [profile.name, ...(profile.tags || [])].join(' ').toLowerCase().includes(query)) :
    candidates;

  // Ticked, carries a different set today. Counted across every candidate
  // rather than only the visible ones: a search that hides a row does not undo
  // what ticking it will do.
  const replacing = candidates.filter((profile) =>
    picked.includes(profile.id) && profile.cookie_id && profile.cookie_id !== cookie.id);
  const removing = alreadyUsing.filter((id) => !picked.includes(id));

  function toggle(id: string) {
    setPicked((current) => current.includes(id) ?
      current.filter((item) => item !== id) :
      [...current, id]);
  }

  function nameOfSet(id: string | null | undefined): string {
    return state.cookies.find((item) => item.id === id)?.name || 'another set';
  }

  async function assign() {
    if (!await cookies.assignToProfiles(cookie.id, picked)) {
      return;
    }
    const parts: string[] = [];
    if (picked.length) {
      parts.push(`${picked.length} ${picked.length === 1 ? 'profile' : 'profiles'} now use ` +
        `"${cookie.name}"`);
    }
    if (removing.length) {
      parts.push(`${removing.length} unassigned`);
    }
    toast.setMessage(parts.join(' · ') || 'Nothing changed');
    onClose();
  }

  return (
    <Modal
      className="small-modal move-profiles-modal"
      onClose={onClose}
      title={`Assign "${cookie.name}"`}
      subtitle={subtitle(replacing.length, removing.length)}
      footer={
        <BusyButton
          busy={isPending('assign-cookie-set')}
          busyLabel="Assigning…"
          icon={<UserPlus size={16} />}
          onClick={() => void run('assign-cookie-set', assign)}
        >
          Assign
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
          const ticked = picked.includes(profile.id);
          const willReplace = ticked && profile.cookie_id && profile.cookie_id !== cookie.id;
          return (
            <label className="move-profiles-row assign-cookies-row" key={profile.id}>
              <Checkbox checked={ticked} onChange={() => toggle(profile.id)} />
              <span className="move-profiles-name">{profile.name}</span>
              <StatusChip status={profile.status || 'Ready'} />
              {willReplace ? (
                <span className="assign-cookie-warn">
                  <AlertTriangle size={13} />
                  Replaces "{nameOfSet(profile.cookie_id)}"
                </span>
              ) : (
                <span className="move-profiles-from">
                  {profile.cookie_id === cookie.id ?
                    'Uses this set' :
                    profile.cookie_id ? nameOfSet(profile.cookie_id) : 'No cookies'}
                </span>
              )}
            </label>
          );
        })}
        {visible.length === 0 && (
          <p className="move-profiles-empty">
            <SearchX size={16} />
            {candidates.length ? 'No profiles match that search.' : 'There are no profiles yet.'}
          </p>
        )}
      </div>
    </Modal>
  );
}

// Says only what is actually about to happen. The list is the assignment, so
// the two destructive outcomes -- replacing a set and taking one away -- are
// the two that have to be readable before pressing Assign.
function subtitle(replacing: number, removing: number): string {
  const parts = ['A profile carries one cookie-set at a time. What is ticked here is what ends ' +
    'up using this one.'];
  if (replacing) {
    parts.push(`${replacing} ticked ${replacing === 1 ? 'profile' : 'profiles'} will be switched ` +
      'off another set.');
  }
  if (removing) {
    parts.push(`${removing} unticked ${removing === 1 ? 'profile' : 'profiles'} will lose ` +
      `${removing === 1 ? 'its' : 'their'} cookies.`);
  }
  return parts.join(' ');
}
