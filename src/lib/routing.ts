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
  | { screen: 'picker'; songId: string }
  | { screen: 'session'; phraseId: string; phrase: PhraseWithSong | null };

export function routeToPath(route: Route): string {
  switch (route.screen) {
    case 'welcome': return '/';
    case 'library': return '/library';
    case 'upload': return '/upload';
    case 'picker': return `/picker/${route.songId}`;
    case 'session': return `/session/${route.phraseId}`;
  }
}

export function pathToRoute(raw: string): Route | null {
  const path = raw.replace(/^#/, '') || '/';
  if (path === '/' || path === '') return { screen: 'welcome' };
  if (path === '/library') return { screen: 'library' };
  if (path === '/upload') return { screen: 'upload' };

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
  return pathToRoute(window.location.hash);
}
