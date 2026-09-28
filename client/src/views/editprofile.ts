import { ADULT_RP_STYLES, CHARACTER_CITY, CHARACTER_GENDER, CHARACTER_SHEET, characterAgeFrom, PROFILE, RP_STYLES, Trust, type RpStyle } from '../../../shared/config.js';
import type { AccountDTO, ProfileDTO } from '../../../shared/types.js';
import { card, page, state, toast } from '../core.js';
import { api, apiUpload, h } from '../dom.js';
import { photoSection } from './photosection.js';

const today = () => new Date().toISOString().slice(0, 10);

/** A text box with a live countdown that stops accepting input at the limit. */
function countedTextarea(value: string, max: number, rows: number, label: string) {
  const ta = h('textarea', { rows, maxlength: max, 'aria-label': label });
  ta.value = value;
  const left = h('span', { class: 'counter', 'aria-live': 'polite' });
  const paint = () => {
    const n = max - ta.value.length;
    left.textContent = `${n} left`;
    left.className = 'counter' + (n === 0 ? ' over' : n <= 50 ? ' warn' : '');
  };
  ta.addEventListener('input', paint);
  paint();
  return { ta, left };
}

const lockRow = (label: string, value: string, note: string) =>
  h('div', { class: 'setting locked-row' },
    h('div', {}, h('span', { class: 'setting-label' }, label), h('span', { class: 'muted small block' }, note)),
    h('div', { class: 'locked-value' }, h('span', {}, value), h('span', { class: 'tag' }, 'Locked')));

export async function viewEditProfile() {
  const me = state.me!;
  page('Edit profile', h('p', { class: 'muted' }, 'Loading…'));
  const [acct, p] = await Promise.all([
    api<AccountDTO>('/api/me/account'),
    api<ProfileDTO>(`/api/profiles/${encodeURIComponent(me.handle)}`),
  ]);
  const reload = () => void viewEditProfile();
  const save = async (body: Record<string, unknown>, ok?: string) => {
    await api('/api/me/profile', { method: 'PATCH', body });
    if (ok) toast(ok);
  };

  // ----- banner -----
  const bannerBox = h('div', { class: `profile-banner${p.banner ? '' : ' art-member'}` }, p.banner ? h('img', { src: p.banner, alt: 'Your banner' }) : null);
  const pickBanner = () => {
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', class: 'visually-hidden' });
    document.body.append(input);
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      if (f.size > PROFILE.photoMaxBytes) return toast(`That picture is over ${Math.round(PROFILE.photoMaxBytes / 1024 / 1024)} MB.`, true);
      try {
        toast('Uploading banner…');
        await apiUpload('/api/me/banner', f);
        toast('Banner updated.');
        reload();
      } catch (e) { toast((e as Error).message, true); }
    });
    input.click();
  };
  const bannerCard = card('Banner',
    bannerBox,
    h('p', { class: 'muted small' }, 'A wide picture shown across the top of your profile. Any size works; it\'s cropped to fit.'),
    me.trust >= Trust.Verified
      ? h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'primary', onclick: pickBanner as EventListener }, p.banner ? 'Change banner' : 'Add a banner'),
          p.banner ? h('button', { type: 'button', class: 'quiet', onclick: (async () => {
            try { await api('/api/me/banner', { method: 'DELETE' }); toast('Banner removed.'); reload(); } catch (e) { toast((e as Error).message, true); }
          }) as EventListener }, 'Remove') : null)
      : h('p', { class: 'notice' }, 'Confirm your email to add a banner. ', h('a', { href: '/verify' }, 'Enter code')));

  // ----- 1. Account: private, fixed once set -----
  const phoneArea = acct.phone
    ? lockRow('Phone number', acct.phone, 'Set once and locked.')
    : (() => {
        const phone = h('input', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '+13035551234', maxlength: 24 });
        const pw = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 200 });
        const f = h('form', { class: 'stack phone-form' },
          h('div', {}, h('span', { class: 'setting-label' }, 'Phone number'), h('span', { class: 'muted small block' }, "Optional. Once saved it can't be changed.")),
          h('label', { class: 'field' }, h('span', {}, 'Number'), phone),
          h('label', { class: 'field' }, h('span', {}, 'Your password'), pw),
          h('button', { type: 'submit', class: 'primary' }, 'Save phone number'));
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!confirm(`Save ${phone.value.trim()} as your phone number? It can't be changed later.`)) return;
          try { await api('/api/me/phone', { body: { phone: phone.value, password: pw.value } }); toast('Phone number saved.'); reload(); }
          catch (x) { toast((x as Error).message, true); }
        });
        return f;
      })();
  const accountCard = card('Account',
    h('p', { class: 'muted small' }, 'Only you can see these. They are kept for confirming it\'s really you, and can\'t be changed once set.'),
    lockRow('Username', acct.handle, 'Chosen when you signed up.'),
    acct.emailVerified
      ? lockRow('Email address', acct.email, 'Confirmed.')
      : h('div', { class: 'setting' },
          h('div', {}, h('span', { class: 'setting-label' }, 'Email address'), h('span', { class: 'muted small block' }, 'Not confirmed yet. You can fix a typo in Settings until you confirm it; then it locks.')),
          h('span', {}, acct.email)),
    phoneArea,
    lockRow('Birthday', acct.birthdate ? new Date(acct.birthdate + 'T12:00:00Z').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : 'Not set', 'Your real birthday. Never shown on your profile.'));

  // ----- 2. Character profile -----
  const own = p.own ?? { characterBirthday: null, legacyAge: null };
  const bday = h('input', { type: 'date', min: '0001-01-01', max: today(), value: own.characterBirthday ?? '', 'aria-describedby': 'age-preview' });
  const agePreview = h('span', { class: 'muted small block', id: 'age-preview' });
  const paintAge = () => {
    agePreview.textContent = bday.value
      ? `Shows as age ${characterAgeFrom(bday.value)} on your profile.`
      : own.legacyAge ? `Currently shows your old age text "${own.legacyAge}". Pick a birthday to replace it.` : 'Any date up to today: newborns and ancient beings welcome.';
  };
  bday.addEventListener('input', paintAge);
  paintAge();

  const gender = h('input', { type: 'text', maxlength: CHARACTER_GENDER.maxLength, placeholder: 'e.g. M, F, NB', value: p.characterGender ?? '' });

  const city = h('input', { type: 'text', maxlength: CHARACTER_CITY.maxLength, placeholder: 'e.g. Hyrule, Gotham, The Moon', value: p.characterCity ?? '' });
  const cityState = h('span', { class: 'muted small', 'aria-live': 'polite' });
  let cityTimer: number | undefined;
  city.addEventListener('input', () => {
    cityState.textContent = 'Saving…';
    clearTimeout(cityTimer);
    cityTimer = window.setTimeout(async () => {
      try { await save({ characterCity: city.value.trim() || null }); cityState.textContent = 'Saved'; }
      catch (e) { cityState.textContent = (e as Error).message; }
    }, 700);
  });

  let style: RpStyle | null = p.rpStyle;
  const styleBtns: HTMLButtonElement[] = [];
  const paintStyle = () => styleBtns.forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.style || null) === style)));
  for (const s of [...RP_STYLES, null] as (RpStyle | null)[]) {
    const adultOnly = s != null && ADULT_RP_STYLES.includes(s);
    const b = h('button', { type: 'button', class: `style-chip${s ? '' : ' none'}`, 'data-style': s ?? '', disabled: adultOnly && me.isMinor }, s ?? 'None');
    b.addEventListener('click', () => { style = s; paintStyle(); });
    styleBtns.push(b);
  }
  paintStyle();

  const about = countedTextarea(p.bio ?? '', PROFILE.bioMax, 8, 'About');

  const saveProfile = h('button', { type: 'button', class: 'primary wide' }, 'Save profile');
  saveProfile.addEventListener('click', async () => {
    if (bday.value && bday.value > today()) return toast("A birthday can't be in the future.", true);
    saveProfile.disabled = true;
    try {
      await save({ characterBirthday: bday.value || null, characterGender: gender.value.trim() || null, rpStyle: style, bio: about.ta.value }, 'Profile saved.');
    } catch (e) { toast((e as Error).message, true); }
    saveProfile.disabled = false;
  });

  const characterCard = card('Profile',
    h('label', { class: 'field' }, h('span', {}, 'Birthday'), bday, agePreview),
    h('label', { class: 'field' }, h('span', {}, 'Gender'), gender),
    h('label', { class: 'field' }, h('span', {}, 'City'), city, h('span', { class: 'row' }, h('span', { class: 'muted small' }, 'Saves as you type.'), cityState)),
    h('div', { class: 'field', role: 'group', 'aria-label': 'Roleplay style' },
      h('span', {}, 'Roleplay style'),
      h('div', { class: 'style-picker' }, ...styleBtns),
      h('span', { class: 'muted small' }, me.isMinor ? 'Shown on the gold nameplate under your picture. NSFW is for members 18 and over.' : 'Shown on the gold nameplate under your picture. One at a time.')),
    h('label', { class: 'field' }, h('span', {}, 'About'), about.ta, h('span', { class: 'row about-foot' }, h('span', { class: 'muted small' }, 'Tell your story.'), about.left)),
    saveProfile);

  // ----- 3. Character sheet -----
  const sheetInputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const sheetFields = CHARACTER_SHEET.map((f) => {
    const val = p.characterSheet[f.key] ?? '';
    if ('long' in f) {
      const t = countedTextarea(val, f.max, 3, f.label);
      sheetInputs.set(f.key, t.ta);
      return h('label', { class: 'field' }, h('span', { class: 'row about-foot' }, h('span', {}, f.label), t.left), t.ta);
    }
    const i = h('input', { type: 'text', maxlength: f.max, value: val });
    sheetInputs.set(f.key, i);
    return h('label', { class: 'field' }, h('span', {}, f.label), i);
  });
  const saveSheet = h('button', { type: 'button', class: 'primary wide' }, 'Save character sheet');
  saveSheet.addEventListener('click', async () => {
    saveSheet.disabled = true;
    try {
      await save({ characterSheet: Object.fromEntries([...sheetInputs].map(([k, el]) => [k, el.value])) }, 'Character sheet saved.');
    } catch (e) { toast((e as Error).message, true); }
    saveSheet.disabled = false;
  });
  const sheetCard = card('Character sheet',
    h('p', { class: 'muted small' }, 'Fill in as much or as little as you like. Only filled-in parts show on your profile, and you can change it any time.'),
    h('div', { class: 'sheet-grid' }, ...sheetFields),
    saveSheet);

  // ----- tabs: one section at a time; the address remembers which (?tab=photos) -----
  const photosPane = h('div', { class: 'stack' }, bannerCard, await photoSection(p, { manage: true, reload }));
  const TABS: [string, string, HTMLElement][] = [
    ['account', 'Account', accountCard],
    ['profile', 'Profile', characterCard],
    ['sheet', 'Character Sheet', sheetCard],
    ['photos', 'Photos', photosPane],
  ];
  const wanted = new URLSearchParams(location.search).get('tab');
  let current = TABS.some(([id]) => id === wanted) ? wanted! : 'profile';
  const tabButtons = TABS.map(([id, label]) => {
    const b = h('button', { type: 'button', role: 'tab', id: `tab-${id}`, class: 'tab', 'aria-controls': `pane-${id}` }, label);
    b.addEventListener('click', () => show(id));
    return b;
  });
  const panes = TABS.map(([id, , el]) => h('div', { role: 'tabpanel', id: `pane-${id}`, 'aria-labelledby': `tab-${id}` }, el));
  function show(id: string) {
    current = id;
    TABS.forEach(([tid], i) => {
      const on = tid === id;
      tabButtons[i].classList.toggle('active', on);
      tabButtons[i].setAttribute('aria-selected', String(on));
      panes[i].hidden = !on;
    });
    history.replaceState({}, '', `/edit-profile?tab=${id}`);
  }
  show(current);

  page('Edit profile',
    h('a', { href: `/profile/${me.handle}`, class: 'back' }, '‹ View my profile'),
    h('div', { class: 'tabs-row edit-tabs', role: 'tablist', 'aria-label': 'Edit profile sections' }, ...tabButtons),
    ...panes);
}
