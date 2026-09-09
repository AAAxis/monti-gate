// Recording that somebody agreed to the Terms, desktop half.
//
// This is the mirror of landing/lib/legal.ts. The two write the same two keys
// with the same values, because an account can be created on either surface --
// the website has /signup, and this sign-in screen creates an account on the
// first email code -- and a person who accepted on one must not be asked again
// on the other, nor be recorded as never having accepted at all.
//
// LEGAL_VERSION must equal the constant of the same name in landing/lib/site.ts.
// It is duplicated rather than shared because these are separate repositories
// with no common package; change one, change the other.
//
// LIMITATION, same as the web: user_metadata is writable by the user it belongs
// to, so this is evidence of the ordinary case and not proof against a hostile
// one. What forms the agreement is the notice on the sign-in panel.
import type {User} from '@supabase/supabase-js';
import {supabase} from '../supabase';

// `scout_`-namespaced for the same reason as the avatar and display-name keys
// in db/account.ts: Supabase refreshes user_metadata from the identity provider
// on every Google sign-in, so a key Google also owns is liable to be replaced.
export const TERMS_ACCEPTED_KEY = 'scout_terms_accepted_at';
export const TERMS_VERSION_KEY = 'scout_terms_version';

export const LEGAL_VERSION = '2026-08-05';

/**
 * Record acceptance of the current Terms for the user who has just signed in.
 *
 * A no-op when the stored version already matches, so a returning user keeps
 * the date on which they first accepted this text.
 *
 * Never throws. Failing to record consent must not strand somebody outside an
 * account they have just proved they own.
 */
export async function recordTermsAcceptance(user: User | null | undefined): Promise<void> {
  if (!supabase || !user) {
    return;
  }
  const metadata = (user.user_metadata || {}) as Record<string, unknown>;
  if (metadata[TERMS_VERSION_KEY] === LEGAL_VERSION) {
    return;
  }
  try {
    const {error} = await supabase.auth.updateUser({
      data: {
        [TERMS_ACCEPTED_KEY]: new Date().toISOString(),
        [TERMS_VERSION_KEY]: LEGAL_VERSION,
      },
    });
    if (error) {
      console.log('[legal] could not record terms acceptance:', error.message);
    }
  } catch (caught) {
    console.log('[legal] recording terms acceptance threw:', caught);
  }
}
