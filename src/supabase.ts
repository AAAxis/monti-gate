import {createClient} from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase = supabaseUrl && supabaseAnonKey ?
  createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Required for Google sign-in. auth-js defaults to 'implicit', which
      // returns tokens in a URL fragment -- unusable here, because the callback
      // comes back through an scout:// deep link handled by the OS. PKCE
      // instead returns a short-lived code that we exchange using a verifier
      // this client keeps locally and never transmits.
      flowType: 'pkce',
    },
  }) :
  null;
