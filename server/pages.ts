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
  | { kind: 'file'; file: 'index.html' | 'mod.html' | 'landing.html'; invite?: boolean };

export function pageDecision(path: string, query: string, signedIn: boolean): PageDecision {
  if (!PAGE.test(path)) return { kind: 'none' };
  // The public front page: what the site is, for visitors and search engines.
  if (!signedIn && path === '/') return { kind: 'file', file: 'landing.html' };
  if (!signedIn && !OPEN_PAGE.test(path)) {
    const home = path.replace(/\/$/, '') === '/home';
    return { kind: 'redirect', to: home ? '/signup' : `/signup?next=${encodeURIComponent(path + (query ? `?${query}` : ''))}` };
  }
  if (signedIn && OPEN_PAGE.test(path)) return { kind: 'redirect', to: '/home' };
  if (/^\/signup\/?$/.test(path) && /(^|&)invite=[A-Za-z0-9-]{4,20}(&|$)/.test(query)) return { kind: 'file', file: 'index.html', invite: true };
  return { kind: 'file', file: path === '/mod' ? 'mod.html' : 'index.html' };
}

const INVITE_TITLE = "You're invited to RoleplayRetro";
const INVITE_TEXT = 'A friend invited you to RoleplayRetro: roleplay and chat rooms built for your phone. Tap to join free (18+).';

/** The page for an invite link: same page, with an invitation in its link preview. */
export function inviteShell(html: string, url: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return html
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(INVITE_TITLE)}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc(INVITE_TITLE)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(INVITE_TEXT)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(INVITE_TEXT)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${esc(url)}$2`);
}
