// Live run state, and the only place runs are written to the database.
//
// The main process drives the browser but holds no Supabase credentials, so it
// streams events here and this hook persists them. That keeps
// docs/process-boundary.md true and means a run's record is written by whoever
// is signed in, under their RLS.
//
// Three things this has to get right:
//
//   1. A run is inserted when it STARTS, not when it finishes. A row that only
//      appears on success means a killed run leaves no trace, and "did last
//      night's run work" has no answer.
//   2. If the window was closed or signed out when a run ended, there is no row
//      to update -- the runner buffered it to disk instead. flushPending()
//      upserts those on mount. That is what makes history honest rather than
//      best-effort.
//   3. Log entries arrive one at a time and can run to thousands. They are kept
//      in a ref and mirrored into state on a timer, because setState per entry
//      would re-render the log viewer on every step of every run.
import {useCallback, useEffect, useRef, useState} from 'react';
import * as db from '../db';
import {describeDbError} from '../db';
import {native} from '../native';
import type {ScoutAutomation, ScoutProfile, AutomationRun} from '../types';
import type {
  AutomationStep, AutomationVars, RunLogEntry, RunTrigger,
} from '../automations/types';

const FLUSH_INTERVAL_MS = 400;

export type StartRunResult =
  | {ok: true; runId: string}
  | {ok: false; error: string};

// The notify-on-finish payload riding a finished event: composed by the main
// process off the sealed run record, delivered here because the renderer is
// the only side that can write the `notifications` row. `sendError` is the
// connector delivery failure, if any -- already logged into the run record by
// the runner, so it is not stored again.
export type RunNotification = {
  kind: string;
  title: string;
  body: string;
  status?: string | null;
  automation_id?: string | null;
  run_id?: string | null;
  sendError?: string | null;
};

export function useAutomationRuns(
    orgId: string | null,
    signedIn: boolean,
    // Called on EVERY terminal run this session sees, with the notification
    // payload when the finished event carried one (it does only when the
    // automation's notify_on said so). The caller owns what either means --
    // the bell insert, the card's last-run patch, a personal Telegram send --
    // this hook only hands them over, so its "runs are the only thing written
    // here" header stays true of workspace tables.
    onRunFinished?: (run: AutomationRun, notification?: RunNotification) => void,
) {
  // runId -> run, for anything in flight or just finished this session.
  const [runs, setRuns] = useState<Record<string, AutomationRun>>({});
  const pending = useRef<Record<string, AutomationRun>>({});
  const dirty = useRef(false);
  const orgRef = useRef(orgId);
  orgRef.current = orgId;
  // Who is waiting for a run to end. See waitForRun below.
  const waiters = useRef<Map<string, (run: AutomationRun) => void>>(new Map());
  // A ref because the event subscription below deliberately mounts once; a
  // closure over the prop would go stale on the first re-render.
  const finishedRef = useRef(onRunFinished);
  finishedRef.current = onRunFinished;

  // Mirror the ref into state on a timer rather than per event.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!dirty.current) {
        return;
      }
      dirty.current = false;
      setRuns({...pending.current});
    }, FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!native?.onAutomationRunEvent) {
      return undefined;
    }
    return native.onAutomationRunEvent((event) => {
      const org = orgRef.current;
      if (event.type === 'started') {
        pending.current[event.runId] = event.run;
        dirty.current = true;
        // Insert immediately. A failure here is not fatal to the run -- the
        // runner has already buffered it to disk and the flush will pick it up.
        if (org) {
          void db.runs.start(org, event.run).catch(() => undefined);
        }
        return;
      }
      if (event.type === 'log') {
        const run = pending.current[event.runId];
        if (run) {
          run.log = [...run.log, event.entry as RunLogEntry];
          dirty.current = true;
        }
        return;
      }
      pending.current[event.runId] = event.run;
      dirty.current = true;
      // Every terminal run goes to the owner -- the bell row (when the event
      // carries a notification), the card's last-run patch, a personal
      // Telegram send. Handed over before the run write for the same reason
      // waiters are resolved first: none of it should wait on Supabase.
      finishedRef.current?.(event.run, event.notification ?? undefined);
      // Before the database write, and outside its promise: a batch's pacing
      // must not wait on Supabase, and an offline machine still has to start
      // its next run.
      const waiter = waiters.current.get(event.runId);
      if (waiter) {
        waiters.current.delete(event.runId);
        waiter(event.run);
      }
      if (org) {
        // upsert, not update: if the insert above failed (offline, signed out)
        // there is no row to update and the run would vanish.
        void db.runs.upsertFinished(org, event.run)
            .then(() => native?.markAutomationRunFlushed?.(event.runId))
            .catch(() => undefined);
        // The denormalized card verdict. Independent of the run write -- its
        // .lt guard makes it safe whatever order finishes land in.
        if (event.run.automation_id && event.run.finished_at) {
          void db.automations.recordRunOutcome(
              org, event.run.automation_id, event.run.finished_at, event.run.status)
              .catch(() => undefined);
        }
      }
    });
  }, []);

  // Resolves when this run reaches a terminal state.
  //
  // A batch needs this because startRun resolves as soon as the run has
  // STARTED -- runner.cjs deliberately does not await execute() -- so pacing a
  // queue on startRun would start every profile at once and trip the runner's
  // own MAX_CONCURRENT_RUNS of 3, which refuses with a 429 rather than
  // queueing. Pacing on completion is what makes the cap a queue.
  //
  // Already-finished runs resolve immediately: the terminal event can arrive
  // between startRun returning and the caller asking, and a promise that waits
  // for an event already delivered never settles.
  //
  // `timeoutMs` is a stall guard, not a cancel -- the run keeps going and its
  // record is still written when it does end. Without it a run whose terminal
  // event never arrives (a killed browser, a main process that went away) would
  // hold a queue slot forever, so a batch of five could stop after three with
  // no error anywhere. Resolves null on expiry so the caller can tell the two
  // apart.
  const waitForRun = useCallback(
      (runId: string, timeoutMs: number): Promise<AutomationRun | null> => {
        const known = pending.current[runId];
        if (known && known.status !== 'running') {
          return Promise.resolve(known);
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiters.current.delete(runId);
            resolve(null);
          }, timeoutMs);
          waiters.current.set(runId, (run) => {
            clearTimeout(timer);
            resolve(run);
          });
        });
      }, []);

  // Runs that finished on disk but never reached the database.
  const flushPending = useCallback(async () => {
    if (!orgId || !signedIn || !native?.pendingAutomationRuns) {
      return;
    }
    try {
      const buffered = await native.pendingAutomationRuns();
      for (const run of buffered) {
        if ((run as AutomationRun & {flushed?: boolean}).flushed) {
          continue;
        }
        await db.runs.upsertFinished(orgId, run);
        // Buffered runs are by definition stale -- the .lt guard on this
        // update is what stops one regressing a verdict a newer run already
        // wrote.
        if (run.automation_id && run.finished_at) {
          await db.automations.recordRunOutcome(
              orgId, run.automation_id, run.finished_at, run.status)
              .catch(() => undefined);
        }
        await native.markAutomationRunFlushed?.(run.id);
      }
    } catch {
      // Offline or unreadable. The buffer stays on disk for next time --
      // losing it would be worse than retrying.
    }
  }, [orgId, signedIn]);

  // Rejoin anything already running, so reopening the window mid-run shows it.
  const adoptActive = useCallback(async () => {
    if (!native?.activeAutomationRuns) {
      return;
    }
    try {
      const active = await native.activeAutomationRuns();
      for (const run of active) {
        pending.current[run.id] = run;
      }
      if (active.length > 0) {
        dirty.current = true;
      }
    } catch {
      // Nothing in flight, or main is not answering yet.
    }
  }, []);

  useEffect(() => {
    void flushPending();
    void adoptActive();
  }, [flushPending, adoptActive]);

  // Starts a run against a profile, launching it first when it is not open.
  //
  // Reuses an existing session rather than relaunching: a manual Run against a
  // profile the user already has open must not kill their window, and
  // spawnProfileUnchecked pkills the profile before spawning.
  const startRun = useCallback(async (
      automation: ScoutAutomation,
      profile: ScoutProfile,
      options: {
        trigger?: RunTrigger;
        vars?: AutomationVars;
        // calleeId -> steps for every callAutomation in the tree, resolved by
        // the caller against the loaded workspace (resolveCallTree). This hook
        // cannot resolve it itself -- it does not hold the automations list.
        resolvedAutomations?: Record<string, AutomationStep[]>;
        // Variable names the runner must mask in the log and in the sealed
        // record. Resolved by the caller for the same reason the call tree is.
        secretVarNames?: string[];
        buildLaunch?: (cdpPort: number) => Promise<{ok: boolean; error?: string}>;
      } = {},
  ): Promise<StartRunResult> => {
    if (!native?.startAutomationRun || !native?.resolveProfileCdp) {
      return {ok: false, error: 'Automation needs the desktop app.'};
    }
    try {
      let session = await native.resolveProfileCdp(profile.id);
      // Whether this run is the reason the browser is open. It decides whether
      // close_on_finish may close it: a window that was already there belongs
      // to whoever opened it, and a run is a guest in it.
      let ownsSession = false;
      if (!session.running) {
        if (!options.buildLaunch) {
          return {ok: false, error: `${profile.name} is not open.`};
        }
        const port = await native.reserveCdpPort?.();
        if (!port) {
          return {ok: false, error: 'Could not allocate a debugging port.'};
        }
        const launched = await options.buildLaunch(port);
        if (!launched.ok) {
          return {ok: false, error: launched.error || 'The profile did not launch.'};
        }
        // Waited for, not re-resolved. Chromium binds --remote-debugging-port
        // and writes DevToolsActivePort a second or two after spawn, so asking
        // resolveProfileCdp again here loses the race almost every time and
        // reports a window that is opening as one that never answered.
        // waitForCdp polls the port this process just handed out, which is the
        // same thing the on-launch trigger does (useProfileActions) and the
        // HTTP launch-automation route does (waitForCdpReady in main.cjs).
        //
        // The already-open branch above stays on resolveProfileCdp on purpose:
        // there is no port in hand there, and its two-tier lookup is what lets
        // a run attach to a session this process did not start.
        const ready = await native.waitForCdp?.(port, 20000);
        if (!ready?.ok || !ready.cdpUrl) {
          return {
            ok: false,
            error: ready?.error || 'The browser started but never answered on its debugging port.',
          };
        }
        session = {running: true, cdpUrl: ready.cdpUrl, pid: null};
        ownsSession = true;
      }
      const result = await native.startAutomationRun({
        automation,
        profile,
        trigger: options.trigger || 'manual',
        cdpUrl: session.cdpUrl as string,
        vars: options.vars,
        resolvedAutomations: options.resolvedAutomations,
        secretVarNames: options.secretVarNames,
        ownsSession,
      });
      if (!result.ok || !result.runId) {
        return {ok: false, error: result.error || 'The run did not start.'};
      }
      return {ok: true, runId: result.runId};
    } catch (error) {
      return {ok: false, error: describeDbError(error, 'The run did not start.')};
    }
  }, []);

  const cancelRun = useCallback(async (runId: string) => {
    await native?.cancelAutomationRun?.(runId);
  }, []);

  return {runs, startRun, cancelRun, waitForRun, flushPending};
}
