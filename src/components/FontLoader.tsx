import { useEffect } from 'react';
import { Platform } from 'react-native';

const MARKER = 'data-sing-beatles-fonts';

/**
 * Mount-once effect that injects the Google Font link for VT323 and a tiny
 * global CSS reset so the retro-Mac aesthetic renders correctly (backdrop
 * colour, no font smoothing). Web-only; no-op on native.
 */
export default function FontLoader(): null {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    if (document.querySelector(`link[${MARKER}]`)) return;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=VT323&display=swap';
    link.setAttribute(MARKER, 'true');
    document.head.appendChild(link);

    const style = document.createElement('style');
    style.setAttribute(MARKER, 'true');
    style.textContent = `
      html, body, #root { margin: 0; padding: 0; background: #e5e5e5; }
      body { -webkit-font-smoothing: none; -moz-osx-font-smoothing: grayscale; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #000; }
      * { -webkit-tap-highlight-color: transparent; }
      ::-webkit-scrollbar { width: 12px; background: #fff; border-left: 1px solid #000; }
      ::-webkit-scrollbar-thumb { background: #fff; border: 1px solid #000; }
    `;
    document.head.appendChild(style);
  }, []);
  return null;
}
