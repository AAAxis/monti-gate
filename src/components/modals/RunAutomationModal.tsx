// Which profiles an automation runs on, and whether they can.
//
// This dialog exists because Run used to answer the first question by guessing
// -- runTarget() took the single attached profile, or whatever row happened to
// be highlighted on the Profiles tab -- and never asked the second at all. The
// first sign that the guess had picked a profile with a dead proxy was the main
// process refusing the spawn several seconds later:
//
//   Proxy 204.252.87.159:47403 did not respond (curl: (7) Failed to connect).
//   Fix the proxy in Scout Web Launcher and try again.
//
// A sentence about a profile the user never chose, arriving after the run was
// already lost. So the choice is explicit, the health is on screen before the
// commit, and a profile that cannot run cannot be ticked.
//
// The proxy chip is the table's chip (ProxyCheckCell) and the sweep is the
// library's sweep (proxies.checkMany), so a result seen here is the same result
// the Proxies tab shows, recorded the same way -- not a second opinion this
// dialog forms and forgets.
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Play, SearchX, ShieldAlert, ShieldCheck, Wrench} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {Checkbox} from '../ui/Checkbox';
import {Modal} from '../ui/Modal';
import {ProfileAvatar} from '../ui/ProfileAvatar';
import {ProxyCheckCell, storedCheckState} from '../ui/ProxyCheckCell';
import {StatusChip} from '../ui/StatusChip';
import {RUN_CONCURRENCY} from '../../automations/limit';
import {
  describeMissingParams, resolveRunVars, valuesToStrings,
} from '../../automations/parameters';
import {ParamValueFields} from '../automations/ParamValueFields';
import {isRunnable, proxiesToCheck, runReadiness} from '../../automations/runReadiness';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {RunReadiness} from '../../automations/runReadiness';
import type {ScoutAutomation, ScoutProfile, ScoutProxy} from '../../types';

// Why a profile cannot be ticked, or null when it can. Live-session state
// (a run already in flight) is folded in here rather than in runReadiness,
// which is pure and knows nothing about what is currently running.
type Block = 'failed' | 'missing' | 'running' | null;

export function RunAutomationModal({automation, nested = false, onFixProxy, onClose}: {
  automation: ScoutAutomation;
  // True when this opened over the automation editor's own Run button, which
  // leaves that dialog standing underneath.
  nested?: boolean;
  // Closes this dialog and opens that proxy's editor. Handed up rather than
  // opened here because the proxy editor is App's to own -- it is reachable
  // from three other places and none of them stack it inside another dialog.
  onFixProxy: (proxy: ScoutProxy) => void;
  onClose: () => void;
}) {
  const {data, automations, profiles, proxies, selectedProfileId, checkingProxyIds} =
    useWorkspace();
  const state = data.state;

  // A trashed profile cannot launch, so it is not a candidate -- offering one
  // would be a run that fails for a reason this screen never mentioned.
  const candidates = useMemo(
      () => state.profiles.filter((profile) => !profile.deleted_at),
      [state.profiles]);

  // Profiles the runner would refuse a second run for: runner.cjs answers 409
  // "That profile already has a run in flight". Reading it off this session's
  // runs rather than asking the main process, because that is what the card
  // badges already read and the two must not say different things.
  const running = useMemo(() => new Set(
      Object.values(automations.runs)
          .filter((run) => run.status === 'running' && run.profile_id)
          .map((run) => run.profile_id as string)),
  [automations.runs]);

  // Recomputed every render on purpose: a check landing rewrites the proxy row
  // in workspace state, and that is exactly when a row's verdict has to change.
  const readiness = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, RunReadiness>();
    for (const profile of candidates) {
      map.set(profile.id, runReadiness(profile, state.proxies, now));
    }
    return map;
    // state.proxies is the dependency that matters -- see above.
  }, [candidates, state.proxies]);

  const parameters = useMemo(() => automation.parameters || [], [automation.parameters]);

  // Per-profile answers for THIS run, seeded from what each profile already
  // holds. Filled rather than empty, because the point of the row is to show
  // what this profile is about to run with -- an empty box beside a ticked
  // profile answers a different question.
  //
  // Consequence worth naming: emptying a box the profile had filled falls back
  // to the profile's own value rather than to the automation's default, because
  // resolveRunVars treats a blank override as "not supplied" and the profile
  // layer is still underneath. Typing a different value -- the thing this
  // dialog is for -- behaves exactly as it looks.
  const [overrides, setOverrides] = useState<Record<string, Record<string, string>>>(() => {
    const seeded: Record<string, Record<string, string>> = {};
    for (const profile of candidates) {
      seeded[profile.id] = valuesToStrings(profile.automation_vars?.[automation.id]);
    }
    return seeded;
  });
  const [saveToProfiles, setSaveToProfiles] = useState(false);

  // What this profile would actually run with. The same call run() makes, with
  // the same inputs, so the dialog and the run cannot disagree about whether a
  // required value is answered.
  const varsFor = useCallback((profile: ScoutProfile) => resolveRunVars({
    parameters,
    profileValues: profile.automation_vars?.[automation.id],
    overrides: overrides[profile.id],
  }), [parameters, automation.id, overrides]);

  // Deliberately NOT part of blockFor, which disables the checkbox. The values
  // are edited on the row itself, and the row's form only appears once it is
  // ticked -- so blocking the tick would hide the only place the problem can be
  // fixed. This blocks the Run BUTTON instead, and the row says which value.
  const missingFor = useCallback(
      (profile: ScoutProfile) => describeMissingParams(parameters, varsFor(profile)),
      [parameters, varsFor]);

  function blockFor(profile: ScoutProfile): Block {
    if (running.has(profile.id)) {
      return 'running';
    }
    const value = readiness.get(profile.id);
    if (!value || isRunnable(value)) {
      return null;
    }
    return value.kind === 'missing' ? 'missing' : 'failed';
  }

  const [search, setSearch] = useState('');
  const [sweeping, setSweeping] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => {
    // Attached first: an automation wired to three profiles is an automation
    // whose author has already said which ones. Otherwise the highlighted row,
    // which is what the old Run button used and is still the best single guess
    // -- the difference is that now it is a proposal on screen, not a decision.
    const attached = candidates.filter((profile) => profile.automation_id === automation.id);
    const seed = attached.length ? attached : candidates.filter(
        (profile) => profile.id === selectedProfileId);
    return new Set(seed.map((profile) => profile.id));
  });

  // The opening sweep: freshen anything unchecked, stale or previously failed
  // before the user reads the list. Quiet, because they did not ask for it --
  // the per-row chips report it, and a summary toast about work nobody
  // requested lands while they are still reading.
  const swept = useRef(false);
  useEffect(() => {
    if (swept.current) {
      return;
    }
    swept.current = true;
    const stale = proxiesToCheck(candidates, state.proxies);
    if (!stale.length) {
      return;
    }
    let live = true;
    setSweeping(true);
    void proxies.checkMany(stale, {quiet: true}).finally(() => {
      // The results are recorded either way -- checkMany writes them to the
      // proxy rows, and a check that outlives its dialog still belongs on the
      // row. Only this component's own flag needs the guard.
      if (live) {
        setSweeping(false);
      }
    });
    return () => {
      live = false;
    };
    // Deliberately once, on open. candidates/state.proxies change as results
    // land, and re-running on those would sweep forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A profile ticked while its proxy was merely unchecked, and blocked once the
  // check came back, must not stay ticked -- the footer count would promise a
  // run the Run button then refuses to start.
  useEffect(() => {
    setPicked((current) => {
      const next = new Set(current);
      for (const profile of candidates) {
        if (next.has(profile.id) && blockFor(profile)) {
          next.delete(profile.id);
        }
      }
      return next.size === current.size ? current : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readiness, running]);

  const query = search.trim().toLowerCase();
  const visible = query ?
    candidates.filter((profile) =>
      [profile.name, ...(profile.tags || [])].join(' ').toLowerCase().includes(query)) :
    candidates;
  const selectable = visible.filter((profile) => !blockFor(profile));
  const allSelected = selectable.length > 0 &&
    selectable.every((profile) => picked.has(profile.id));

  const blocked = candidates.filter((profile) => blockFor(profile));
  const chosen = candidates.filter((profile) => picked.has(profile.id));
  // Ticked, but not answerable yet. One sentence for the Run button's title,
  // naming the profiles rather than counting them -- with three rows on screen
  // "2 profiles need values" makes you check all three.
  const unanswered = chosen.filter((profile) => missingFor(profile));
  const unansweredNote = unanswered.length === 0 ? '' :
    unanswered.length === 1 ?
      `${unanswered[0].name} ${missingFor(unanswered[0])}.` :
      `${unanswered.map((profile) => profile.name).join(', ')} need values.`;

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }

  // Ticks only what is visible and runnable, so a search that hides a row also
  // keeps this from silently ticking it, and a blocked row is never swept in.
  function toggleAll() {
    setPicked((current) => {
      const next = new Set(current);
      selectable.forEach((profile) =>
        allSelected ? next.delete(profile.id) : next.add(profile.id));
      return next;
    });
  }

  // Re-checks what is on screen regardless of freshness. Unlike the opening
  // sweep this one is asked for, so it keeps checkMany's summary.
  function recheck() {
    const rows = new Map<string, ScoutProxy>();
    for (const profile of visible) {
      const value = readiness.get(profile.id);
      if (value && 'proxy' in value) {
        rows.set(value.proxy.id, value.proxy);
      }
    }
    void proxies.checkMany([...rows.values()]);
  }

  function start() {
    if (!chosen.length || unanswered.length) {
      return;
    }
    // Written back before the run starts, and only when asked. Off by default
    // because a value typed for one run is usually for one run -- silently
    // rewriting the profile would make "try Essen once" permanent.
    if (saveToProfiles && parameters.length > 0) {
      for (const profile of chosen) {
        void profiles.update(profile, {
          automation_vars: {
            ...profile.automation_vars,
            [automation.id]: droppingBlanks(overrides[profile.id] || {}),
          },
        });
      }
    }
    // Not awaited, and the dialog closes: a batch is minutes long, and holding
    // this open would hide the cards and the history that report it. runMany
    // owns the pacing, the summary and the failures from here.
    void automations.runMany(automation, chosen, {varsByProfile: overrides});
    onClose();
  }

  return (
    <Modal
      // Not `small-modal`: that caps at 520px, which is the width this row
      // does not fit in. A dialog that needs its own measure names itself and
      // sets it, the way import-panel does.
      className="move-profiles-modal run-automation-modal"
      nested={nested}
      onClose={onClose}
      title={`Run "${automation.name}"`}
      subtitle={subtitle(chosen.length, blocked.length, sweeping)}
      footer={
        <>
          <button className="ghost" onClick={recheck} disabled={sweeping || !visible.length}>
            <ShieldCheck size={16} /> Re-check proxies
          </button>
          {/* The title sits on a wrapper span, not on the button: Chromium
              suppresses pointer events on a disabled control, so a title on the
              button itself never appears at the one moment it is needed. Same
              reason the card's Run button wraps its own. */}
          <span title={unansweredNote || undefined}>
            <BusyButton
              busy={sweeping}
              busyLabel="Checking proxies…"
              disabled={!chosen.length || unanswered.length > 0}
              icon={<Play size={16} />}
              onClick={start}
            >
              {chosen.length ?
                `Run on ${chosen.length} ${chosen.length === 1 ? 'profile' : 'profiles'}` :
                'Run'}
            </BusyButton>
          </span>
        </>
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

      {selectable.length > 0 && (
        <label className="run-profiles-all">
          <Checkbox checked={allSelected} onChange={toggleAll} />
          <span>
            {allSelected ? 'Clear' : 'Select'} {selectable.length}
            {query ? ' matching' : ''} {selectable.length === 1 ? 'profile' : 'profiles'}
          </span>
        </label>
      )}

      <div className="move-profiles-list">
        {visible.map((profile) => {
          const value = readiness.get(profile.id);
          const block = blockFor(profile);
          // Ticked, and this automation asks for something. The form is a
          // SIBLING of the row's <label>, never a child: a label's implicit
          // activation would toggle the checkbox on every click into an input.
          const showValues = parameters.length > 0 && picked.has(profile.id);
          return (
            <div className="run-profiles-entry" key={profile.id}>
            <label
              aria-disabled={block ? true : undefined}
              className={`move-profiles-row run-profiles-row${block ? ' is-blocked' : ''}`}
            >
              <Checkbox
                checked={picked.has(profile.id)}
                disabled={Boolean(block)}
                onChange={() => toggle(profile.id)}
              />
              {/* Name and connection together in the one flexible cell. The
                  host used to sit on the right beside the verdict, which gave
                  the row two columns competing for the same slack and pushed
                  the chip -- the thing this screen exists to show -- out of the
                  panel. Here the host is what gives way: it is the detail, the
                  chip is the answer. */}
              <span className="move-profiles-name">
                <ProfileAvatar profile={profile} small />
                {/* Each text span truncates on its own. The cell is a flexbox,
                    and text-overflow does nothing on one of those. */}
                <span className="run-profiles-label">{profile.name}</span>
                {/* Omitted, not empty: a direct profile has no connection to
                    name, and an empty span still contributes the cell's gap. */}
                {hostLabel(value) && (
                  <span className="run-profiles-host">{hostLabel(value)}</span>
                )}
              </span>
              <StatusChip status={profile.status || 'Ready'} />
              <span className="run-profiles-proxy">
                {block === 'running' ?
                  <span className="run-profiles-note">Already running</span> :
                  <ReadinessCell
                    checking={Boolean(value && 'proxy' in value && checkingProxyIds.has(value.proxy.id))}
                    readiness={value}
                  />}
                {/* Only on the rows that can act on it -- a Fix beside a healthy
                    proxy is an invitation to break one. An icon button on the
                    tables' own .row-action, not a text button: at full size it
                    was taller than the row it sits in, and the word would
                    compete with the "Failed" chip right beside it for the same
                    two inches. preventDefault stops the click also reaching the
                    <label> and toggling a checkbox. */}
                {value && 'proxy' in value && block === 'failed' && (
                  <button
                    aria-label={`Fix the proxy for ${profile.name}`}
                    className="icon-button row-action"
                    onClick={(event) => {
                      event.preventDefault();
                      onFixProxy(value.proxy);
                    }}
                    title={`Edit ${value.proxy.host}:${value.proxy.port}`}
                    type="button"
                  ><Wrench size={14} /></button>
                )}
              </span>
            </label>
            {showValues && (
              <div className="run-profiles-params">
                <ParamValueFields
                  parameters={parameters}
                  values={overrides[profile.id] || {}}
                  onChange={(next) =>
                    setOverrides((current) => ({...current, [profile.id]: next}))}
                  compact
                />
              </div>
            )}
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="move-profiles-empty">
            <SearchX size={16} />
            {candidates.length ?
              'No profiles match that search.' :
              'There are no profiles yet. An automation needs one to run against.'}
          </p>
        )}
      </div>

      {parameters.length > 0 && chosen.length > 0 && (
        <label className="run-profiles-save">
          <Checkbox checked={saveToProfiles} onChange={() => setSaveToProfiles((on) => !on)} />
          <span>
            Save these values to {chosen.length === 1 ? 'the profile' : 'the profiles'}
          </span>
        </label>
      )}

      {/* Said out loud, not only as the disabled button's title. Two ticked
          profiles can be on screen with their values filled while the one that
          is missing a city sits below the fold -- a greyed Run with no visible
          reason reads as a bug. */}
      {unansweredNote && (
        <p className="run-blocked-note">
          <ShieldAlert size={15} />
          {unansweredNote}
        </p>
      )}

      {blocked.length > 0 && (
        <p className="run-blocked-note">
          <ShieldAlert size={15} />
          {blockedSentence(blocked.length, blocked.filter((p) => blockFor(p) === 'running').length)}
        </p>
      )}
    </Modal>
  );
}

// A blank is "not set", so it is dropped rather than stored -- the same rule
// the profile editor's save follows (draftVarsToProfile in drafts.ts). Storing
// "" would look identical in the form and behave identically at run time, while
// hiding which values the user actually chose.
function droppingBlanks(values: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
      Object.entries(values).filter(([, value]) => value.trim() !== ''));
}

// What this profile connects through, under its name. Empty for the modes with
// no proxy -- the verdict column already says "Direct" there, and repeating it
// twice on one row says nothing the first one did not.
function hostLabel(readiness: RunReadiness | undefined): string {
  return readiness && 'proxy' in readiness ?
    `${readiness.proxy.host}:${readiness.proxy.port}` :
    '';
}

// Whether this profile's connection works: the row's verdict, and the only
// thing in it that decides whether the checkbox is live. Direct and free-proxy
// profiles get a word rather than a chip -- there is no check behind them, and
// a green chip would claim one.
function ReadinessCell({readiness, checking}: {
  readiness: RunReadiness | undefined;
  checking: boolean;
}) {
  if (!readiness) {
    return null;
  }
  if (readiness.kind === 'direct') {
    return <span className="run-profiles-note">Direct</span>;
  }
  if (readiness.kind === 'free_proxy') {
    return <span className="run-profiles-note">Free proxy</span>;
  }
  if (readiness.kind === 'missing') {
    return <span className="run-profiles-note is-bad">No proxy</span>;
  }
  const {proxy} = readiness;
  return (
    <ProxyCheckCell
      state={checking ? {status: 'checking'} : storedCheckState(proxy)}
      age={proxy.check_error ? undefined : proxy.checked_at}
    />
  );
}

// Says what is about to happen and nothing else. The concurrency is named
// because it is the difference between "five browsers open at once" and what
// actually happens, and someone picking five profiles deserves to know which.
function subtitle(chosen: number, blocked: number, sweeping: boolean): string {
  if (sweeping) {
    return 'Checking the proxies behind these profiles. A profile whose proxy is ' +
      'down cannot be ticked.';
  }
  const parts = ['Pick the profiles to run this on.'];
  if (chosen > RUN_CONCURRENCY) {
    parts.push(`${RUN_CONCURRENCY} run at a time; the rest wait their turn.`);
  }
  if (blocked) {
    parts.push('Greyed-out profiles cannot run right now.');
  }
  return parts.join(' ');
}

// Counts the two reasons separately, because they need different things done
// about them: a bad proxy is fixable from here, a run in flight only needs
// waiting out. One line, so the note stays a status and not a paragraph.
function blockedSentence(blocked: number, alreadyRunning: number): string {
  const proxyCount = blocked - alreadyRunning;
  const parts: string[] = [];
  if (proxyCount) {
    parts.push(`${proxyCount} can't run — ` +
      `${proxyCount === 1 ? 'its proxy' : 'their proxies'} failed the check`);
  }
  if (alreadyRunning) {
    parts.push(`${alreadyRunning} already running`);
  }
  return `${parts.join(' · ')}.`;
}
