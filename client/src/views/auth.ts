import { AGE, PASSWORD_MIN, SITE_NAME } from '../../../shared/config.js';
import type { LoginResult, MeDTO } from '../../../shared/types.js';
import { connect, field, form, navigate, page, state, applyPrefs, toast } from '../core.js';
import { api, h } from '../dom.js';
import { formatInviteCode, normalizeInviteCode } from '../../../shared/trophies.js';

/** Where to go after joining or logging in: the page they were headed to (same-site only), else Home. */
export function nextPage(): string {
  const n = new URLSearchParams(location.search).get('next') ?? '';
  return /^\/(?!\/)[A-Za-z0-9/_\-.?=&%]*$/.test(n) && !/^\/(signup|login)\b/.test(n) ? n : '/home';
}
/** Carry ?next= along between the sign-up and log-in pages. */
const withNext = (path: string) => {
  const n = nextPage();
  return n === '/home' ? path : `${path}?next=${encodeURIComponent(n)}`;
};

function signedIn(me: MeDTO, to = nextPage()) {
  state.me = me;
  applyPrefs(me.prefs);
  connect();
  navigate(to, true);
}

export function viewLogin() {
  let ticket: string | null = null;
  const passwordStep = form(
    [
      field('Name', 'handle', 'text', { autocomplete: 'username', maxlength: 16, autocapitalize: 'off' }),
      field('Password', 'password', 'password', { autocomplete: 'current-password' }),
    ],
    'Log in',
    async (d) => {
      const r = await api<LoginResult>('/api/login', { body: { handle: d.get('handle'), password: d.get('password') } });
      if (r.twoFactorTicket) {
        ticket = r.twoFactorTicket;
        passwordStep.hidden = true;
        codeStep.hidden = false;
        codeStep.querySelector('input')?.focus();
      } else if (r.me) signedIn(r.me);
    },
  );
  const codeStep = form(
    [
      h('p', {}, 'Enter the code from your authenticator app, or a backup code.'),
      field('Code', 'code', 'text', { autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 12 }),
    ],
    'Verify',
    async (d) => {
      const r = await api<LoginResult>('/api/login/2fa', { body: { ticket, code: String(d.get('code')).trim() } });
      if (r.me) signedIn(r.me);
    },
  );
  codeStep.hidden = true;
  page('Log in',
    h('div', { class: 'card hero' }, h('h1', {}, `Welcome to ${SITE_NAME}`), h('p', { class: 'muted' }, 'Roleplay and chat rooms, built for your phone.')),
    h('section', { class: 'card' }, passwordStep, codeStep),
    h('p', { class: 'center' }, 'New here? ', h('a', { href: withNext('/signup') }, 'Create an account')));
}

/** Invite codes are ABCD-EFGH: uppercase as you type, and put the dash in for you. */
function autoDashInvite(input: HTMLInputElement) {
  input.addEventListener('input', () => {
    const caret = input.selectionStart ?? input.value.length;
    const before = normalizeInviteCode(input.value.slice(0, caret)).length; // code characters before the caret
    const code = normalizeInviteCode(input.value).slice(0, 8);
    const shown = code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    if (shown === input.value) return;
    input.value = shown;
    const pos = Math.min(shown.length, before > 4 ? before + 1 : before);
    input.setSelectionRange(pos, pos);
  });
}

export function viewSignup() {
  // An invite link (/signup?invite=ABCD-EFGH) fills in the code.
  const invite = formatInviteCode(normalizeInviteCode(new URLSearchParams(location.search).get('invite') ?? '').slice(0, 8));
  const max = new Date();
  max.setFullYear(max.getFullYear() - AGE.minimum);
  const inviteField = field('Invite code (optional)', 'inviteCode', 'text', { required: false, maxlength: 9, autocapitalize: 'characters', autocomplete: 'off', inputmode: 'text', spellcheck: false, placeholder: 'ABCD-EFGH', value: invite });
  autoDashInvite(inviteField.querySelector('input')!);
  const signupForm = form(
    [
      field('Name (3–16 letters, - or _)', 'handle', 'text', { pattern: '[A-Za-z][A-Za-z_\\-]{1,14}[A-Za-z]', title: 'Letters, hyphens (-) and underscores (_) only; must start and end with a letter', maxlength: 16, autocomplete: 'username', autocapitalize: 'off' }),
      h('p', { class: 'hint' }, 'Your name is permanent, and nobody can copy it.'),
      field('Email', 'email', 'email', { autocomplete: 'email' }),
      field(`Birthday (${AGE.minimum}+)`, 'birthdate', 'date', { max: max.toISOString().slice(0, 10), autocomplete: 'bday' }),
      inviteField,
      h('label', { class: 'adult-confirm' }, h('input', { type: 'checkbox', name: 'adult', required: true }), ` I confirm I am ${AGE.minimum} or older.`),
      field(`Password (${PASSWORD_MIN}+ characters)`, 'password', 'password', { minlength: PASSWORD_MIN, autocomplete: 'new-password' }),
      field('Confirm password', 'password2', 'password', { minlength: PASSWORD_MIN, autocomplete: 'new-password' }),
    ],
    'Create account',
    async (d) => {
      if (d.get('password') !== d.get('password2')) throw new Error("The passwords don't match. Type the same password in both boxes.");
      const me = await api<MeDTO>('/api/signup', {
        body: { handle: d.get('handle'), email: d.get('email'), password: d.get('password'), birthdate: d.get('birthdate'), inviteCode: String(d.get('inviteCode') ?? '') || undefined, acceptTerms: true },
      });
      signedIn(me, nextPage() === '/home' ? '/verify' : `/verify?next=${encodeURIComponent(nextPage())}`);
    },
  );
  signupForm.append(h('p', { class: 'terms-note' }, `By creating an account, you agree to ${SITE_NAME}'s `,
    h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms of Service'), ' and acknowledge our ',
    h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy'), '.'));
  page('Sign up',
    h('div', { class: 'card hero' }, h('h1', {}, `Welcome to ${SITE_NAME}`),
      h('p', { class: 'muted' }, `Roleplay and chat rooms for your phone. Adults only (${AGE.minimum}+).`)),
    h('section', { class: 'card' }, signupForm),
    h('p', { class: 'center' }, 'Already a member? ', h('a', { href: withNext('/login') }, 'Log in')));
}

export function viewVerify() {
  if (state.me?.emailVerified) return navigate(nextPage(), true);
  page('Confirm email',
    h('section', { class: 'card' },
      h('p', {}, `We sent a 6-digit code to ${state.me?.email ?? 'your email'}. It works for 15 minutes.`),
      form([field('Code', 'code', 'text', { inputmode: 'numeric', pattern: '\\d{6}', maxlength: 6, autocomplete: 'one-time-code' })], 'Confirm', async (d) => {
        await api('/api/verify/email', { body: { code: String(d.get('code')).trim() } });
        state.me = await api<MeDTO>('/api/me');
        state.flash = 'Email confirmed. Every room is open to you now.';
        navigate(nextPage(), true);
      }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'quiet', onclick: (async () => {
          try { await api('/api/verify/resend', { body: {} }); toast('New code sent. Check your junk or spam folder too.'); } catch (e) { toast((e as Error).message, true); }
        }) as EventListener }, 'Send a new code'),
        h('a', { href: '/home', class: 'button quiet' }, 'Later')),
      h('p', { class: 'junk-hint' },
        h('strong', {}, "Can't find the email? "),
        'Check junk or spam for ', h('strong', {}, 'no-reply@mail.roleplayretro.com'),
        ', and mark it "Not spam".')));
}
