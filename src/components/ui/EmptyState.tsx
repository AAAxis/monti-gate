// The message a table shows in place of its rows: this filter matched nothing,
// this folder is empty, Trash is empty. `hero` is the same parts with more room
// and a heavier glyph, for the Team tab, whose empty roster and plan gate are
// not in a table but are still a block under a toolbar rather than the screen.
//
// Not for a tab whose whole collection is empty -- that drops the toolbar and
// the table with it, and is .tab-empty in styles.css. Profiles, Proxies,
// Cookies and Automations all render that directly; it is a fixed distance
// below the topbar so its glyph lands where the Start page's Scout Web mark does.
//
// Lifted out of ProfilesTab when the Proxies tab grew the same states.
import type {ReactNode} from 'react';

export function EmptyState({icon, title, body, hero, children}: {
  icon: ReactNode;
  title: string;
  body: string;
  hero?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={hero ? 'table-empty hero' : 'table-empty'}>
      <span className="table-empty-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{body}</p>
      {children && <div className="table-empty-actions">{children}</div>}
    </div>
  );
}
