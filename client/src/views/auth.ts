import { AGE, PASSWORD_MIN, SITE_NAME } from '../../../shared/config.js';
import type { LoginResult, MeDTO } from '../../../shared/types.js';
import { connect, field, form, navigate, page, state, applyPrefs, toast } from '../core.js';
import { api, h } from '../dom.js';
import { formatInviteCode, normalizeInviteCode } from '../../../shared/trophies.js';

function signedIn(me: MeDTO, to = '/home') {
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
      h('p', {}, 'Enter the 6-digit code from your authenticator app, or one of your backup codes.'),
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
    h('p', { class: 'center' }, 'New here? ', h('a', { href: '/signup' }, 'Create an account')));
}

export function viewSignup() {
  // An invite link (/signup?invite=ABCD-EFGH) fills in the code.
  const invite = formatInviteCode(normalizeInviteCode(new URLSearchParams(location.search).get('invite') ?? '').slice(0, 8));
  const max = new Date();
  max.setFullYear(max.getFullYear() - AGE.minimum);
  page('Sign up',
    h('section', { class: 'card' },
      form(
        [
          field('Name (3–16 letters, numbers or _)', 'handle', 'text', { pattern: '[A-Za-z0-9_]{3,16}', maxlength: 16, autocomplete: 'username', autocapitalize: 'off' }),
          h('p', { class: 'hint' }, 'Your name is yours for good: it can’t be changed, and nobody can register a lookalike of it.'),
          field('Email', 'email', 'email', { autocomplete: 'email' }),
          field(`Password (${PASSWORD_MIN}+ characters)`, 'password', 'password', { minlength: PASSWORD_MIN, autocomplete: 'new-password' }),
          field('Your real birthdate', 'birthdate', 'date', { max: max.toISOString().slice(0, 10), autocomplete: 'bday' }),
          field('Invite code (optional)', 'inviteCode', 'text', { required: false, maxlength: 12, autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, placeholder: 'ABCD-EFGH', value: invite }),
          h('p', { class: 'hint' }, 'Did a friend invite you? Their code gives them credit toward invite trophies.'),
          h('p', { class: 'hint' }, `You must be ${AGE.minimum} or older. Your birthdate is private, never shown, and can't be changed later: it keeps younger members safe. Your character's age is separate: set any age you like on your profile.`),
        ],
        'Create account',
        async (d) => {
          const me = await api<MeDTO>('/api/signup', {
            body: { handle: d.get('handle'), email: d.get('email'), password: d.get('password'), birthdate: d.get('birthdate'), inviteCode: String(d.get('inviteCode') ?? '') || undefined },
          });
          signedIn(me, '/verify');
        },
      )),
    h('p', { class: 'center' }, 'Already a member? ', h('a', { href: '/login' }, 'Log in')));
}

export function viewVerify() {
  if (state.me?.emailVerified) return navigate('/home', true);
  page('Confirm email',
    h('section', { class: 'card' },
      h('p', {}, `We sent a 6-digit code to ${state.me?.email ?? 'your email'}. It works for 15 minutes.`),
      form([field('Code', 'code', 'text', { inputmode: 'numeric', pattern: '\\d{6}', maxlength: 6, autocomplete: 'one-time-code' })], 'Confirm', async (d) => {
        await api('/api/verify/email', { body: { code: String(d.get('code')).trim() } });
        state.me = await api<MeDTO>('/api/me');
        state.flash = 'Email confirmed. Every room is open to you now.';
        navigate('/home', true);
      }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'quiet', onclick: (async () => {
          try { await api('/api/verify/resend', { body: {} }); toast('New code sent.'); } catch (e) { toast((e as Error).message, true); }
        }) as EventListener }, 'Send a new code'),
        h('a', { href: '/home', class: 'button quiet' }, 'Later'))));
}
