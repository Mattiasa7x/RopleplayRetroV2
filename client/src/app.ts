import { viewTrophies } from './views/trophies.js';
import { connect, navigate, page, refreshMe, refreshUnread, setRouter, state } from './core.js';
import { h } from './dom.js';
import { viewLogin, viewSignup, viewVerify } from './views/auth.js';
import { viewEditProfile } from './views/editprofile.js';
import { viewFriends } from './views/friends.js';
import { viewPeople } from './views/online.js';
import { viewAdmin } from './views/admin.js';
import { viewHome } from './views/home.js';
import { viewInbox, viewThread } from './views/messages.js';
import { viewGallery, viewPhoto, viewProfile, viewProfileComments } from './views/profile.js';
import { viewRoom } from './views/room.js';
import { viewManage, viewNewRoom, viewRooms } from './views/rooms.js';
import { viewSettings } from './views/settings.js';

/**
 * Every page has a real address, so links can be shared and the browser's back button works:
 *   /home  /rooms  /room/:slug  /room/:slug/manage  /new-room  /friends
 *   /messages  /messages/:name  /profile/:name  /settings  /login  /signup  /verify
 */
async function route() {
  state.cleanup?.();
  state.cleanup = null;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  const open = ['login', 'signup'].includes(parts[0] ?? '');

  if (!state.me && (await refreshMe())) connect();
  // No account, no entry: everything but sign-up and log-in goes to sign-up (and back here after).
  if (!state.me && !open) return navigate(path === '/' || path === '/home' ? '/signup' : `/signup?next=${encodeURIComponent(path + location.search)}`, true);
  if (state.me && (path === '/' || open)) return navigate('/home', true);
  if (state.me) void refreshUnread();

  try {
    switch (parts[0]) {
      case 'login': return viewLogin();
      case 'signup': return viewSignup();
      case 'verify': return viewVerify();
      case 'home': return await viewHome();
      case 'rooms': return await viewRooms();
      case 'new-room': return await viewNewRoom();
      case 'room': return parts[2] === 'manage' ? await viewManage(parts[1] ?? '') : await viewRoom(parts[1] ?? '');
      case 'friends': return await viewFriends();
      case 'messages': return parts[1] ? await viewThread(decodeURIComponent(parts[1])) : await viewInbox();
      case 'profile': {
        const who = decodeURIComponent(parts[1] ?? state.me!.handle);
        if (parts[2] === 'photos') return await viewGallery(who);
        if (parts[2] === 'comments') return await viewProfileComments(who);
        if (parts[2] === 'trophies') return await viewTrophies(who);
        return await viewProfile(who);
      }
      case 'photo': return await viewPhoto(parts[1] ?? '');
      case 'edit-profile': return await viewEditProfile();
      case 'people': return await viewPeople();
      case 'admin': return await viewAdmin();
      case 'settings': return await viewSettings();
      default: return page('Not found', h('p', { class: 'notice' }, 'That page does not exist. '), h('a', { href: '/home' }, 'Go home'));
    }
  } catch (e) {
    page('Something went wrong', h('p', { class: 'notice error' }, (e as Error).message || 'Please try again.'), h('a', { href: '/home' }, 'Go home'));
  }
}

setRouter(route);
void route();
