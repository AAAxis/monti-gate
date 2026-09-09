// Run history for one automation, and the log of whichever run is selected.
//
// Log lines are indented by their `path` depth, so a loop body reads the same
// shape here as it does in the editor -- '5.body.2' is two levels in.
// Screenshots are filenames on disk, fetched on demand rather than carried in
// the record, because a run with twenty captures would otherwise be megabytes
// of base64 in a jsonb column.
import {useEffect, useState} from 'react';
import {Badge} from '../ui/Badge';
import {Modal} from '../ui/Modal';
import {native} from '../../native';
import * as db from '../../db';
import {useOrg} from '../../org';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import {RUN_LABEL, RUN_TONE} from '../../automations/runStatus';
import type {RunLogEntry} from '../../automations/types';
import type {ScoutAutomation, AutomationRun} from '../../types';

// A log line's own class, not a badge -- these are lines of text, and a pill on
// every warn line would out-shout the message. `apply-status-warn` used to be
// named here and is defined in no stylesheet, so a warn line was indenting
// correctly and rendering as an ordinary line.
const LEVEL_CLASS: Record<RunLogEntry['level'], string> = {
  info: '',
  warn: 'is-warn',
  error: 'is-error',
};

function depthOf(path: string): number {
  return path ? path.split('.').length - 1 : 0;
}

export function RunLogModal({automation, onClose}: {
  automation: ScoutAutomation;
  onClose: () => void;
}) {
  const org = useOrg();
  const {automations} = useWorkspace();
  const [history, setHistory] = useState<AutomationRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shots, setShots] = useState<Record<string, string>>({});

  // Live runs from this session take precedence over the stored copy: the
  // stored one is only written at start and end, so mid-run it is stale.
  const live = Object.values(automations.runs)
      .filter((run) => run.automation_id === automation.id);
  const merged = [
    ...live,
    ...history.filter((run) => !live.some((entry) => entry.id === run.id)),
  ].sort((a, b) => b.started_at.localeCompare(a.started_at));

  const selected = merged.find((run) => run.id === selectedId) || merged[0] || null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!org.orgId) {
        setLoading(false);
        return;
      }
      try {
        const rows = await db.runs.list(org.orgId, {automationId: automation.id, limit: 25});
        if (!cancelled) {
          setHistory(rows);
        }
      } catch {
        // History is a nice-to-have; a failed read must not blank the live run
        // the user is probably here to watch.
      }
      if (!cancelled) {
        setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [org.orgId, automation.id]);

  // Fetch screenshots for the selected run only, once.
  useEffect(() => {
    if (!selected || !native?.readRunScreenshot) {
      return;
    }
    const wanted = selected.log.filter((entry) => entry.screenshot);
    for (const entry of wanted) {
      const key = `${selected.id}/${entry.screenshot}`;
      if (shots[key]) {
        continue;
      }
      void native.readRunScreenshot(selected.id, entry.screenshot as string)
          .then((data) => {
            if (data) {
              setShots((current) => ({...current, [key]: data}));
            }
          })
          .catch(() => undefined);
    }
    // shots is intentionally not a dependency: it is what this effect writes,
    // and including it would re-run on every fetched image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.log.length]);

  return (
    <Modal
      onClose={onClose}
      className="run-log-modal"
      title={automation.name}
      subtitle="Run history"
    >
      <div className="run-log-layout">
        <aside className="run-log-list">
          {loading && merged.length === 0 && <p className="field-hint">Loading…</p>}
          {!loading && merged.length === 0 && (
            <p className="field-hint">This automation has not run yet.</p>
          )}
          {merged.map((run) => (
            <button
              key={run.id}
              type="button"
              className={`run-log-entry${selected?.id === run.id ? ' is-active' : ''}`}
              onClick={() => setSelectedId(run.id)}
            >
              <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge>
              <span className="run-log-entry-meta">
                {run.profile_name || 'unknown profile'} · {run.trigger}
              </span>
              <span className="run-log-entry-time">
                {new Date(run.started_at).toLocaleString()}
              </span>
            </button>
          ))}
        </aside>

        <div className="run-log-detail">
          {!selected && <p className="field-hint">Pick a run to see what it did.</p>}
          {selected && (
            <>
              {selected.status === 'running' && (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => void automations.cancelRun(selected.id)}
                >Cancel this run</button>
              )}
              {selected.error && <p className="settings-error">{selected.error}</p>}

              <ol className="run-log-lines">
                {selected.log.map((entry, index) => (
                  <li
                    key={index}
                    className={`run-log-line ${LEVEL_CLASS[entry.level] || ''}`}
                    style={{paddingLeft: `${12 + depthOf(entry.path) * 14}px`}}
                  >
                    <span className="run-log-line-path">{entry.path}</span>
                    <span className="run-log-line-text">{entry.message}</span>
                    {entry.durationMs !== undefined && (
                      <span className="run-log-line-ms">{entry.durationMs}ms</span>
                    )}
                    {entry.screenshot && shots[`${selected.id}/${entry.screenshot}`] && (
                      <img
                        className="run-log-shot"
                        alt={`Screenshot from step ${entry.path}`}
                        src={shots[`${selected.id}/${entry.screenshot}`]}
                      />
                    )}
                  </li>
                ))}
              </ol>

              {Object.keys(selected.vars || {}).length > 0 && (
                <div className="snippet-block">
                  <pre>{JSON.stringify(selected.vars, null, 2)}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
