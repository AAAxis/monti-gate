// Whether this org may invite another person, and whether it may have a team at
// all.
//
// Deliberately shaped like src/automations/limit.ts, including the part that
// file learned the hard way: when the org has not loaded yet, say `loading` --
// never fold an unknown org into `?? 1` and report it as at capacity. That
// mistake tells the user their plan is the problem while the truth is that
// nothing has arrived, and on this screen it would put the upsell hero in front
// of a paying team every time the app started.
//
// Same standing caveat as that file, for the same reason: this is UX only, in
// both directions. The launcher runs on hardware the customer controls, so a
// client-side cap is decoration. The real gates are trg_seat_limit on
// org_members and the reservation check inside create_org_invite, and
// describeDbError turns both of their exceptions into the same sentence the
// disabled button's tooltip uses. Letting a click through while the org is
// unknown costs one refused invite with an accurate message; disabling it costs
// a user who cannot tell a slow load from a locked feature.
import type {ScoutOrg} from '../types';

export type SeatCap = {
  // Nothing is known yet. Neither allow nor deny on this -- say nothing.
  loading: boolean;
  // No more seats. Covers the members already here plus the invites already
  // sent, because create_org_invite counts both and refusing after the click
  // would be the app knowing better and not saying so.
  atCap: boolean;
  // Members + outstanding invites, i.e. what `limit` is compared against.
  used: number;
  limit: number | null;
  // False when the plan is single-seat. The Team tab shows its upsell rather
  // than a roster of one, which is also how a Base customer discovers that
  // moving up is what buys them a team.
  entitled: boolean;
};

export function seatCap(
    org: ScoutOrg | null | undefined,
    memberCount: number,
    pendingInviteCount = 0,
): SeatCap {
  const used = memberCount + pendingInviteCount;
  if (!org) {
    return {loading: true, atCap: false, used, limit: null, entitled: false};
  }
  // null is unlimited -- the convention profile_limit uses and the one
  // enforce_seat_limit() itself follows (`if lim is null then return new`).
  //
  // `?? null` rather than `?? 1`: unlike automation_limit, rowToOrg does not
  // collapse this one, and an org whose seat_limit genuinely is null is
  // Enterprise-unlimited rather than solo.
  const limit = org.seat_limit ?? null;
  if (limit === null) {
    return {loading: false, atCap: false, used, limit: null, entitled: true};
  }
  return {
    loading: false,
    atCap: used >= limit,
    used,
    limit,
    // Exactly 1 is the single-seat plans (Free and Base). 0 should not occur --
    // no plan maps to it and bootstrap_org writes 1 -- but it is not a team
    // either, so it takes the same branch rather than rendering "0 of 0".
    entitled: limit > 1,
  };
}
