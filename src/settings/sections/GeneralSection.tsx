// General: the handful of things that belong to this computer rather than to
// the account or the workspace.
import {useEffect, useState} from 'react';
import {BookOpen, Copy} from 'lucide-react';
import {profilesRoot} from '../../lib/homePage';
import {native} from '../../native';
import type {LoginItemState} from '../../native';
import {SettingsGroup, SettingsRow} from '../rows';

type Props = {
  onMessage: (text: string) => void;
  onOpenIntro: () => void;
  // Where the managed Scout Web Browser build is installed -- shown beside the
  // profile data folder because both answer "where does this app keep its
  // things on this machine". Empty until a build has been installed.
  browserPath: string;
};

export function GeneralSection({onMessage, onOpenIntro, browserPath}: Props) {
  // The root as the renderer states it; the main process turns it into the
  // absolute path a launch actually uses.
  const root = profilesRoot();
  const [loginItem, setLoginItem] = useState<LoginItemState | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [dataPath, setDataPath] = useState<{path: string; exists: boolean} | null>(null);

  useEffect(() => {
    let cancelled = false;
    void native?.getLoginItem?.().then((state) => {
      if (!cancelled && state) {
        setLoginItem(state);
      }
    });
    void native?.resolveProfileRoot?.(root).then((result) => {
      if (!cancelled && result) {
        setDataPath(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [root]);

  async function toggleLoginItem(enabled: boolean) {
    setLoginBusy(true);
    try {
      const state = await native?.setLoginItem?.(enabled);
      // The OS is asked what it ended up with rather than assuming the write
      // took -- a managed Mac can refuse it.
      if (state) {
        setLoginItem(state);
        if (state.openAtLogin !== enabled) {
          onMessage('macOS did not accept that change. Check Login Items in System Settings.');
        }
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoginBusy(false);
    }
  }

  async function copyDiagnostics() {
    const lines = [
      `Platform: ${navigator.platform}`,
      `Profile data: ${dataPath?.path || root}${dataPath && !dataPath.exists ? ' (not created yet)' : ''}`,
      `Launch at login: ${loginItem?.openAtLogin ? 'on' : 'off'}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      onMessage('Diagnostics copied');
    } catch {
      onMessage('Could not copy to the clipboard.');
    }
  }

  const loginDisabled = loginBusy || !loginItem || !loginItem.packaged;

  return (
    <>
      <SettingsGroup title="Startup">
        <SettingsRow
          label="Open at login"
          description={loginItem && !loginItem.packaged ?
            'Unavailable in a development run — the entry would point at Electron, not at Scout Web.' :
            'Start Scout Web when you sign in to this computer.'}
        >
          <label className="switch" aria-label="Open Scout Web at login">
            <input
              checked={Boolean(loginItem?.openAtLogin)}
              disabled={loginDisabled}
              onChange={(event) => void toggleLoginItem(event.target.checked)}
              type="checkbox"
            />
            <span className="switch-track"><span className="switch-thumb" /></span>
          </label>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Data">
        <SettingsRow
          label="Profile data folder"
          description="Cookies, history and logged-in sessions for every profile live here. One folder per profile, named by its id."
          wide
        >
          <div className="settings-path">
            <code title={dataPath?.path || ''}>{dataPath?.path || root}</code>
          </div>
          {dataPath && !dataPath.exists && (
            <p className="settings-hint">This folder appears when you first launch a profile.</p>
          )}
        </SettingsRow>
        <SettingsRow
          label="Browser location"
          description="The managed Scout Web Browser build that profiles launch into."
          wide
        >
          <div className="settings-path">
            <code title={browserPath}>{browserPath || 'Not installed yet'}</code>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Support">
        <SettingsRow
          label="Profiles walkthrough"
          description="The three screens explaining what a profile is. Shown once on a workspace with no profiles yet."
        >
          <button className="ghost" onClick={onOpenIntro} type="button">
            <BookOpen size={15} /> Replay
          </button>
        </SettingsRow>
        <SettingsRow
          label="Diagnostics"
          description="Copies your platform, data folder and startup setting, to paste into a support request."
        >
          <button className="ghost" onClick={() => void copyDiagnostics()} type="button">
            <Copy size={15} /> Copy
          </button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
