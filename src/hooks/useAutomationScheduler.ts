// The local scheduler: fires automations whose schedule says a slot is due,
// while this launcher window is open.
//
// The timer lives in the renderer, not the main process, because only the
// renderer can do what firing requires -- resolve the automation and its call
// tree, gate the proxy, write the run rows. The consequence is stated plainly
// in the UI: schedules fire while the launcher is open. Times it was closed
// for are skipped, never caught up -- that is the GRACE_MS window below, and
// it is a decision, not a limitation: a scraping job that was due at 03:00
// firing the moment you open your laptop at 09:00 is a surprise, not service.
//
// Two launchers on one workspace both tick. Dedupe is best-effort, in order:
// a session-live run of the automation skips the slot outright, and a
// teammate's `schedule` run for the same slot is looked up in automation_runs
// before firing. The residual same-second race is accepted -- the runner's
// one-run-per-profile 409 and MAX_CONCURRENT_RUNS bound the damage to a
// refused start.
import {useEffect, useRef} from 'react';
import * as db from '../db';
import {describeMissingParams, resolveRunVars} from '../automations/parameters';
import {nextDueAt} from '../automations/schedule';
import type {AutomationActions} from '../workspace/useAutomationActions';
import type {ScoutAutomation, ScoutProfile, CloudState} from '../types';

const TICK_MS = 30_000;
// How late a slot may fire. Longer than one tick so a busy renderer cannot
// step over its own slot; far shorter than a sleep or an overnight close.
const GRACE_MS = 90_000;

function watermarkKey(orgId: string, automationId: string): string {
  return `scout:sched:${orgId}:${automationId}`;
}

export function useAutomationScheduler(
    orgId: string | null,
    signedIn: boolean,
    state: CloudState,
    automations: AutomationActions,
) {
  // The tick reads everything through a ref: the interval mounts once, and a
  // closure over props would fire month-old state.
  const current = useRef({orgId, signedIn, state, automations});
  current.current = {orgId, signedIn, state, automations};
  // Automations already fired or mid-check this session, so one slow tick
  // cannot double-fire while its predecessor still awaits the dedupe read.
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timer = setInterval(() => void tick(), TICK_MS);
    return () => clearInterval(timer);

    async function tick() {
      const {orgId: org, signedIn: signed, state: cloud, automations: actions} = current.current;
      if (!org || !signed) {
        return;
      }
      const now = new Date();
      for (const automation of cloud.automations) {
        const schedule = automation.schedule;
        // deleted_at first: a trashed automation keeps its schedule so that
        // restoring puts it back intact, and a schedule that kept firing from
        // Trash would be the loudest possible way to discover that.
        if (automation.deleted_at || !schedule?.enabled || inFlight.current.has(automation.id)) {
          continue;
        }
        const key = watermarkKey(org, automation.id);
        const stored = localStorage.getItem(key);
        // First sight of this schedule: anchor at now. Anchoring in the past
        // would fire immediately on every fresh machine.
        if (!stored) {
          localStorage.setItem(key, now.toISOString());
          continue;
        }
        const due = nextDueAt(schedule, new Date(stored));
        if (!due || due > now) {
          continue;
        }
        // The slot exists and is in the past. Whatever happens next -- fire,
        // dedupe-skip, or too-stale-skip -- it is spent: advance the watermark
        // first so a thrown fire cannot loop on the same slot.
        localStorage.setItem(key, due.toISOString());
        if (now.getTime() - due.getTime() > GRACE_MS) {
          continue;
        }
        inFlight.current.add(automation.id);
        try {
          await fire(org, automation, due, cloud, actions);
        } finally {
          inFlight.current.delete(automation.id);
        }
      }
    }

    async function fire(
        org: string,
        automation: ScoutAutomation,
        due: Date,
        cloud: CloudState,
        actions: AutomationActions,
    ) {
      // A run of this automation already visible in this session -- a manual
      // one, a teammate's this machine has seen, or the previous slot still
      // going. One at a time is the schedule contract.
      const live = Object.values(actions.runs).some((run) =>
        run.automation_id === automation.id && run.status === 'running');
      if (live) {
        return;
      }
      // A teammate's launcher may have fired this slot already. Read, not
      // guessed: their run row was inserted at start.
      try {
        const recent = await db.runs.list(org, {automationId: automation.id, limit: 3});
        const dueIso = due.toISOString();
        if (recent.some((run) => run.trigger === 'schedule' && run.started_at >= dueIso)) {
          return;
        }
      } catch {
        // Offline. Fire anyway -- a duplicate against a machine we cannot see
        // is bounded by the profile-busy 409; a skipped slot is just gone.
      }
      const targets = (automation.schedule?.profileIds || [])
          .map((id) => cloud.profiles.find(
              (profile) => profile.id === id && !profile.deleted_at))
          .filter((profile): profile is ScoutProfile => Boolean(profile));
      if (targets.length === 0) {
        return;
      }
      // A profile with no value for a required parameter is skipped, and the
      // rest of the slot still fires. run() would refuse it anyway; doing it
      // here keeps one unanswered profile from spending a concurrency slot on
      // a run that cannot start, and says so somewhere a developer can find it.
      //
      // Deliberately not a toast: a schedule fires while nobody is looking at
      // the window, so a dialog would be waiting hours later for a slot that is
      // long past. The profile editor flags the same gap where it can be fixed.
      const answerable = targets.filter((profile) => {
        const missing = describeMissingParams(automation.parameters, resolveRunVars({
          parameters: automation.parameters,
          profileValues: profile.automation_vars?.[automation.id],
        }));
        if (missing) {
          console.warn(
              `[schedule] skipped ${profile.name} for "${automation.name}": it ${missing}.`);
        }
        return !missing;
      });
      if (answerable.length === 0) {
        return;
      }
      await actions.runMany(automation, answerable, {trigger: 'schedule'});
    }
  }, []);
}
