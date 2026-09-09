// The search engine behind both start pages: the launcher's Start page tab and
// the HTML page injected into every anonymous browser session. Kept free of
// React and of any `window` access at import time so homePage.ts -- which builds
// a string, not a component -- can pull SEARCH_ENGINES in without dragging the
// renderer along.
import {normalizeBookmarkUrl} from './bookmarks';

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing';
export type SearchEngine = {id: SearchEngineId; name: string; searchUrl: string};

// `%s` is the query placeholder, the same convention Chromium's TemplateURL
// uses, so these strings could later feed the browser's own default provider
// (scout.default_search_engine) without being rewritten.
export const SEARCH_ENGINES: SearchEngine[] = [
  {id: 'google', name: 'Google', searchUrl: 'https://www.google.com/search?q=%s'},
  {id: 'duckduckgo', name: 'DuckDuckGo', searchUrl: 'https://duckduckgo.com/?q=%s'},
  {id: 'bing', name: 'Bing', searchUrl: 'https://www.bing.com/search?q=%s'},
];

export const DEFAULT_SEARCH_ENGINE = SEARCH_ENGINES[0];

// Per-machine, not per-org: which engine you search with is a personal habit,
// unlike the bookmarks themselves, which are shared workspace state in Supabase.
// Same storage shape as the theme preference in theme.tsx.
const STORAGE_KEY = 'scout.searchEngine';

export function engineById(id: string | null | undefined): SearchEngine {
  return SEARCH_ENGINES.find((engine) => engine.id === id) || DEFAULT_SEARCH_ENGINE;
}

export function readSearchEngine(): SearchEngine {
  try {
    return engineById(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode / storage disabled -- fall through to the default.
    return DEFAULT_SEARCH_ENGINE;
  }
}

export function writeSearchEngine(id: SearchEngineId) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Nothing to do -- the choice still applies for this session, it just will
    // not survive a restart.
  }
}

// Does this look like somewhere to go, or something to look up? The launcher had
// no answer to this before: normalizeBookmarkUrl assumes everything is a url and
// turns `cat pictures` into `https://cat pictures`. That is fine for the bookmark
// editor, where the user is deliberately typing an address, and wrong for a
// search box, where most input is a query.
//
// Deliberately biased toward "query". Guessing wrong toward search costs the user
// one extra click on the engine's own "did you mean" link; guessing wrong toward
// url strands them on a DNS error page.
export function looksLikeUrl(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  // An explicit scheme is the user saying so outright.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return true;
  }
  // No hostname contains a space, so any whitespace settles it.
  if (/\s/.test(trimmed)) {
    return false;
  }
  // Hosts with no dot in them: only the ones that are unambiguously addresses.
  // `localhost:3000` is a url; a bare word like `reddit` is a search, because
  // treating it as a host would break every single-word lookup.
  if (/^localhost(:\d+)?([/?#]|$)/i.test(trimmed) ||
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(trimmed)) {
    return true;
  }
  // Otherwise require something that reads as host + tld. The tld has to be
  // letters, so `2.5` and version numbers stay queries.
  return /^[^\s/?#@]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(trimmed);
}

// What the search box navigates to. Empty input yields '' so callers can skip
// the navigation entirely rather than opening a blank tab.
export function resolveQuery(text: string, engine: SearchEngine) {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  if (looksLikeUrl(trimmed)) {
    return normalizeBookmarkUrl(trimmed);
  }
  return engine.searchUrl.replace('%s', encodeURIComponent(trimmed));
}
