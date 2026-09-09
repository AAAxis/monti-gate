import {describe, expect, it} from 'vitest';
import {seatCap} from './limit';
import type {ScoutOrg} from '../types';

function org(seat_limit: number | null): ScoutOrg {
  return {
    id: 'org-1',
    name: 'Test',
    plan: 'pro',
    profile_limit: 300,
    seat_limit: seat_limit as number,
    billing_status: 'active',
  };
}

describe('seatCap', () => {
  // The regression this whole shape exists for. automations/limit.ts shipped
  // with `?? 0` on a still-loading org and told users their plan was the
  // problem; here the same bug would put the upsell hero in front of a paying
  // team on every cold start.
  it('says nothing at all while the org is still loading', () => {
    expect(seatCap(null, 0)).toEqual(
        {loading: true, atCap: false, used: 0, limit: null, entitled: false});
    expect(seatCap(undefined, 3, 1).loading).toBe(true);
  });

  it('does not treat a loading org as unentitled', () => {
    // Both false, and `loading` is what callers must branch on first.
    expect(seatCap(undefined, 0).entitled).toBe(false);
    expect(seatCap(undefined, 0).atCap).toBe(false);
  });

  it('counts pending invites against the limit, not just members', () => {
    // The reservation rule create_org_invite enforces: two members and two
    // outstanding invites fill a four-seat plan, even though only two people
    // have actually joined.
    expect(seatCap(org(4), 2, 2)).toMatchObject({atCap: true, used: 4, limit: 4});
    expect(seatCap(org(4), 2, 1)).toMatchObject({atCap: false, used: 3});
  });

  it('is under cap with seats to spare', () => {
    expect(seatCap(org(10), 3)).toEqual(
        {loading: false, atCap: false, used: 3, limit: 10, entitled: true});
  });

  it('treats a null limit as unlimited rather than as zero', () => {
    expect(seatCap(org(null), 99, 5)).toEqual(
        {loading: false, atCap: false, used: 104, limit: null, entitled: true});
  });

  it('is unentitled at exactly one seat -- Free and Base', () => {
    const cap = seatCap(org(1), 1);
    expect(cap.entitled).toBe(false);
    // At cap too, which is what disables Invite behind the upsell.
    expect(cap.atCap).toBe(true);
  });

  it('treats a zero limit as unentitled, not as unlimited', () => {
    // Should be unreachable -- no plan maps to 0 and bootstrap_org writes 1 --
    // but 0 must not take the null/unlimited branch, which is the exact bug
    // PlanUsageSection's Meter had to be fixed for.
    expect(seatCap(org(0), 0).entitled).toBe(false);
    expect(seatCap(org(0), 0).limit).toBe(0);
  });
});
