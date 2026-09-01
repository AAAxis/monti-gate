// The sign-in screen's state machine. Two ways in -- a six-digit code emailed
// by Supabase, or Google via PKCE -- plus the deep link that finishes the
// Google half. OrgProvider owns the session itself; this only gets one
// established.
import {useEffect, useRef, useState} from 'react';
import {
  describeAuthError,
  OTP_RESEND_COOLDOWN_MS,
  readPendingOtp,
  SITE_URL,
  writePendingOtp,
} from '../lib/auth';
import {native} from '../native';
import {recordTermsAcceptance} from '../lib/legal';
import {supabase} from '../supabase';
import type {PendingOtp} from '../lib/auth';

export type SignIn = ReturnType<typeof useSignIn>;

export function useSignIn() {
  const [email, setEmail] = useState('');
  // Passwordless sign-in is two steps: ask for a code, then enter it.
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  // Sign-in gets its own error/busy state rather than reusing the app-wide
  // toast: that one self-clears after 5s, which on a login form means a
  // wrong-code error silently disappears mid-read -- exactly when the user is
  // squinting at six digits trying to spot the typo.
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Counts the resend button down. Supabase enforces the same window per
  // address server-side, so this only mirrors what the API will allow.
  useEffect(() => {
    if (!resendAt) {
      return;
    }
    const tick = () => setCooldown(Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [resendAt]);

  // Pick a half-finished sign-in back up after a quit or a reload, so the code
  // already sitting in the user's inbox is still usable.
  useEffect(() => {
    const pending = readPendingOtp();
    if (!pending) {
      return;
    }
    setEmail(pending.email);
    setResendAt(pending.resendAt);
    setStep('code');
  }, []);

  // Step 1. There is no separate "register" any more: Supabase creates the
  // account on the first code request, so this one form is both sign-up and
  // sign-in. That also means it answers identically for an address that exists
  // and one that does not, which is the point -- the old form leaked which
  // emails were registered.
  async function requestCode(event?: {preventDefault: () => void}) {
    event?.preventDefault();
    if (busy) {
      return;
    }
    if (!supabase) {
      setError('Supabase env is missing in .env');
      return;
    }
    const address = email.trim().toLowerCase();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const {error: sendError} = await supabase.auth.signInWithOtp({
        email: address,
        options: {shouldCreateUser: true},
      });
      if (sendError) {
        setError(describeAuthError(sendError));
        return;
      }
      const sentAt = Date.now();
      const pending: PendingOtp = {email: address, resendAt: sentAt + OTP_RESEND_COOLDOWN_MS, sentAt};
      writePendingOtp(pending);
      setEmail(address);
      setResendAt(pending.resendAt);
      setStep('code');
      setNotice(`Code sent to ${address}.`);
    } finally {
      setBusy(false);
    }
  }

  // Step 2. Unlike the Google path, this is not PKCE: POST /verify hands back a
  // session directly, so there is no code to exchange and no deep link in play.
  // OrgProvider's onAuthStateChange picks the session up from here, resolves the
  // user's organizations (bootstrapping one if they have none) and the workspace
  // loads the data.
  async function verifyCode(event?: {preventDefault: () => void}) {
    event?.preventDefault();
    if (busy) {
      return;
    }
    if (!supabase) {
      setError('Supabase env is missing in .env');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      // type 'email' is load-bearing: a new account's code lives in
      // confirmation_token and an existing account's in recovery_token, and
      // 'email' is the only value that resolves to whichever one applies.
      const {data, error: verifyError} = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: code.trim(),
        type: 'email',
      });
      if (verifyError) {
        // Leave the input alone -- people fix one digit.
        setError(describeAuthError(verifyError));
        return;
      }
      // The notice under the button they just pressed, written down. Never
      // throws, and never blocks the sign-in -- see lib/legal.ts.
      await recordTermsAcceptance(data.user);
      writePendingOtp(null);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  function backToEmailStep() {
    setStep('email');
    setCode('');
    setError('');
    setNotice('');
    writePendingOtp(null);
    // resendAt is deliberately left alone: the cooldown is enforced per address
    // by Supabase, so pretending it reset would just produce a 429.
  }

  // Google sign-in, PKCE style (RFC 8252). We ask Supabase for the authorize
  // URL rather than letting it navigate (skipBrowserRedirect), open that in the
  // user's real browser, and Supabase redirects back through the website once
  // Google approves. The code_verifier that matches this request stays in this
  // renderer's storage and is never sent anywhere, so the code that comes back
  // is useless to anyone who intercepts it.
  //
  // We redirect to /auth/desktop rather than straight to monti://auth because a
  // custom scheme is not a page: the OS handler fires, but the browser tab is
  // left on a URL it cannot render and spins forever -- even when sign-in
  // succeeded. /auth/desktop is a real page that forwards the code onward.
  async function signInWithGoogle() {
    if (busy) {
      return;
    }
    if (!supabase) {
      setError('Supabase env is missing in .env');
      return;
    }
    if (!native?.openExternal) {
      setError('Google sign-in needs the desktop app shell. Restart EasyDeck and try again.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const {data, error: oauthError} = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {redirectTo: `${SITE_URL}/auth/desktop`, skipBrowserRedirect: true},
      });
      if (oauthError) {
        setError(oauthError.message);
        return;
      }
      if (!data?.url) {
        setError('Could not start Google sign-in.');
        return;
      }
      const opened = await native.openExternal(data.url);
      if (!opened) {
        setError('Could not open your browser to finish signing in.');
        return;
      }
      setError('Finish signing in with Google in your browser…');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Google sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  // The other half of the flow: the main process hands us whatever came back
  // through monti://. Exchanging the code establishes the session, and
  // OrgProvider's onAuthStateChange takes it from there (including bootstrapping
  // an org for a brand-new account), so there is nothing else to do here.
  //
  // Codes we have already tried. An authorization code is strictly single-use:
  // auth-js drops the stored code_verifier on both the success and the failure
  // path, so a second exchange of the same code always fails -- and used to do
  // it loudly, with a library message about SSR frameworks that means nothing
  // to someone looking at a desktop app. The user gets a repeat delivery
  // whenever they reload the hand-off tab or re-accept the browser's "Open
  // EasyDeck Launcher?" prompt, which is common enough to be the normal case.
  const attemptedAuthCodes = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!native?.onDeepLink) {
      return;
    }
    const unsubscribe = native.onDeepLink((payload) => {
      // Action only -- never the payload, which carries an authorization code.
      console.log('[deep-link] renderer received:', payload.action);
      if (payload.action !== 'auth') {
        return;
      }
      if (payload.error) {
        setError(payload.error);
        return;
      }
      if (!payload.code || !supabase) {
        return;
      }
      if (attemptedAuthCodes.current.has(payload.code)) {
        console.log('[deep-link] ignoring an already-used authorization code');
        return;
      }
      attemptedAuthCodes.current.add(payload.code);
      setBusy(true);
      setError('');
      supabase.auth.exchangeCodeForSession(payload.code)
          .then(async ({data, error: exchangeError}) => {
            if (!exchangeError) {
              // Same record as the email path. The Google button carries the
              // same notice, so the same acceptance has to be written.
              await recordTermsAcceptance(data.user);
            }
            if (exchangeError) {
              console.log('[deep-link] code exchange failed:', exchangeError.code || exchangeError.message);
              // The verifier is gone because this sign-in was already completed,
              // or because signing out cleared it. Either way the fix is the
              // same and it is not what the library's message says it is.
              setError(exchangeError.code === 'pkce_code_verifier_not_found' ?
                  'That sign-in link was already used. Click Continue with Google to start again.' :
                  exchangeError.message);
            }
          })
          .catch((caught: unknown) => {
            setError(caught instanceof Error ? caught.message : 'Could not complete Google sign-in.');
          })
          .finally(() => setBusy(false));
    });
    // Tells the main process we are listening, so a link that arrived during a
    // cold start gets replayed instead of dropped.
    void native.deepLinkReady?.();
    return unsubscribe;
  }, []);

  // Clears the half-finished sign-in a sign-out would otherwise leave behind:
  // without it the next sign-in starts on the code step, waiting for a code
  // that belongs to the session we just ended.
  function reset() {
    writePendingOtp(null);
    setStep('email');
    setCode('');
    setNotice('');
    setError('');
  }

  return {
    email, setEmail,
    step, code, setCode,
    notice, error, busy, cooldown,
    requestCode, verifyCode, backToEmailStep, signInWithGoogle, reset,
  };
}
