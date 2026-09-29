/**
 * Which page to serve for an address, and who may see it. The site is members only:
 * without an account, every page sends you to sign up (remembering where you were going),
 * except the sign-up and log-in pages themselves.
 */

const PAGE = /^\/(|home|rooms|room\/[a-z0-9-]+(\/manage)?|new-room|edit-profile|people|admin|friends|messages(\/[A-Za-z0-9_]{3,16})?|profile\/[A-Za-z0-9_]{3,16}(\/(photos|comments|trophies|friends|gifts|gift))?|profile-views|gifts|photo\/\d{1,19}|settings(\/[a-z-]+)?|login|signup|verify|mod)\/?$/;
const OPEN_PAGE = /^\/(signup|login)\/?$/;

export type PageDecision =
  | { kind: 'none' }
  | { kind: 'redirect'; to: string }
  | { kind: 'file'; file: 'index.html' | 'mod.html' };

export function pageDecision(path: string, query: string, signedIn: boolean): PageDecision {
  if (!PAGE.test(path)) return { kind: 'none' };
  if (!signedIn && !OPEN_PAGE.test(path)) {
    const home = path === '/' || path.replace(/\/$/, '') === '/home';
    return { kind: 'redirect', to: home ? '/signup' : `/signup?next=${encodeURIComponent(path + (query ? `?${query}` : ''))}` };
  }
  if (signedIn && OPEN_PAGE.test(path)) return { kind: 'redirect', to: '/home' };
  return { kind: 'file', file: path === '/mod' ? 'mod.html' : 'index.html' };
}
