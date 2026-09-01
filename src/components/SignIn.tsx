import {Mail} from 'lucide-react';
import {GoogleMark} from './ui/icons';
import {OTP_CODE_LENGTH, SITE_URL} from '../lib/auth';
import {native} from '../native';
import type {SignIn as SignInState} from '../hooks/useSignIn';

export function SignIn({state}: {state: SignInState}) {
  return (
    <main className="login-shell">
      <section className="login-panel">
        {/* The product's own mark, not a generic padlock. This is the first
            EasyDeck screen anyone sees, and a lucide shield said "some security
            app". Masked from the same PNG the sidebar's .brand-mark uses, so it
            inverts with the theme instead of stamping a plate into the dark
            panel -- see .login-mark in styles.css. */}
        <span className="login-mark" aria-hidden="true" />
        {state.step === 'email' ? <EmailStep state={state} /> : <CodeStep state={state} />}
      </section>
    </main>
  );
}

function EmailStep({state}: {state: SignInState}) {
  return (
    <>
      <h1>Sign in to EasyDeck</h1>
      <p>Cloud account required for profiles, proxies, bookmarks, and shared extensions.</p>
      <button
        type="button"
        className="google-button"
        onClick={() => void state.signInWithGoogle()}
        disabled={state.busy}
      >
        <GoogleMark />
        Continue with Google
      </button>
      <div className="login-divider">
        <span />or<span />
      </div>
      <form className="login-form" onSubmit={(event) => void state.requestCode(event)}>
        <input
          value={state.email}
          onChange={(event) => state.setEmail(event.target.value)}
          placeholder="Email"
          type="email"
          autoComplete="username"
          autoFocus
          required
        />
        {/* Icon and label centred as a pair, to answer the Google button
            directly above it: the two ways in are the same shape, the same
            height and the same alignment, and differ only in their mark. */}
        <button type="submit" disabled={state.busy}>
          <Mail size={16} strokeWidth={2} />
          {state.busy ? 'Sending…' : 'Email me a code'}
        </button>
      </form>
      {state.error && <span className="message error">{state.error}</span>}
      {/* Below both ways in, which is the only position that covers each of
          them: the Google button is outside the form. Mirrors the same line on
          the website's AuthForm -- the two sign-in screens say the same thing in
          the same words, and hooks/useSignIn.ts records the same acceptance. */}
      <div className="login-links">
        <span className="hint">
          No password needed — entering your email creates your account. By continuing you agree
          to our{' '}
          <button type="button" className="link" onClick={() => openLegal('/terms')}>
            Terms of Service
          </button>{' '}
          and{' '}
          <button type="button" className="link" onClick={() => openLegal('/privacy')}>
            Privacy Policy
          </button>
          .
        </span>
      </div>
    </>
  );
}

// Legal pages open in the system browser rather than in the Electron window:
// there is no chrome in here to get back from, and a signed-out user reading the
// Terms should not lose the sign-in panel behind them.
function openLegal(pathname: string) {
  void native?.openExternal?.(`${SITE_URL}${pathname}`);
}

// Google and the divider are deliberately absent here: offering a second way in
// halfway through one flow is how people end up with two half-finished attempts
// and neither completed.
function CodeStep({state}: {state: SignInState}) {
  return (
    <>
      <h1>Check your email</h1>
      <p>We sent a {OTP_CODE_LENGTH}-digit code to {state.email}.</p>
      <form className="login-form" onSubmit={(event) => void state.verifyCode(event)}>
        <input
          type="text"
          className="otp-code"
          value={state.code}
          onChange={(event) =>
            state.setCode(event.target.value.replace(/\D/g, '').slice(0, OTP_CODE_LENGTH))}
          placeholder={`${OTP_CODE_LENGTH}-digit code`}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={OTP_CODE_LENGTH}
          autoFocus
          required
        />
        <button type="submit" disabled={state.busy}>
          {state.busy ? 'Verifying…' : 'Verify and sign in'}
        </button>
      </form>
      {state.error && <span className="message error">{state.error}</span>}
      {!state.error && state.notice && <span className="message">{state.notice}</span>}
      <div className="login-links">
        <button
          type="button"
          className="link"
          onClick={() => void state.requestCode()}
          disabled={state.busy || state.cooldown > 0}
        >
          {state.cooldown > 0 ? `Resend code (${state.cooldown}s)` : 'Resend code'}
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" className="link" onClick={state.backToEmailStep}>
          Use a different email
        </button>
      </div>
    </>
  );
}
