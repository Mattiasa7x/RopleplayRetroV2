import { PASSWORD_MIN, TEXT_SIZES, THEMES, type Prefs } from '../../../shared/config.js';
import type { MeDTO, SessionInfo } from '../../../shared/types.js';
import { applyPrefs, card, disconnect, field, form, navigate, page, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';
import { meIsQuill, subscriptionsCard } from './quill.js';
import { deviceSubscribed, disablePush, enablePush, needsHomeScreen, pushSupported } from '../push.js';

const LABELS: Record<string, string> = {
  light: 'Light', dark: 'Dark', system: 'Match my device',
  s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra large',
  everyone: 'Everyone', friends: 'Friends only', nobody: 'Nobody', me: 'Only me',
};

async function savePref(patch: Partial<Prefs>) {
  try {
    state.me = await api<MeDTO>('/api/me/prefs', { method: 'PATCH', body: patch });
    applyPrefs(state.me.prefs);
    toast('Saved.');
  } catch (e) {
    toast((e as Error).message, true);
    void viewSettings(); // put the control back
  }
}

/** An on/off switch row that saves as soon as it's flipped. */
function toggle<K extends keyof Prefs>(key: K, label: string, help?: string): HTMLElement {
  const me = state.me!;
  const input = h('input', { type: 'checkbox', role: 'switch', checked: me.prefs[key] as boolean });
  input.addEventListener('change', () => void savePref({ [key]: input.checked } as Partial<Prefs>));
  return h('label', { class: 'setting switch-row' },
    h('span', {}, h('span', { class: 'setting-label' }, label), help ? h('span', { class: 'muted small block' }, help) : null),
    input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
}

/** A dropdown row that saves on change. */
function choice<K extends keyof Prefs>(key: K, label: string, values: readonly string[]): HTMLElement {
  const me = state.me!;
  const select = h('select', { 'aria-label': label }, ...values.map((v) => h('option', { value: v, selected: me.prefs[key] === v }, LABELS[v] ?? v)));
  select.addEventListener('change', () => void savePref({ [key]: select.value } as Partial<Prefs>));
  return h('label', { class: 'setting' }, h('span', {}, h('span', { class: 'setting-label' }, label)), select);
}

function details(summary: string, ...content: (Node | null)[]): HTMLElement {
  return h('details', { class: 'setting-details' }, h('summary', {}, summary), ...(content.filter(Boolean) as Node[]));
}

/** Push notifications: an account setting plus this device's permission and subscription. */
async function pushRow(): Promise<HTMLElement> {
  const me = state.me!;
  const status = h('span', { class: 'muted small block', 'aria-live': 'polite' });
  const input = h('input', { type: 'checkbox', role: 'switch' });
  const row = h('label', { class: 'setting switch-row' },
    h('span', {}, h('span', { class: 'setting-label' }, 'Push notifications'),
      h('span', { class: 'muted small block' }, 'Alerts even when the site is closed. Never includes message text.'),
      status),
    input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
  if (needsHomeScreen()) {
    input.disabled = true;
    status.textContent = 'iPhone/iPad: Share › Add to Home Screen, open it from there, then turn this on.';
    return row;
  }
  if (!pushSupported()) {
    input.disabled = true;
    status.textContent = "This browser can't show notifications from websites.";
    return row;
  }
  const here = await deviceSubscribed();
  input.checked = me.prefs.pushAlerts && here;
  status.textContent = Notification.permission === 'denied'
    ? 'Notifications are blocked for this site in your browser settings.'
    : input.checked ? 'On for this device.' : me.prefs.pushAlerts ? 'On for your other devices. Turn on to add this one.' : '';
  input.addEventListener('change', async () => {
    input.disabled = true;
    try {
      if (input.checked) {
        await enablePush();
        if (!state.me!.prefs.pushAlerts) state.me = await api<MeDTO>('/api/me/prefs', { method: 'PATCH', body: { pushAlerts: true } });
        status.textContent = 'On for this device.';
        toast('Notifications are on.');
      } else {
        await disablePush();
        state.me = await api<MeDTO>('/api/me/prefs', { method: 'PATCH', body: { pushAlerts: false } });
        status.textContent = '';
        toast('Notifications are off.');
      }
    } catch (e) {
      input.checked = !input.checked;
      status.textContent = (e as Error).message;
    }
    input.disabled = false;
  });
  return row;
}

async function twoFactorSection(): Promise<HTMLElement> {
  const me = state.me!;
  const box = h('div', {});
  if (me.twoFactor) {
    box.append(
      h('p', {}, '✅ Two-factor sign-in is on.'),
      details('Turn off two-factor sign-in', form([
        field('Password', 'password', 'password', { autocomplete: 'current-password' }),
        field('Code from your app or a backup code', 'code', 'text', { autocomplete: 'one-time-code', maxlength: 12 }),
      ], 'Turn off', async (d) => {
        await api('/api/me/2fa/disable', { body: { password: d.get('password'), code: d.get('code') } });
        state.me = await api<MeDTO>('/api/me');
        toast('Two-factor sign-in is off.');
        void viewSettings();
      })));
    return box;
  }
  const step2 = h('div', { hidden: true });
  const step1 = form([
    h('p', { class: 'muted small' }, 'Asks for a code from an authenticator app when you log in.'),
    field('Confirm your password to start', 'password', 'password', { autocomplete: 'current-password' }),
  ], 'Set up two-factor', async (d) => {
    const r = await api<{ secret: string; uri: string }>('/api/me/2fa/setup', { body: { password: d.get('password') } });
    step1.hidden = true;
    step2.hidden = false;
    step2.append(
      h('p', {}, h('strong', {}, '1. '), 'On this phone: ', h('a', { href: r.uri, class: 'button quiet' }, 'Open in authenticator app')),
      h('p', {}, h('strong', {}, '2. '), 'Or type this key into the app:'),
      h('code', { class: 'secret' }, r.secret.match(/.{1,4}/g)!.join(' ')),
      form([field('3. Enter the 6-digit code it shows', 'code', 'text', { inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code' })], 'Turn on', async (d2) => {
        const res = await api<{ backupCodes: string[] }>('/api/me/2fa/enable', { body: { code: String(d2.get('code')).trim() } });
        state.me = await api<MeDTO>('/api/me');
        box.replaceChildren(
          h('p', {}, '✅ Two-factor sign-in is on.'),
          h('p', { class: 'notice' }, 'Save these backup codes. Each works once, and they won’t be shown again.'),
          h('ul', { class: 'backup-codes' }, ...res.backupCodes.map((c) => h('li', {}, h('code', {}, c)))),
          h('button', { type: 'button', class: 'primary', onclick: (() => void viewSettings()) as EventListener }, 'I saved them'));
      }));
  });
  box.append(step1, step2);
  return box;
}

async function devicesSection(): Promise<HTMLElement> {
  const sessions = await api<SessionInfo[]>('/api/me/sessions');
  const list = h('ul', { class: 'people' }, ...sessions.map((s) => h('li', {},
    h('span', {}, h('strong', {}, s.current ? 'This device' : 'Another device'), h('span', { class: 'muted small block' }, `Signed in ${timeAgo(s.createdAt)}`)),
    s.current ? null : h('button', { type: 'button', class: 'quiet', onclick: (async () => {
      await api(`/api/me/sessions/${s.id}`, { method: 'DELETE' });
      toast('Signed out that device.');
      void viewSettings();
    }) as EventListener }, 'Sign out'))));
  return h('div', {}, list, sessions.length > 1 ? h('button', { type: 'button', class: 'quiet wide', onclick: (async () => {
    await api('/api/me/sessions/sign-out-others', { body: {} });
    toast('Signed out everywhere else.');
    void viewSettings();
  }) as EventListener }, 'Sign out all other devices') : null);
}

async function blockedSection(): Promise<HTMLElement> {
  const rows = await api<{ handle: string; mode: 'ignore' | 'block' }[]>('/api/ignores');
  const list = h('ul', { class: 'people' }, ...(rows.length ? rows.map((r) => h('li', {},
    h('span', {}, h('a', { href: `/profile/${r.handle}` }, r.handle), h('span', { class: 'muted small block' }, r.mode === 'block' ? 'Blocked: no messages, profile, comments or friend requests either way' : 'Ignored: their chat lines are hidden from you')),
    h('button', { type: 'button', class: 'quiet', onclick: (async () => {
      await api(`/api/ignores/${encodeURIComponent(r.handle)}`, { method: 'DELETE' });
      toast(`${r.handle} removed from your list.`);
      void viewSettings();
    }) as EventListener }, r.mode === 'block' ? 'Unblock' : 'Unignore'))) : [h('li', { class: 'muted' }, 'Nobody. Tap a name to block or ignore someone.')]));
  const add = form([
    field('Name', 'handle', 'text', { maxlength: 16, autocapitalize: 'off' }),
    h('label', { class: 'field' }, h('span', {}, 'Action'), h('select', { name: 'mode' }, h('option', { value: 'block' }, 'Block'), h('option', { value: 'ignore' }, 'Ignore (hide chat lines only)'))),
  ], 'Add', async (d, err) => {
    try {
      await api(`/api/ignores/${encodeURIComponent(String(d.get('handle')).trim())}`, { method: 'PUT', body: { mode: d.get('mode') } });
      void viewSettings();
    } catch (x) { err((x as Error).message); }
  });
  return h('div', {}, list, details('Block or ignore someone by name', add));
}

export async function viewSettings() {
  const me = state.me!;
  page('Settings', h('p', { class: 'muted' }, 'Loading…'));
  const [twoFA, devices, blocked, push, subs] = await Promise.all([twoFactorSection(), devicesSection(), blockedSection(), pushRow(), subscriptionsCard(toggle('showQuillBadge', 'Show my Gold Quill ring', 'Gold Quill: the gold frame around your picture.'))]);

  const withId = (id: string, el: HTMLElement) => { el.id = id; return el; };

  const sections: HTMLElement[] = [
    withId('account', card('Account',
      h('div', { class: 'setting' }, h('span', {}, h('span', { class: 'setting-label' }, 'Name'), h('span', { class: 'muted small block' }, 'Permanent')), h('strong', {}, me.handle)),
      h('div', { class: 'setting' }, h('span', {}, h('span', { class: 'setting-label' }, 'Email'), h('span', { class: 'muted small block' }, me.emailVerified ? 'Confirmed and locked' : 'Not confirmed yet')), h('span', { class: 'truncate' }, me.email)),
      !me.emailVerified ? h('a', { href: '/verify', class: 'button quiet wide' }, 'Confirm email') : null,
      me.emailVerified ? null : details('Fix email (until confirmed)', form([
        field('New email', 'email', 'email', { autocomplete: 'email' }),
        field('Password', 'password', 'password', { autocomplete: 'current-password' }),
      ], 'Change email', async (d) => {
        await api('/api/me/email', { body: { email: d.get('email'), password: d.get('password') } });
        state.me = await api<MeDTO>('/api/me');
        state.flash = 'We sent a code to your new email.';
        navigate('/verify');
      })),
      h('a', { href: '/edit-profile', class: 'button quiet wide' }, 'Phone, birthday and profile details'),
      h('button', { type: 'button', class: 'quiet wide', onclick: (async () => {
        await disablePush(); // a shared device shouldn't keep getting your notifications
        await api('/api/logout', { body: {} });
        state.me = null;
        disconnect();
        navigate('/login', true);
      }) as EventListener }, 'Log out'),
      h('p', { class: 'muted small center' }, h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms of Service'), ' · ',
        h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy')))),

    withId('security', card('Security',
      details('Change password', form([
        field('Current password', 'current', 'password', { autocomplete: 'current-password' }),
        field(`New password (${PASSWORD_MIN}+ characters)`, 'next', 'password', { minlength: PASSWORD_MIN, autocomplete: 'new-password' }),
      ], 'Change password', async (d) => {
        await api('/api/me/password', { body: { current: d.get('current'), next: d.get('next') } });
        toast('Password changed. Other devices were signed out.');
        void viewSettings();
      })),
      h('h3', {}, 'Two-factor sign-in'), twoFA,
      h('h3', {}, 'Signed-in devices'), devices)),

    withId('privacy', card('Privacy',
      choice('profileVisibility', 'Who can see my profile', ['everyone', 'friends']),
      choice('whoCanComment', 'Who can comment on my profile', ['everyone', 'friends', 'nobody']),
      choice('whoCanFriend', 'Who can send me friend requests', ['everyone', 'nobody']),
      choice('friendsList', 'Who can see my friends list', ['me', 'friends', 'everyone']),
      choice('giftsVisibility', 'Who can see my gifts', ['me', 'friends', 'everyone']),
      toggle('showOnline', 'Show friends when I’m online'),
      !meIsQuill() ? null : toggle('showQuillBadge', 'Show my Gold Quill ring', 'Gold Quill: the gold frame around your picture.'))),

    withId('subscriptions', subs),

    withId('chat', card('Chat',
      toggle('chatFilter', 'Chat filter', 'Masks mature words (h***). Slurs are always blocked.'),
      toggle('enterToSend', 'Enter key sends', 'Off: Enter never sends.'),
      toggle('showTimestamps', 'Show times next to messages'))),

    withId('blocked', card('Blocked and ignored', blocked)),

    withId('appearance', card('Appearance',
      choice('theme', 'Theme', THEMES),
      choice('textSize', 'Text size', TEXT_SIZES))),

    withId('notifications', card('Alerts',
      toggle('mentionAlerts', 'When someone @mentions me'),
      toggle('friendAlerts', 'Friend requests and profile comments'),
      push)),

    card('Delete account',
      details('Delete my account', form([
        h('p', { class: 'muted small' }, 'Deletes your profile, photos, friends and messages for good. Your name stays reserved.'),
        field('Password', 'password', 'password', { autocomplete: 'current-password' }),
        field(`Type ${me.handle} to confirm`, 'confirmHandle', 'text', { autocapitalize: 'off', autocomplete: 'off' }),
      ], 'Delete forever', async (d) => {
        await api('/api/me/delete', { body: { password: d.get('password'), confirmHandle: d.get('confirmHandle') } });
        state.me = null;
        disconnect();
        state.flash = 'Your account was deleted.';
        navigate('/login', true);
      }, 'danger-form'))),
  ];
  sections[sections.length - 1].id = 'delete';

  // One section at a time, chosen from a single column of tabs down the left side.
  const TABS: [string, string][] = [['account', 'Account'], ['subscriptions', 'Subscriptions'], ['security', 'Security'], ['privacy', 'Privacy'], ['chat', 'Chat'],
    ['blocked', 'Blocked'], ['appearance', 'Appearance'], ['notifications', 'Alerts'], ['delete', 'Delete account']];
  const buttons = TABS.map(([id, label]) => {
    const b = h('button', { type: 'button', role: 'tab', id: `st-${id}`, class: `settings-tab${id === 'delete' ? ' danger-tab' : ''}`, 'aria-controls': id }, label);
    b.addEventListener('click', () => show(id));
    return b;
  });
  function show(id: string) {
    TABS.forEach(([tid], i) => {
      const on = tid === id;
      buttons[i].classList.toggle('active', on);
      buttons[i].setAttribute('aria-selected', String(on));
      const sec = sections.find((x) => x.id === tid);
      if (sec) { sec.hidden = !on; sec.setAttribute('role', 'tabpanel'); }
    });
    history.replaceState({}, '', `/settings?tab=${id}`);
  }
  page('Settings',
    h('div', { class: 'settings-layout' },
      h('nav', { class: 'settings-tabs', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Settings sections' }, ...buttons),
      h('div', { class: 'settings-panes' }, ...sections)));
  const wanted = new URLSearchParams(location.search).get('tab');
  show(TABS.some(([id]) => id === wanted) ? wanted! : 'account');
}
