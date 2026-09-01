// Where the account pages live. Two uses: the sign-in screen links out to
// registration and password reset, and Google sign-in redirects back through
// /auth/desktop here so the OAuth flow ends on a page the browser can render
// rather than stranding the user on a spinning tab.
//
// In dev this still points at production unless VITE_SITE_URL is set; point it
// at http://localhost:3000 to exercise the hand-off against a local site.
//
// The main process independently allowlists which hosts it will open, so
// pointing this at some other origin does not widen what can be launched.
export const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined)?.replace(/\/+$/, '') ||
  'https://browser.chatkit.cc';

// Supabase's per-address cooldown between sending one code and the next.
export const OTP_RESEND_COOLDOWN_MS = 60_000;
// Must match Auth -> Providers -> Email -> Email OTP Length in the dashboard.
export const OTP_CODE_LENGTH = 6;
// Must not outlive Email OTP Expiration, or we restore a step whose code is dead.
export const OTP_MAX_AGE_MS = 10 * 60_000;

// A code request that has not been completed yet. Quitting the launcher used to
// throw this away, so reopening it meant retyping the email and getting refused
// by the 60s cooldown -- a dead end that did not exist with passwords, since the
// code sitting in the user's inbox is still perfectly valid.
const PENDING_OTP_KEY = 'monti.pendingOtp';

export type PendingOtp = {email: string; resendAt: number; sentAt: number};

export function readPendingOtp(): PendingOtp | null {
  try {
    const raw = window.localStorage.getItem(PENDING_OTP_KEY);
    if (!raw) {
      return null;
    }
    const pending = JSON.parse(raw) as PendingOtp;
    if (!pending?.email || Date.now() - pending.sentAt > OTP_MAX_AGE_MS) {
      window.localStorage.removeItem(PENDING_OTP_KEY);
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export function writePendingOtp(pending: PendingOtp | null): void {
  try {
    if (pending) {
      window.localStorage.setItem(PENDING_OTP_KEY, JSON.stringify(pending));
    } else {
      window.localStorage.removeItem(PENDING_OTP_KEY);
    }
  } catch {
    // Private-mode / disabled storage: sign-in still works for this run.
  }
}

// GoTrue answers a mistyped code, an expired code and an unknown address with
// the same error on purpose, so one sentence has to cover all three. Switch on
// `code` -- the messages are prose, not API.
export function describeAuthError(error: {code?: string; message: string}): string {
  switch (error.code) {
    case 'otp_expired':
      return 'That code is not valid, or it has expired. Check it and try again, or send a new one.';
    case 'over_email_send_rate_limit':
      return 'Too many codes requested. Wait a minute and try again.';
    case 'over_request_rate_limit':
      return 'Too many attempts. Try again in a few minutes.';
    case 'validation_failed':
    case 'email_address_invalid':
      return 'That email address does not look right.';
    case 'otp_disabled':
      return 'Email sign-in is unavailable right now. Please use Continue with Google.';
    default:
      return error.message;
  }
}
