// One username and password, written onto a batch of saved proxies.
//
// This exists because of a real failure mode rather than as a convenience. A CSV
// exported from another anti-detect tool names every proxy's host and port and
// none of their logins -- the exporting tool will not put credentials in a file.
// Imported as-is, every proxy fails its check with an authentication error and
// every profile using one is blocked from launching, and the only fix on offer
// was to open the editor for each proxy in turn and paste the same pair.
//
// Updating in place, rather than re-importing the file with credentials added, is
// the point: the proxies are already saved and the profiles already point at
// them. Re-importing would mint a second proxy per host (the username is part of
// the dedupe key) and leave those profiles on the original dead row.
import {useState} from 'react';
import {KeyRound} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {Field} from '../ui/Field';
import {Modal} from '../ui/Modal';
import {useAsyncAction} from '../../useAsyncAction';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ScoutProxy} from '../../types';

export function SetProxyCredentialsModal({targets, onClose, onDone}: {
  targets: ScoutProxy[];
  onClose: () => void;
  // Called only after at least one proxy was written, so the caller can clear
  // its selection without doing it on a failed save.
  onDone?: () => void;
}) {
  const {proxies} = useWorkspace();
  const {run, isPending} = useAsyncAction();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Either alone is enough to be worth writing: a few providers authenticate on
  // username only, and clearing one half deliberately is a legitimate edit.
  const ready = Boolean(username || password);
  const already = targets.filter((proxy) => proxy.username || proxy.password).length;

  async function apply() {
    const updated = await proxies.setCredentials(targets, username, password);
    if (updated) {
      onDone?.();
      onClose();
    }
  }

  return (
    <Modal
      title={`Set credentials on ${targets.length} ${targets.length === 1 ? 'proxy' : 'proxies'}`}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <BusyButton
            busy={isPending('set-credentials')}
            busyLabel="Saving…"
            disabled={!ready}
            icon={<KeyRound size={16} />}
            onClick={() => void run('set-credentials', apply)}
          >
            Apply
          </BusyButton>
        </>
      }
    >
      <p className="modal-lead">
        Applied to every selected proxy. Their last check is cleared, so run a check
        afterwards to confirm the login works.
      </p>

      {/* Said plainly rather than prevented: overwriting is often exactly the
          intent (a rotated provider password), but doing it to proxies that
          already had a working login by accident is worth a warning. */}
      {already > 0 && (
        <p className="field-hint warn">
          {already} of these already {already === 1 ? 'has' : 'have'} a login. Applying
          will replace {already === 1 ? 'it' : 'them'}.
        </p>
      )}

      <Field label="Username">
        <input
          autoComplete="off"
          onChange={(event) => setUsername(event.target.value)}
          placeholder="Provider username"
          value={username}
        />
      </Field>
      <Field label="Password">
        <input
          autoComplete="off"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Provider password"
          type="password"
          value={password}
        />
      </Field>
    </Modal>
  );
}
