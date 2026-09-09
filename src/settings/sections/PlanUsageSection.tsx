// Plan: what the workspace is on and what that includes.
//
// Read-only by design. Every column shown here (plan, the limits, billing
// status) is service-role only -- 0002 re-granted UPDATE on organizations for
// (name, built_in_extensions) and nothing else -- so a client cannot change any
// of it, and the buttons go to the website's pricing and dashboard rather than
// pretending otherwise. This is the app's only plan surface; the picker and
// checkout live on the site.
import {
  Cloud, ExternalLink, Monitor, Receipt, ShieldCheck, SquareTerminal, Users, Workflow,
} from 'lucide-react';
import type {ReactNode} from 'react';
import {Badge} from '../../components/ui/Badge';
import type {BadgeTone} from '../../components/ui/Badge';
import {formatDate} from '../../lib/text';
import {useOrg} from '../../org';
import {hasUpgrade, isPlanKey, PLANS, planLabel, planPrice, showsPlanPicker} from '../../plans';
import type {ScoutOrg} from '../../types';
import {SettingsGroup, SettingsRow} from '../rows';

type Props = {
  onOpenSite: (pathname: string) => void;
  // Opens the website's pricing section, where the plan cards and checkout are.
  onOpenPlans: () => void;
};

export function PlanUsageSection({onOpenSite, onOpenPlans}: Props) {
  const org = useOrg();
  const plan = org.org?.plan;
  const price = planPrice(plan);
  const status = org.org?.billing_status || '';
  const periodEnd = formatDate(org.org?.current_period_end);
  const ending = status === 'canceled' || status === 'cancelled';
  const onFreePlan = showsPlanPicker(plan);

  return (
    <>
      <SettingsGroup>
        <div className="settings-plan">
          <span className="settings-plan-mark" aria-hidden="true">
            <ShieldCheck size={20} strokeWidth={1.75} />
          </span>
          <div className="settings-plan-body">
            <div className="settings-plan-title">
              <span className="settings-plan-name">{planLabel(plan)}</span>
              {status && <Badge tone={billingTone(status)}>{status}</Badge>}
            </div>
            <p>
              {price === null || price === 0 ? 'No charge' : `$${price}/month`}
              {periodEnd ? ` · ${ending ? 'cancelled, ends' : 'renews'} ${periodEnd}` : ''}
            </p>
          </div>
          <div className="settings-plan-actions">
            {/* Straight to the site's pricing section (onOpenPlans), not the
                dashboard -- Manage billing already covers the dashboard, and
                an upgrade starts at the plan cards. */}
            {hasUpgrade(plan) && (
              <button onClick={onOpenPlans} type="button">
                {onFreePlan ? 'See plans' : 'Upgrade plan'}
              </button>
            )}
            <button className="ghost" onClick={() => onOpenSite('/dashboard')} type="button">
              <ExternalLink size={15} /> Manage billing
            </button>
          </div>
        </div>
      </SettingsGroup>

      <IncludedGroup org={org.org} plan={plan} />

      <SettingsGroup title="Billing">
        <SettingsRow
          label="Invoices and payment method"
          icon={<Receipt size={16} strokeWidth={1.75} />}
          description="Invoices and your payment method live in the web dashboard."
        >
          <button className="ghost" onClick={() => onOpenSite('/dashboard')} type="button">
            <ExternalLink size={15} /> Open dashboard
          </button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

// null is unlimited -- the convention every limit column and every trigger in
// this schema follows.
function limitText(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unlimited' : String(value);
}

// What this workspace is entitled to, as tiles rather than prose.
//
// THESE ARE THE DATABASE'S NUMBERS, NOT src/plans.ts's. That distinction is the
// whole point of this component and it was got wrong until 2026-08-08: the tiles
// rendered PLANS[plan] -- the hand-kept marketing mirror -- directly above meters
// that render organizations.*_limit. When the two disagreed the same screen
// showed "Included in Enterprise: 1000 profiles, 25 people" over a meter reading
// "15 of 300", and the reader had no way to tell which number they had bought.
//
// The mirror cannot be the answer here, because it describes what the tier is
// *sold* as while the triggers enforce what the row *says*. A workspace whose
// limits were set by hand, or whose upgrade landed before
// apply_plan_entitlements existed (it did not exist until 2026-08-05, so every
// upgrade before then set plan and nothing else), has a row that disagrees with
// its own plan name. Showing the mirror hides that; showing the row surfaces it.
//
// Renders nothing until the org has loaded. An unrecognised plan string still
// gets its tiles -- unlike the mirror-driven version, these numbers do not
// depend on the plan being one this build knows about.
function IncludedGroup({org, plan}: {org: ScoutOrg | null | undefined; plan: string | null | undefined}) {
  if (!org) {
    return null;
  }

  // Only answerable for a plan this build knows. Deliberately compares against
  // the mirror rather than trusting it: this is the one place the disagreement
  // can be seen, so it is the one place worth reporting it.
  const info = isPlanKey(plan) ? PLANS[plan] : null;
  const mismatched = info !== null && (
    org.profile_limit !== info.profiles ||
    org.seat_limit !== info.seats ||
    org.automation_limit !== info.automations
  );

  return (
    <SettingsGroup title={`Included in ${planLabel(plan)}`}>
      <div className="settings-included">
        <IncludedTile
          icon={<Monitor size={16} strokeWidth={1.75} />}
          label="Browser profiles"
          value={limitText(org.profile_limit)}
        />
        <IncludedTile
          icon={<Users size={16} strokeWidth={1.75} />}
          label="People"
          value={org.seat_limit === 1 ? 'Just you' : limitText(org.seat_limit)}
        />
        <IncludedTile
          icon={<Workflow size={16} strokeWidth={1.75} />}
          label="Automations"
          value={limitText(org.automation_limit)}
        />
        <IncludedTile
          icon={<Cloud size={16} strokeWidth={1.75} />}
          label="Cloud sync"
          value="Included"
        />
        <IncludedTile
          icon={<SquareTerminal size={16} strokeWidth={1.75} />}
          label="Local API"
          value="Included"
        />
      </div>
      {mismatched && (
        // Said plainly rather than silently corrected. The app cannot fix this
        // itself -- every limit column is service-role only -- and a workspace
        // getting less than its plan sells is a billing problem, not a display
        // problem, so the only useful thing this screen can do is name it and
        // point at the people who can change it.
        <p className="settings-note">
          These are the limits set on your workspace, and they don&rsquo;t match what the{' '}
          {info?.label} plan includes ({info?.profiles} profiles, {info?.seats} people,{' '}
          {info?.automations} automations). Contact support and we&rsquo;ll put it right.
        </p>
      )}
    </SettingsGroup>
  );
}

function IncludedTile({icon, label, value}: {icon: ReactNode; label: string; value: string}) {
  return (
    <div className="settings-included-tile">
      <span className="settings-included-icon" aria-hidden="true">{icon}</span>
      <span className="settings-included-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

// The status word Revolut and the admin tools write, in the app's tone
// vocabulary. A cancelled subscription is still active until the period ends, so
// it is warned about rather than shown as an error; a failed payment is the one
// that is.
function billingTone(status: string): BadgeTone {
  const value = status.toLowerCase();
  if (value === 'active' || value === 'trialing') {
    return 'active';
  }
  if (value === 'canceled' || value === 'cancelled') {
    return 'warmup';
  }
  if (value === 'past_due' || value === 'unpaid' || value === 'failed') {
    return 'ban';
  }
  return 'neutral';
}
