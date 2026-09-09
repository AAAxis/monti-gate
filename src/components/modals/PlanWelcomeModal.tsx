// "Welcome to Team" -- the one screen that marks a workspace changing plan.
//
// Raised by App when the org's plan differs from the last one this machine
// acknowledged (src/lib/planWelcome.ts). That single trigger covers all three
// ways a paid plan arrives, which is why there is one dialog and not three:
// somebody bought it and came back through scout://open, somebody was granted
// it by support, or somebody was invited into a workspace that already had it.
//
// The numbers are the point. A list of ticks would say what the plan includes;
// "5 → 300" says what just changed, which is the thing the reader paid for and
// the only version of this screen that could not be written for any other
// product. An invited member has no "before" -- they were never on Free here --
// so their variant drops the arrows and reads as an introduction instead.
//
// WHICH numbers, though, is the part this got wrong until 2026-08-08. The
// "after" column read PLANS[plan] -- the marketing mirror -- so a workspace on
// `team` whose row actually said 300 profiles was congratulated on 1000. The
// first thing that customer does is open Settings and find a meter reading "15
// of 300", which is a bad way to learn the welcome screen was guessing.
//
// So `limits` is now passed in from the organizations row, and the caller reads
// it from the same columns the triggers enforce. `previous` stays a mirror
// lookup because there is nowhere else to get it -- localStorage remembers the
// plan key, not the limits it carried -- but it is only ever the "before", and a
// before that disagrees with a real after is itself informative.
import {Monitor, Users, Workflow} from 'lucide-react';
import type {ReactNode} from 'react';
import {Modal} from '../ui/Modal';
import type {PlanInfo} from '../../plans';

// What the workspace actually got, read off organizations. null is unlimited,
// the convention every limit column here follows.
export type PlanWelcomeLimits = {
  profiles: number | null;
  seats: number | null;
  automations: number | null;
};

export function PlanWelcomeModal({plan, limits, previous, orgName, onClose}: {
  plan: PlanInfo;
  limits: PlanWelcomeLimits;
  // The plan this machine last saw for this workspace. Undefined for someone
  // who has just joined -- see the file header.
  previous?: PlanInfo;
  orgName: string;
  onClose: () => void;
}) {
  const joining = !previous;

  return (
    <Modal
      className="small-modal plan-welcome"
      onClose={onClose}
      header={
        <div className="plan-welcome-hero">
          {/* The product's own mark rather than a generic celebration glyph:
              this dialog is the moment the workspace becomes a paid one, and
              the thing being welcomed to is Scout Web. Masked from the same PNG the
              sidebar uses, so it tints with the plan accent -- see .brand-mark
              in styles.css. */}
          <span className="plan-welcome-mark" aria-hidden="true">
            <span className="plan-welcome-glyph" />
          </span>
          <h2>Welcome to {plan.label}</h2>
          <p>
            {joining ?
              `You've joined ${orgName}, and it's on ${plan.label}. Here's what the ` +
                'workspace can do.' :
              `${orgName} is on ${plan.label}. The new limits are live — there's nothing ` +
                'to reinstall.'}
          </p>
        </div>
      }
      footer={
        <button onClick={onClose} type="button">Start using {plan.label}</button>
      }
    >
      <dl className="plan-welcome-grid">
        <Unlocked
          icon={<Monitor size={16} strokeWidth={1.75} />}
          label="Browser profiles"
          from={previous?.profiles}
          to={limits.profiles}
        />
        <Unlocked
          icon={<Users size={16} strokeWidth={1.75} />}
          label="People in the workspace"
          from={previous?.seats}
          to={limits.seats}
        />
        <Unlocked
          icon={<Workflow size={16} strokeWidth={1.75} />}
          label="Saved automations"
          from={previous?.automations}
          to={limits.automations}
        />
      </dl>

      <p className="plan-welcome-note">
        {(limits.seats === null || limits.seats > 1) ?
          'Invite the rest of the team from the Team tab — everyone shares the same ' +
            'profiles, proxies, cookie sets and automations.' :
          'Everything syncs to your account, so signing in on another machine brings the ' +
            'whole workspace with it.'}
      </p>
    </Modal>
  );
}

// One row. `from` is omitted for the joining variant, and also skipped when the
// number did not move -- an arrow from 25 to 25 is noise dressed as news.
//
// `to` is nullable because the limit columns are: null means unlimited, and
// "300 → Unlimited" is the correct way to render that rather than "300 → null".
function Unlocked({icon, label, from, to}: {
  icon: ReactNode;
  label: string;
  from?: number;
  to: number | null;
}) {
  const shown = to === null ? 'Unlimited' : String(to);
  const moved = from !== undefined && from !== to;
  return (
    <div className="plan-welcome-row">
      <dt><span className="plan-welcome-icon" aria-hidden="true">{icon}</span>{label}</dt>
      <dd>
        {moved && (
          // aria-hidden on the arrow only: the two numbers still read in order,
          // and "5 right-arrow 300" is not how anyone would say it.
          <>
            <span className="plan-welcome-from">{from}</span>
            <span className="plan-welcome-arrow" aria-hidden="true">→</span>
          </>
        )}
        <strong>{shown}</strong>
      </dd>
    </div>
  );
}
