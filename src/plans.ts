// Plan names, prices and what each one includes. For display only.
//
// The source of truth is `apply_plan_entitlements` in the database
// (docs/schema-changes/2026-08-05-teams.sql), which is what actually sets
// organizations.profile_limit / seat_limit / automation_limit, and the triggers
// that enforce them. landing/lib/plans.ts is a second mirror of the same table.
// The launcher is a separate repo and cannot import across the boundary, so this
// is hand-kept: if a plan is renamed, repriced or its limits change, change it in
// the SQL first and then here.
//
// The numbers below are the SQL's, NOT the marketing site's. Those disagreed
// about the free tier -- the site's card advertised 10 profiles where the trigger
// allows 5 -- and a plan picker is the one screen where that gap turns into a
// customer discovering the limit after paying attention to the wrong number.
//
// Note the labels deliberately differ from the keys: `pro` is sold as "Team" and
// `team` as "Enterprise" (founder's decision, recorded in landing/lib).
export type PlanKey = 'free' | 'base' | 'pro' | 'team';

export type PlanInfo = {
  key: PlanKey;
  label: string;
  // One line under the name on a plan card. Who the tier is for, not what it
  // does -- the feature list already says what it does.
  tagline: string;
  priceMonthly: number;
  // The three entitlements the database actually writes. Marketing copy only:
  // the numbers that decide anything are the columns on organizations, which is
  // what src/team/limit.ts and src/automations/limit.ts read -- precisely so a
  // stale mirror here cannot gate a feature.
  profiles: number;
  seats: number;
  automations: number;
  // The card's bullets. The first one is the headline entitlement and is drawn
  // in the plan accent; the rest are secondary. Order matters for that reason.
  features: string[];
  // Set when the tier is a strict superset of another, so the card can open with
  // "Everything in Team, and:" and list only the difference. Repeating six
  // identical bullets across two adjacent cards is what makes a pricing table
  // unreadable.
  carriesOver?: PlanKey;
  // The banner over the card, and the reason it is there: "Most popular" on
  // Team, "Most valuable" on Enterprise. A tier that carries one also gets the
  // accent border, the tinted card and the filled button.
  //
  // It is copy rather than a boolean because the two recommended tiers are
  // recommended for different reasons -- Team is what most workspaces buy,
  // Enterprise is what buys the most -- and a shared "Most popular" on both
  // would be the same claim made twice, which is no claim at all. Base has no
  // ribbon: it is the way in, not a recommendation.
  ribbon?: string;
};

export const PLANS: Record<PlanKey, PlanInfo> = {
  free: {
    key: 'free',
    label: 'Free',
    tagline: 'Try EasyDeck',
    priceMonthly: 0,
    profiles: 5,
    seats: 1,
    automations: 2,
    features: [
      '5 browser profiles',
      'Fingerprint spoofing',
      '2 automations',
      'Proxy manager',
    ],
  },
  // One seat, deliberately: teams are what the next tier up buys, so a Base
  // workspace gets the Team tab's upsell rather than a roster of one.
  base: {
    key: 'base',
    label: 'Base',
    tagline: 'For one person, at scale',
    priceMonthly: 89,
    profiles: 100,
    seats: 1,
    automations: 10,
    features: [
      '100 browser profiles',
      '10 automations',
      'Cloud sync across your machines',
      'Cookie library and proxy manager',
    ],
  },
  pro: {
    key: 'pro',
    label: 'Team',
    tagline: 'For the bigger teams',
    priceMonthly: 159,
    profiles: 300,
    seats: 10,
    automations: 10,
    features: [
      '300 browser profiles',
      'Up to 10 people, sharing one workspace',
      'Hand a profile to a colleague',
      'Cloud sync across your machines',
      '10 automations',
      'Local API access',
    ],
    ribbon: 'Most popular',
  },
  team: {
    key: 'team',
    label: 'Enterprise',
    tagline: 'For large teams and companies',
    priceMonthly: 299,
    profiles: 1000,
    seats: 25,
    automations: 100,
    carriesOver: 'pro',
    features: [
      '1000 browser profiles',
      'Up to 25 people, sharing one workspace',
      '100 automations',
    ],
    ribbon: 'Most valuable',
  },
};

// The three that can be bought, in the order a card grid shows them.
export const PAID_PLANS: PlanInfo[] = [PLANS.base, PLANS.pro, PLANS.team];

export function isPlanKey(value: unknown): value is PlanKey {
  return value === 'free' || value === 'base' || value === 'pro' || value === 'team';
}

// An unknown plan string is shown as itself rather than silently as "Free": the
// database is authoritative, and a plan this build has never heard of means the
// mirror above is stale, which the user should be able to see and report.
export function planLabel(plan: string | null | undefined): string {
  if (isPlanKey(plan)) {
    return PLANS[plan].label;
  }
  return plan || 'Free';
}

export function planPrice(plan: string | null | undefined): number | null {
  return isPlanKey(plan) ? PLANS[plan].priceMonthly : null;
}

// True when there is a higher tier to sell. Drives whether the plan section
// offers "Upgrade plan" or only "Manage billing".
export function hasUpgrade(plan: string | null | undefined): boolean {
  const price = planPrice(plan);
  return price === null || price < PLANS.team.priceMonthly;
}

// Whether to show this workspace the Plans tab, which exists to sell the first
// paid plan and is hidden once one is bought.
//
// `plan === 'free'` exactly, and deliberately not `!isPaid` or `hasUpgrade()`:
//
//   - `undefined` is "the org has not loaded yet", and it answers false. An
//     upgrade tab that appears for a moment on every cold start and then
//     vanishes is the same bug src/team/limit.ts and src/automations/limit.ts
//     both carry a warning about, except worse -- those flash an upsell inside a
//     tab, this one would flash a whole tab into the sidebar.
//   - an unrecognised plan string also answers false. It means this mirror is
//     stale, and the wrong direction to fail is to invite a paying customer to
//     buy something they may already have.
export function showsPlanPicker(plan: string | null | undefined): boolean {
  return plan === 'free';
}
