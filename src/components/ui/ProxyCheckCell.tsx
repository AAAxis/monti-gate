// The result of a proxy check, as one chip.
//
// Shared rather than written per table because a proxy's health is asked in four
// places -- the Proxies tab, the Profiles tab's proxy column, the import review
// table and the proxy editor -- and the three that had their own version said the
// same thing three different ways: bare text here, a coloured span there, and a
// "Failed · <the whole curl error>" that pushed the row to two lines.
//
// A chip instead of text because this column is scanned, not read: the shape and
// the colour carry the verdict, and the detail lives in the title so a table of
// forty proxies stays a table.
import {useEffect, useRef, useState} from 'react';
import {CircleAlert, RefreshCw} from 'lucide-react';
import {CopyButton} from './CopyButton';
import {Popover} from './Popover';
import {FlagIcon} from './icons';
import type {ReactNode} from 'react';
import type {ScoutProxy} from '../../types';

export type ProxyCheckState =
  | {status: 'unchecked'}
  | {status: 'checking'}
  | {status: 'ok'; pingMs?: number; country?: string; countryCode?: string}
  | {status: 'fail'; error?: string};

// Coarse on purpose: a check is a background sweep, and "3h ago" is the only
// resolution anyone acts on. Anything older than a week is a date.
export function sinceLabel(iso: string) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return 'unknown';
  }
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return days <= 7 ? `${days}d ago` : iso.slice(0, 10);
}

// A stored proxy's persisted check, as the chip's state. The six last_* columns
// are written by every check path (background sweep, manual button, import
// review), so a restart shows the same chip the check produced.
export function storedCheckState(proxy: ScoutProxy | null | undefined): ProxyCheckState {
  if (!proxy) {
    return {status: 'unchecked'};
  }
  if (proxy.check_error) {
    return {status: 'fail', error: proxy.check_error};
  }
  if (!proxy.checked_at) {
    return {status: 'unchecked'};
  }
  return {
    status: 'ok',
    pingMs: proxy.ping_ms,
    country: proxy.country,
    countryCode: proxy.country_code,
  };
}

// `age` is the checked_at behind the chip's "checked 13m ago" tooltip. Passed in
// rather than read off the proxy so the import review table -- whose results are
// dialog state and never written to a row -- can use the same chip with no date.
//
// `onRecheck` turns the chip into the way to check again. The Profiles and
// Proxies tables pass it; the import review screen does not (it has its own
// Check-proxies control for rows that are not saved yet), nor does the proxy
// editor (it is checking a draft). Both tables had a manual re-check already
// -- a shield icon among the row's action buttons -- so in each the chip
// replaced the button rather than adding an affordance, and the row lost a
// control (Profiles five to four, Proxies four to three).
export function ProxyCheckCell({state, age, className = '', onRecheck}: {
  state: ProxyCheckState;
  age?: string;
  className?: string;
  onRecheck?: () => void;
}) {
  const classes = (tone: string) => `proxy-check ${tone} ${className}`.trim();

  if (state.status === 'checking') {
    return <span className={classes('checking')}>Checking…</span>;
  }
  if (state.status === 'unchecked') {
    return onRecheck ?
      <RecheckChip className={classes('unchecked')} idle="Not checked" onRecheck={onRecheck} /> :
      <span className={classes('unchecked')}>Not checked</span>;
  }
  if (state.status === 'fail') {
    const error = state.error || 'Proxy check failed';
    // The message is never in the cell. It can be a whole sentence ("Proxy needs
    // a username and password (407 Proxy Authentication Required)"), and a
    // column that grows to fit it is a column that has stopped being scannable.
    //
    // It used to live only in the title, which meant the one text worth pasting
    // into a provider's support chat could be read but not taken -- a tooltip is
    // not selectable. So the chip opens instead, and the panel is where the
    // message and the copy live. The title stays for the hover that just wants
    // to know.
    return (
      // Stops the open click reaching a row that has its own handler. None of
      // today's four call sites do, but this chip is dropped into table rows and
      // that is exactly the kind of thing a later row grows.
      <span className="proxy-check-fail" onClick={(event) => event.stopPropagation()}>
        <Popover
          label="Why this check failed"
          width={320}
          triggerClassName={classes('failed')}
          trigger={
            <>
              <CircleAlert size={12} />
              Failed
            </>
          }
        >
          {(close) => (
            <ProxyFailPanel
              age={age}
              error={error}
              onRecheck={onRecheck && (() => {
                close();
                onRecheck();
              })}
            />
          )}
        </Popover>
      </span>
    );
  }

  // Flag and latency only. It used to read "709 ms · US · 13m ago", which was
  // three facts where the flag already carried one of them: the country is the
  // flag, and it also has its own column in the Proxies table. The age is real
  // information but not what this column is scanned for -- so both move to the
  // title rather than being dropped, and a stale check is still one hover away.
  const detail = typeof state.pingMs === 'number' ? `${state.pingMs} ms` : 'Reachable';
  const title = [
    state.country ? `Egress in ${state.country}` : '',
    age ? `checked ${sinceLabel(age)}` : '',
  ].filter(Boolean).join(' · ');

  if (!onRecheck) {
    return (
      <span className={classes('ok')} title={title || undefined}>
        {state.countryCode && <FlagIcon countryCode={state.countryCode} />}
        {detail}
      </span>
    );
  }

  return (
    <RecheckChip
      className={classes('ok')}
      idle={
        <>
          {state.countryCode && <FlagIcon countryCode={state.countryCode} />}
          {detail}
        </>
      }
      onRecheck={onRecheck}
      title={title || undefined}
    />
  );
}

// Why a check failed, as a card rather than a paragraph with two buttons under
// it.
//
// The three things that were wrong with the paragraph version: the message was
// a 180px scroll box, so a long curl error arrived pre-scrolled and the panel
// had no top edge to read from; the two buttons inherited the global 36px
// --control-h, which is a form control's height in a 320px popover; and they
// sat flush against each other at the right, so "Copy error" and "Re-check"
// read as one segmented control rather than as two unrelated things to do.
//
// So: a title, the message clamped to three lines, the check's age, and the
// actions below a rule with the copy at one end and the remedy at the other.
// The clamp is the part worth explaining -- three lines fits every failure this
// has actually produced (a 407, a refused connection, a DNS miss), and the
// scroll box only ever existed for the pathological curl dump. That case still
// works, it just has to be asked for.
function ProxyFailPanel({age, error, onRecheck}: {
  age?: string;
  error: string;
  onRecheck?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const message = useRef<HTMLParagraphElement>(null);

  // Measured, not guessed at from a character count: the panel is a fixed 320px
  // but the message wraps at whatever the theme's font does, and a threshold
  // picked in characters shows "Show full error" on text that is fully visible
  // about as often as it hides it on text that is not.
  useEffect(() => {
    const node = message.current;
    if (node) {
      setClipped(node.scrollHeight > node.clientHeight + 1);
    }
  }, [error]);

  return (
    <>
      <h4 className="proxy-fail-title">Proxy check failed</h4>
      <p
        className={expanded ? 'proxy-fail-message expanded' : 'proxy-fail-message'}
        ref={message}
        title={error}
      >
        {error}
      </p>
      {clipped && !expanded && (
        <button className="link-button" onClick={() => setExpanded(true)} type="button">
          Show full error
        </button>
      )}
      {age && <p className="proxy-fail-meta">Checked {sinceLabel(age)}</p>}
      <div className="proxy-fail-actions">
        <CopyButton className="ghost proxy-fail-btn" value={error} label="Copy error" />
        {/* A failed chip keeps saying "Failed" on hover rather than swapping to
            Re-check the way a healthy one does: the message is the reason
            anyone opens this, and a chip that hides the verdict behind the
            remedy makes the column unscannable. So the remedy lives in here,
            beside the message it answers. */}
        {onRecheck && (
          <button className="ghost proxy-fail-btn" onClick={onRecheck} type="button">
            <RefreshCw size={14} /> Re-check
          </button>
        )}
      </div>
    </>
  );
}

// A chip that says what it knows, and says what it can do about it while the
// pointer is over the chip itself.
//
// The swap is CSS, not state: two spans stacked in the same box, one of which
// is hidden. Both are always laid out, and the box takes a min-width sized for
// the longer of the two -- so the column's width never depends on where the
// pointer is. Doing this by swapping the text would resize the cell on hover,
// and under `table-layout: auto` resizing one cell re-lays-out every column in
// the table at once.
function RecheckChip({className, idle, onRecheck, title}: {
  className: string;
  idle: ReactNode;
  onRecheck: () => void;
  title?: string;
}) {
  return (
    <button
      className={`${className} proxy-check-action`}
      onClick={(event) => {
        event.stopPropagation();
        onRecheck();
      }}
      title={title}
      type="button"
    >
      <span className="proxy-check-idle">{idle}</span>
      <span className="proxy-check-recheck"><RefreshCw size={12} /> Re-check</span>
    </button>
  );
}
