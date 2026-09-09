import type {
  ScoutOrg, BuiltInExtensionToggles, OrgMembership, OrgRole, OrgType,
} from '../types';
import {optionalClient, raise, requireClient} from './client';
import {rowToOrg} from './mappers';
import type {OrganizationRow} from './rows';

// Every column of `organizations` either app reads, in one place.
//
// It is a constant rather than two hand-typed strings because they had drifted
// before: listMyOrgs and getOrg named their columns separately, so a column
// added to one and forgotten in the other produced an org that was complete in
// the switcher and missing a field after a refresh.
//
// PostgREST fails the WHOLE select on an unknown column, and useCloudData loads
// with Promise.allSettled -- so naming a column the database does not have
// turns into "my profiles and proxies are gone" with no clue pointing here.
// Apply the SQL before shipping a build that adds to this list.
const ORG_COLUMNS =
  'id,name,plan,profile_limit,seat_limit,billing_status,current_period_end,created_at,' +
  'built_in_extensions,automation_limit,' +
  // 2026-08-08-org-profile.sql
  'org_type,legal_name,country,website,logo_url,onboarded_at,' +
  // 20260812000000_automations_upgrade.sql
  'telegram_bot_token,telegram_bot_name';

// Every organization the signed-in user belongs to, oldest membership first.
//
// The .eq('user_id') is load-bearing, not belt-and-braces: RLS on org_members
// is is_org_member(org_id), which exposes *every* member of your orgs, not just
// your own row. Without the filter a three-person org would come back three
// times and the switcher would list it three times.
export async function listMyOrgs(): Promise<OrgMembership[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data: userData} = await client.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) {
    return [];
  }
  const {data, error} = await client
      .from('org_members')
      .select(`role, organizations(${ORG_COLUMNS})`)
      .eq('user_id', userId)
      .order('created_at', {ascending: true});
  raise(error, 'listMyOrgs');
  const rows = (data || []) as unknown as Array<{
    role: string;
    organizations: OrganizationRow | null;
  }>;
  return rows
      .filter((row) => Boolean(row.organizations))
      .map((row) => ({
        org: rowToOrg(row.organizations as OrganizationRow),
        role: (row.role as OrgRole) || 'member',
      }));
}

// How many seats the org is using, for the usage meter in Settings. RLS on
// org_members exposes every member of an org you belong to, so this counts the
// whole team rather than just you -- which is the number seat_limit is compared
// against by trg_seat_limit on insert.
export async function countMembers(orgId: string): Promise<number> {
  const client = optionalClient();
  if (!client) {
    return 0;
  }
  const {count, error} = await client
      .from('org_members')
      .select('user_id', {count: 'exact', head: true})
      .eq('org_id', orgId);
  raise(error, 'orgs.countMembers');
  return count || 0;
}

export async function getOrg(orgId: string): Promise<ScoutOrg | null> {
  const client = optionalClient();
  if (!client) {
    return null;
  }
  const {data, error} = await client
      .from('organizations')
      .select(ORG_COLUMNS)
      .eq('id', orgId)
      .maybeSingle();
  raise(error, 'getOrg');
  return data ? rowToOrg(data as unknown as OrganizationRow) : null;
}

// The only way a client can create an organization: `organizations` has no
// INSERT policy and no INSERT grant, so a plain insert is refused by design.
// bootstrap_org is SECURITY DEFINER and idempotent -- it returns the caller's
// existing org when there is one -- which makes it safe to call on every
// sign-in rather than only when the membership list comes back empty.
export async function createOrg(name?: string): Promise<string> {
  const client = requireClient();
  const {data, error} = await client.rpc('bootstrap_org', name ? {org_name: name} : {});
  raise(error, 'bootstrap_org');
  if (!data) {
    throw new Error('bootstrap_org returned no organization id');
  }
  return data as string;
}

// Org-wide settings. As of 20260808000000_active_workspace.sql, RLS restricts
// UPDATE on organizations to is_org_owner -- the workspace's identity is the
// owner's to set -- and the column grant still holds the second line: only
// (name, built_in_extensions, org_type, legal_name, country, website, logo_url,
// industry, onboarded_at) are grantable. plan, the limits and billing_status are
// service-role only, so no client can grant itself a higher tier whatever its
// role.
//
// The one column a member may still write is built_in_extensions, through the
// RPC below -- a policy cannot be scoped to a column, so the exception had to
// become a function.
//
// The .select('id') is the same guard updateProfile and the website's
// saveOrgProfile carry, and it was the one writer here missing it: RLS filters
// rows rather than erroring, so a rename from a non-owner returned
// success-with-no-rows and the name reverted on the next load with nothing
// reported. Callers should gate on isOwner as well -- this is what makes the
// ungated case visible instead of silent.
export async function rename(orgId: string, name: string): Promise<void> {
  const client = requireClient();
  const {data, error} = await client
      .from('organizations')
      .update({name})
      .eq('id', orgId)
      .select('id');
  raise(error, 'orgs.rename');
  if (!data || data.length === 0) {
    throw new Error('Could not rename this workspace. Only its owner can.');
  }
}

// The workspace's notification bot, owner-only like rename and guarded the
// same way -- RLS filters rather than erroring, so success-with-no-rows has to
// be turned back into a sentence here.
export async function setTelegramBot(
    orgId: string, token: string | null, name: string | null): Promise<void> {
  const client = requireClient();
  const {data, error} = await client
      .from('organizations')
      .update({telegram_bot_token: token, telegram_bot_name: name})
      .eq('id', orgId)
      .select('id');
  raise(error, 'orgs.setTelegramBot');
  if (!data || data.length === 0) {
    throw new Error('Could not save the bot. Only the workspace owner can.');
  }
}

// The one org-wide setting any member may change, and the only reason it needs
// a function of its own.
//
// A bundled extension is a shared runtime setting rather than branding, and the
// Extensions tab has let every member toggle one since it shipped. When
// 20260808000000 narrowed organizations_update to is_org_owner it took this
// along with it, because an RLS policy cannot be scoped to a column -- so the
// exception moved into set_built_in_extensions, which checks is_org_member and
// raises rather than filtering.
//
// Raising is the point. The direct UPDATE this replaces needed a .select('id')
// to notice it had changed nothing, because RLS filters rows instead of
// erroring; a toggle that flips locally and reverts on the next load is the
// failure mode that guard existed for. The RPC has no such shape to get wrong.
export async function updateBuiltInExtensions(
    orgId: string, value: BuiltInExtensionToggles): Promise<void> {
  const client = requireClient();
  const {error} = await client.rpc('set_built_in_extensions', {
    p_org: orgId,
    p_value: value,
  });
  raise(error, 'orgs.updateBuiltInExtensions');
}

// Who the workspace belongs to. Written by the setup prompt on first run and by
// Settings afterwards.
//
// A partial: Settings edits one field at a time and the setup prompt writes
// several at once, and a whole-object update would need every caller to hold
// values it has no business knowing. Every key it can carry is in the column
// grant, so a caller cannot smuggle `plan` in through the spread -- Postgres
// refuses the statement outright if it names a column the role cannot update,
// which is a hard failure rather than a silent one.
//
// The .select() serves the same purpose it does above, and one more here: it is
// what surfaces a database that has not had 2026-08-08-org-profile.sql applied.
// Without the grant every write is refused and, because RLS filters rather than
// errors, the form would otherwise report success and change nothing.
export type OrgProfilePatch = {
  org_type?: OrgType | null;
  legal_name?: string | null;
  country?: string | null;
  website?: string | null;
  logo_url?: string | null;
  onboarded_at?: string | null;
  // Carried here rather than through rename() so the setup prompt adopts the
  // business name as the workspace name in the SAME statement that records it.
  // Two writes would leave a window where the workspace is a business with no
  // name, and a failure between them would need reconciling by hand.
  name?: string;
};

export async function updateProfile(orgId: string, patch: OrgProfilePatch): Promise<void> {
  const client = requireClient();
  const {data, error} = await client
      .from('organizations')
      .update(patch)
      .eq('id', orgId)
      .select('id');
  raise(error, 'orgs.updateProfile');
  if (!data || data.length === 0) {
    throw new Error('Could not save the workspace details. You may no longer be a member.');
  }
}

// ── The active workspace ────────────────────────────────────────────────────
//
// Server-side, per user, since 20260808000000_active_workspace.sql. It has to
// be: the website resolves the same question on every request, and a choice
// kept only on this machine meant the launcher and the dashboard could sit in
// different workspaces indefinitely. active_org() is the one definition of the
// answer, shared by both apps and by bootstrap_org.

// What the launcher needs about the account that is not a membership.
//
// `supported` rather than a throw. Builds ship to machines, and a launcher can
// meet a database that has not had this migration applied yet -- PostgREST
// answers an unknown function with PGRST202. That has to degrade to the old
// behaviour (fall back to the local hint) rather than putting a signed-in user
// on the startup loader, which is what an unhandled error here would do.
export type AccountState = {
  activeOrgId: string | null;
  personalPromptAt: string | null;
  supported: boolean;
};

const UNSUPPORTED: AccountState = {
  activeOrgId: null, personalPromptAt: null, supported: false,
};

export async function accountState(): Promise<AccountState> {
  const client = optionalClient();
  if (!client) {
    return UNSUPPORTED;
  }
  const {data, error} = await client.rpc('account_state');
  if (error) {
    if (looksMissing(error)) {
      return UNSUPPORTED;
    }
    raise(error, 'account_state');
  }
  // Set-returning, so PostgREST hands back an array of one.
  const row = (Array.isArray(data) ? data[0] : data) as {
    active_org_id: string | null;
    personal_workspace_prompt_at: string | null;
  } | undefined;
  return {
    activeOrgId: row?.active_org_id || null,
    personalPromptAt: row?.personal_workspace_prompt_at || null,
    supported: true,
  };
}

// A function this build calls that the database does not have. Matched on both
// the PostgREST code and the Postgres one because the same miss arrives
// differently depending on whether the schema cache has been reloaded.
function looksMissing(error: {code?: string; message?: string}): boolean {
  return /PGRST202|42883|does not exist/i.test(`${error.code || ''} ${error.message || ''}`);
}

// Records the switch the user just made. Callers do not await this on the click
// path -- see setOrgId in src/org.tsx -- because what can fail here is agreeing
// with the website, not the switch itself.
export async function setActiveOrg(orgId: string): Promise<void> {
  const client = requireClient();
  const {error} = await client.rpc('set_active_org', {p_org: orgId});
  raise(error, 'set_active_org');
}

// The only path a client has to a SECOND organization, for the same reason
// bootstrap_org is the only path to the first: `organizations` has no INSERT
// policy and no INSERT grant.
//
// One statement creates the org, the owner membership and the active-org row,
// so a failure part-way cannot leave a workspace nobody belongs to. The new
// workspace starts on the free plan with its own billing -- entitlements are
// bought per organization, and the create dialog says so.
export async function createWorkspace(
    name: string, orgType: OrgType | null): Promise<string> {
  const client = requireClient();
  const {data, error} = await client.rpc('create_workspace', {
    p_name: name,
    p_org_type: orgType,
  });
  raise(error, 'create_workspace');
  if (!data) {
    throw new Error('create_workspace returned no organization id');
  }
  return data as string;
}

// Stamped on either answer to "would you like a workspace of your own?" --
// taking it or declining -- so the prompt is asked once and never again.
export async function dismissPersonalWorkspacePrompt(): Promise<void> {
  const client = requireClient();
  const {error} = await client.rpc('dismiss_personal_workspace_prompt');
  raise(error, 'dismiss_personal_workspace_prompt');
}

// The last workspace this machine saw, as an offline hint.
//
// No longer the source of truth -- active_org() is. This is what lets a cold
// start with no network open where the user left off instead of falling back to
// whatever the membership list happens to list first, and it is what carries a
// switch made offline until the next resolve can push it. It loses to the
// server whenever the server can be reached; see resolve() in src/org.tsx.
const ACTIVE_ORG_KEY = 'monti.activeOrgId';

export function currentOrgId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_ORG_KEY);
  } catch {
    return null;
  }
}

export function setCurrentOrgId(orgId: string | null): void {
  try {
    if (orgId) {
      window.localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    } else {
      window.localStorage.removeItem(ACTIVE_ORG_KEY);
    }
  } catch {
    // Private-mode / disabled storage: the switcher still works for this run.
  }
}
