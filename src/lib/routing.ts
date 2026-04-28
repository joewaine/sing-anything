/**
 * Hash-based routing on web so the browser back/forward buttons navigate
 * between screens. Each route serializes to a path like `#/library` or
 * `#/session/<phraseId>`; popstate events are translated back into Route.
 * Noops on native (window is undefined there).
 */

import type { PhraseWithSong } from './phrases';

export type Route =
  | { screen: 'welcome' }
  | { screen: 'library' }
  | { screen: 'upload' }
  | { screen: 'takes' }
  | { screen: 'calibrate' }
  | { screen: 'picker'; songId: string }
  | { screen: 'session'; phraseId: string; phrase: PhraseWithSong | null };

export function routeToPath(route: Route): string {
  switch (route.screen) {
    case 'welcome': return '/';
    case 'library': return '/library';
    case 'upload': return '/upload';
    case 'takes': return '/takes';
    case 'calibrate': return '/calibrate';
    case 'picker': return `/picker/${route.songId}`;
    case 'session': return `/session/${route.phraseId}`;
  }
}

export function pathToRoute(raw: string): Route | null {
  const path = raw.replace(/^#/, '') || '/';
  if (path === '/' || path === '') return { screen: 'welcome' };
  if (path === '/library') return { screen: 'library' };
  if (path === '/upload') return { screen: 'upload' };
  if (path === '/takes') return { screen: 'takes' };
  if (path === '/calibrate') return { screen: 'calibrate' };

  const pickerMatch = path.match(/^\/picker\/([a-zA-Z0-9-]+)$/);
  if (pickerMatch) return { screen: 'picker', songId: pickerMatch[1] };

  const sessionMatch = path.match(/^\/session\/([a-zA-Z0-9-]+)$/);
  if (sessionMatch) return {
    screen: 'session',
    phraseId: sessionMatch[1],
    phrase: null,
  };

  return null;
}

export function currentHashRoute(): Route | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  // Supabase's auth callback puts `access_token=…&…` directly after the `#`.
  // Don't try to parse that as a route — the user just landed from a magic
  // link and we should stay on whatever the default is until supabase
  // finishes consuming the tokens.
  if (
    hash.includes('access_token=') ||
    hash.includes('refresh_token=') ||
    hash.startsWith('error=')
  ) {
    return null;
  }
  return pathToRoute(window.location.hash);
}
