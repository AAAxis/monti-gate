// Where you are working, and how to go somewhere else.
//
// It replaces the sidebar's account row, and the swap is the point rather than a
// side effect. That row answered "who am I signed in as", which is a question
// nobody asks twice; the question people were actually getting wrong is which
// workspace they are looking at. Being in more than one is now ordinary --
// accepting an invitation puts you in a second, and you keep your own -- and
// before this the only way to change workspace was a bare <select> in the
// topbar that appeared solely for people who were already in two, so a new
// member had no way to discover the concept at all.
//
// Lives here rather than under components/ui/ because it reads useOrg: it is
// chrome that knows about the app, not a primitive. Every action is raised to
// App, which already owns all thirty-odd dialogs.
import {Check, ChevronsUpDown, DoorOpen, LogOut, Plus, Settings} from 'lucide-react';
import {Popover} from './ui/Popover';
import {initials, workspaceName} from '../lib/text';
import {planLabel} from '../plans';
import {useOrg} from '../org';
import type {ScoutOrg} from '../types';

// Wide enough for "Simnetiq LTD" plus "Owner · Team" without wrapping, and
// narrow enough that the panel still left-aligns to a 236px rail: Popover
// right-aligns by default, falls back to left-aligning when that would run off
// the window, and at this width against this rail it always takes the fallback.
const PANEL_WIDTH = 252;

export function WorkspaceSwitcher({onSettings, onSignOut, onCreate, onLeave, collapsed}: {
  onSettings: () => void;
  onSignOut: () => void;
  onCreate: () => void;
  onLeave: () => void;
  collapsed: boolean;
}) {
  const org = useOrg();
  const name = workspaceName(org.org?.name);
  return (
    <div className="account">
      <Popover
        label={`${name} — switch workspace`}
        panelClassName="workspace-pop"
        triggerClassName={collapsed ?
          'account-row account-trigger workspace-trigger is-collapsed' :
          'account-row account-trigger workspace-trigger'}
        width={PANEL_WIDTH}
        // Collapsed, the mark stands alone: the name and the email are the two
        // things a 64px rail has no room for, and the mark is the one that
        // answers "whose data am I looking at" without them. The chevron goes
        // too -- a lone chip at the foot of an icon rail is already read as
        // something to press, and at 40px wide it and the mark cannot both fit
        // without shrinking the mark to nothing.
        //
        // Nothing about the panel changes. Popover right-aligns and falls back
        // to left when that would run off the window, so from this rail it takes
        // the fallback and opens outward unaided.
        trigger={collapsed ? (
          <WorkspaceMark org={org.org} name={name} />
        ) : (
          <>
            <WorkspaceMark org={org.org} name={name} />
            <span className="workspace-lines">
              <strong>{name}</strong>
              <small>{org.email}</small>
            </span>
            {/* Always visible, unlike the gear it replaces. That gear could hide
                until hover because the row's job was already stated by its
                label; a chevron is the only thing saying this row is a menu. */}
            <ChevronsUpDown className="workspace-chevron" size={14} strokeWidth={1.75}
              aria-hidden="true" />
          </>
        )}
      >
        {(close) => (
          <>
            <div className="workspace-pop-group">
              <h4>Workspaces</h4>
              <div aria-label="Workspaces" className="workspace-pop-list" role="listbox">
                {org.orgs.map(({org: item, role}) => {
                  const active = item.id === org.orgId;
                  const label = workspaceName(item.name);
                  return (
                    <button
                      aria-selected={active}
                      className={active ? 'workspace-pop-item active' : 'workspace-pop-item'}
                      key={item.id}
                      onClick={() => {
                        // Guarded so re-picking the workspace you are already in
                        // is inert. Without it setOrgId writes and every consumer
                        // re-keys -- WorkspaceProvider drops the selection and
                        // reloads fourteen tables -- to arrive back where it was.
                        if (!active) {
                          org.setOrgId(item.id);
                        }
                        close();
                      }}
                      role="option"
                      type="button"
                    >
                      <WorkspaceMark org={item} name={label} />
                      <span className="workspace-pop-lines">
                        <strong>{label}</strong>
                        <small>{role === 'owner' ? 'Owner' : 'Member'} · {planLabel(item.plan)}</small>
                      </span>
                      {active && <Check className="workspace-pop-tick" size={14} strokeWidth={2.5} />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="workspace-pop-group">
              <h4>Account</h4>
              <button className="workspace-pop-item" type="button"
                onClick={() => {
                  close();
                  onCreate();
                }}>
                <Plus size={16} strokeWidth={1.75} /> Create workspace
              </button>
              <button className="workspace-pop-item" type="button"
                onClick={() => {
                  close();
                  onSettings();
                }}>
                <Settings size={16} strokeWidth={1.75} /> Settings
              </button>
              {/* Hidden for an owner rather than shown and disabled. The delete
                  policy on org_members carries `role <> 'owner'`, so an owner
                  leaving is not a permission they lack -- it is not a thing that
                  exists -- and a greyed row is an invitation to ask support how
                  to turn it on. */}
              {!org.isOwner && org.orgId && (
                <button className="workspace-pop-item" type="button"
                  onClick={() => {
                    close();
                    onLeave();
                  }}>
                  <DoorOpen size={16} strokeWidth={1.75} /> Leave workspace
                </button>
              )}
              <button className="workspace-pop-item" type="button"
                onClick={() => {
                  close();
                  onSignOut();
                }}>
                <LogOut size={16} strokeWidth={1.75} /> Sign out
              </button>
            </div>
          </>
        )}
      </Popover>
    </div>
  );
}

// The workspace's logo, or its initials.
//
// A rounded square rather than the circle the account avatar used: this is a
// company mark, and a logo cropped to a circle loses its corners. object-fit is
// `contain` for the same reason -- a wordmark cropped to fill is unreadable,
// where a person's photo is not.
function WorkspaceMark({org, name}: {org: ScoutOrg | null; name: string}) {
  if (org?.logo_url) {
    return (
      <img alt="" className="workspace-mark" referrerPolicy="no-referrer" src={org.logo_url} />
    );
  }
  return <span className="workspace-mark">{initials(name)}</span>;
}
