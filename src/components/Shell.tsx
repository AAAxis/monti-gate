// The persistent chrome: the sidebar rail, the topbar, and the corner toasts.
import {PanelLeftClose, PanelLeftOpen, X} from 'lucide-react';
import {InboxBell} from './InboxBell';
import {WorkspaceSwitcher} from './WorkspaceSwitcher';
import {tabs} from '../data/tabs';
import {native} from '../native';
import type {ReactNode} from 'react';
import type {TabId} from '../data/tabs';
import type {ResourceState, UpdateState} from '../native';

export function Sidebar({activeTab, onTab, onSettings, onSignOut, onCreateWorkspace, onLeaveWorkspace,
  collapsed, onToggleCollapsed, newCounts}: {
  activeTab: TabId;
  onTab: (tab: TabId) => void;
  onSettings: () => void;
  onSignOut: () => void;
  onCreateWorkspace: () => void;
  onLeaveWorkspace: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  // How many rows on each tab arrived since this machine last looked at it --
  // see useNewArrivals. Only the four list tabs ever have an entry, and only
  // when the number is above zero, so the badge below is a plain truthiness
  // check rather than a roster of which tabs are allowed one.
  //
  // Optional because preview-sidebar.tsx mounts this component with fixtures,
  // and a rail with no arrivals is a state the real app spends most of its time
  // in anyway.
  newCounts?: Partial<Record<TabId, number>>;
}) {
  const rail = tabs;
  return (
    <aside className="sidebar">
      {/* The mark alone -- the window title already says "Scout Web Launcher", so
          the wordmark was saying it twice. Alpha-masked PNG, tinted by the
          stylesheet so it inverts cleanly in dark mode.

          Collapsed, the mark and the toggle are the same 40px button: a 64px
          rail has room for exactly one thing at the top, and spending it on a
          chevron rather than the mark would trade the app's identity for a
          control needed once. The mark swaps for the glyph on hover or keyboard
          focus -- see .rail-toggle in styles.css; the swap is CSS so it cannot
          get out of step with :hover, and the mark is aria-hidden there because
          the button already says what it does. */}
      <div className="brand">
        {collapsed ? (
          <button
            aria-expanded={false}
            aria-label="Expand sidebar"
            className="rail-toggle is-brand"
            onClick={onToggleCollapsed}
            title="Expand sidebar"
            type="button"
          >
            <span aria-hidden="true" className="brand-mark" />
            <PanelLeftOpen className="rail-toggle-glyph" size={18} strokeWidth={1.75} />
          </button>
        ) : (
          <>
            <span className="brand-mark" role="img" aria-label="Scout Web" />
            <button
              aria-expanded={true}
              aria-label="Collapse sidebar"
              className="rail-toggle"
              onClick={onToggleCollapsed}
              title="Collapse sidebar"
              type="button"
            >
              <PanelLeftClose size={18} strokeWidth={1.75} />
            </button>
          </>
        )}
      </div>
      <nav>
        {rail.map((tab) => {
          const added = newCounts?.[tab.id] || 0;
          return (
            <button
              aria-current={activeTab === tab.id ? 'page' : undefined}
              // Unconditional, not `collapsed && …`: .nav-label is hidden with
              // display: none, which takes the label out of the accessibility tree
              // along with it. The title is conditional because a tooltip
              // repeating a label you can already read is noise.
              //
              // The count joins the label rather than the title, for both of the
              // same reasons: a title would not be read out, and collapsed the
              // title is the only thing naming the tab at all.
              aria-label={added ? `${tab.label}, ${added} added since you last looked` : tab.label}
              className={activeTab === tab.id ? 'active' : ''}
              key={tab.id}
              onClick={() => onTab(tab.id)}
              title={collapsed ? tab.label : undefined}
            >
              <tab.icon size={16} strokeWidth={1.75} />
              <span className="nav-label">{tab.label}</span>
              {/* Outside .nav-label deliberately: that span is display: none in
                * the collapsed rail, and a count that vanished with the label
                * would go missing exactly when the icon is all there is to read.
                * aria-hidden because the button's own aria-label already says
                * the number in a sentence. */}
              {added > 0 && (
                <span aria-hidden="true" className="nav-count">{added > 9 ? '9+' : added}</span>
              )}
            </button>
          );
        })}
      </nav>
      {/* Was a row that opened Settings and showed who you were signed in as.
          It is now the workspace switcher, and Settings is one entry inside it
          -- see the header of WorkspaceSwitcher.tsx for why round that way. */}
      <WorkspaceSwitcher
        collapsed={collapsed}
        onCreate={onCreateWorkspace}
        onLeave={onLeaveWorkspace}
        onSettings={onSettings}
        onSignOut={onSignOut}
      />
    </aside>
  );
}

export function Topbar({activeTab, actions, onViewShares, onOpenAutomationHistory}: {
  activeTab: TabId;
  actions: ReactNode;
  onViewShares: () => void;
  onOpenAutomationHistory: (automationId: string) => void;
}) {
  return (
    <header className="topbar">
      {/* The title alone. There used to be a line under it -- "Scout Web Launcher
          owns cloud data. Scout Web Browser starts as a separate anonymous
          process." -- which was the same sentence on all nine tabs, so it said
          nothing about the one you were on and was read once and then never
          again. */}
      <h1>{tabs.find((tab) => tab.id === activeTab)?.label}</h1>
      <div className="actions">
        {/* Left of the tab's own actions: what somebody has sent you is not an
            action on the current tab, and it should not move when the tab
            changes. Renders nothing at all when the inbox is empty, which is
            most of the time. */}
        <InboxBell
          onViewAll={onViewShares}
          onOpenAutomationHistory={onOpenAutomationHistory}
        />
        {/* The org <select> that used to sit here has moved to the sidebar. It
            only appeared once you were already in two workspaces, so the one
            group who could not find it were the people who had just been
            invited into their first. */}
        {actions}
      </div>
    </header>
  );
}

// The corner toast prompting an available/downloading/downloaded update. Lives
// in the shared .toast-stack alongside the status toast so the two stack
// instead of overlapping when both are visible at once.
//
// Dismissal is tracked per version so closing it does not hide a later,
// different update forever. Before this existed, an available update only ever
// showed up as a one-line status buried in Settings, so it was easy to sit on
// an old, unpatched build indefinitely without ever knowing.
export function UpdateToast({state, resourceState, dismissedVersion, onDismiss}: {
  state: UpdateState | null;
  // The browser's own update, which this used to be silent about entirely --
  // so a waiting browser build was invisible unless you opened Settings and
  // went looking. Both programs get the same corner notice now.
  resourceState: ResourceState | null;
  dismissedVersion: string;
  onDismiss: (version: string) => void;
}) {
  const launcherWaiting = state &&
    ['available', 'downloading', 'downloaded'].includes(state.status);
  const browserWaiting = resourceState?.updateAvailable &&
    resourceState.browserStatus === 'ready';

  // The launcher takes precedence when both are waiting: it is the one whose
  // install closes windows, so it is the one worth interrupting for. The
  // browser's notice reappears on the next render once the launcher's is gone.
  if (launcherWaiting) {
    const version = state?.updateInfo?.version || '';
    if (dismissedVersion === version) {
      return null;
    }
    return (
      <div className="update-toast">
        <div className="update-toast-body">
          <strong>
            {state?.status === 'downloaded' ?
              `Launcher ${version} downloaded — restart to install` :
              state?.status === 'downloading' ?
                `Downloading launcher update… ${Math.round(state.progress?.percent || 0)}%` :
                `Launcher update ${version} available`}
          </strong>
        </div>
        <div className="update-toast-actions">
          {state?.status === 'available' && (
            <button onClick={() => native?.downloadUpdate?.()}>Download</button>
          )}
          {state?.status === 'downloaded' && (
            <button onClick={() => native?.installUpdate?.()}>Restart &amp; install</button>
          )}
          <button
            className="icon-button"
            aria-label="Dismiss update notice"
            onClick={() => onDismiss(version || 'unknown')}
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  if (!browserWaiting) {
    return null;
  }
  const browserVersion = resourceState?.availableVersion || '';
  if (dismissedVersion === browserVersion) {
    return null;
  }
  return (
    <div className="update-toast">
      <div className="update-toast-body">
        <strong>Browser update {browserVersion} available</strong>
      </div>
      <div className="update-toast-actions">
        <button onClick={() => native?.downloadBrowserResource?.()}>Update</button>
        <button
          className="icon-button"
          aria-label="Dismiss update notice"
          onClick={() => onDismiss(browserVersion || 'unknown')}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
