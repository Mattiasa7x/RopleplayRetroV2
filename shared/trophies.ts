/**
 * Trophies members earn just by using the site. The list order is the display order.
 * How each one is checked lives on the server (server/trophies.ts); the look of each
 * badge lives in the browser (client/src/trophyart.ts).
 */

export type TrophyGroup = 'time' | 'account' | 'chat' | 'social' | 'mail' | 'photos' | 'gifts' | 'views';

export interface TrophyDef {
  id: string;
  name: string;
  group: TrophyGroup;
  /** How it's earned, shown under the badge. */
  how: string;
  /** Account age in hours (time), messages sent in rooms (chat), friends (social), private messages sent (mail), people invited or days in a row with a status (account), photos kept (photos), gifts sent (gifts) or profile views received (views). */
  goal?: number;
  /** likes: chat trophies counted in likes received on room messages instead of messages sent.
   *  online: account trophies counted in hours spent on the site (goal in hours, adds up over time). */
  metric?: 'likes' | 'online';
}

export const TROPHY_GROUPS: { id: TrophyGroup; title: string }[] = [
  { id: 'account', title: 'Account' },
  { id: 'time', title: 'Time on RoleplayRetro' },
  { id: 'photos', title: 'Photos' },
  { id: 'social', title: 'Friends' },
  { id: 'chat', title: 'Room chat' },
  { id: 'mail', title: 'Private messages' },
  { id: 'gifts', title: 'Gifts sent' },
  { id: 'views', title: 'Profile views' },
];

/** The two tabs on the trophy page, each made of several groups (shown as sections). */
export const TROPHY_TABS: { id: 'account' | 'social'; title: string; groups: TrophyGroup[] }[] = [
  { id: 'account', title: 'Account', groups: ['account', 'time', 'photos'] },
  { id: 'social', title: 'Social', groups: ['social', 'chat', 'mail', 'gifts', 'views'] },
];

const DAY = 24;
const YEAR = 365 * DAY;

export const TROPHIES: TrophyDef[] = [
  { id: 'noob', name: 'Noob', group: 'time', goal: 1, how: 'Your account is 1 hour old.' },
  { id: 'wanderer', name: 'Wanderer', group: 'time', goal: 183 * DAY, how: 'Your account is 6 months old.' },
  { id: 'regular', name: 'Tavern Regular', group: 'time', goal: YEAR, how: 'Your account is 1 year old.' },
  { id: 'veteran', name: 'Veteran', group: 'time', goal: 2 * YEAR + DAY, how: 'Your account is 2 years old.' },
  { id: 'old_guard', name: 'Old Guard', group: 'time', goal: 5 * YEAR + 2 * DAY, how: 'Your account is 5 years old.' },

  { id: 'warded', name: 'Warded', group: 'account', how: 'Confirm your email, add a phone number and turn on two-factor sign-in.' },
  { id: 'fully_realized', name: 'Fully Realized', group: 'account', how: 'Fill in every part of your profile: birthday, gender, city, roleplay style, About and the whole character sheet.' },
  { id: 'diarist', name: 'Diarist', group: 'account', goal: 7, how: 'Update your status every day for a week.' },
  { id: 'chronicler', name: 'Chronicler', group: 'account', goal: 30, how: 'Update your status every day for a month.' },
  { id: 'keeper_of_days', name: 'Keeper of Days', group: 'account', goal: 365, how: 'Update your status every day for a year.' },
  { id: 'party_leader', name: 'Party Leader', group: 'account', goal: 10, how: 'Invite 10 people who join and confirm their email.' },
  { id: 'guild_master', name: 'Guild Master', group: 'account', goal: 50, how: 'Invite 50 people who join and confirm their email.' },
  { id: 'sovereign', name: 'Sovereign', group: 'account', goal: 100, how: 'Invite 100 people who join and confirm their email.' },
  { id: 'lamplighter', name: 'Lamplighter', group: 'account', metric: 'online', goal: 10, how: 'Spend 10 hours on RoleplayRetro.' },
  { id: 'night_watch', name: 'Night Watch', group: 'account', metric: 'online', goal: 100, how: 'Spend 100 hours on RoleplayRetro.' },
  { id: 'hearthkeeper', name: 'Hearthkeeper', group: 'account', metric: 'online', goal: 500, how: 'Spend 500 hours on RoleplayRetro.' },
  { id: 'eternal_flame', name: 'Eternal Flame', group: 'account', metric: 'online', goal: 1_000, how: 'Spend 1,000 hours on RoleplayRetro.' },

  { id: 'chatterbox', name: 'Gift of Gab', group: 'chat', goal: 100, how: 'Send 100 messages in rooms.' },
  { id: 'wordsmith', name: 'Wordsmith', group: 'chat', goal: 1_000, how: 'Send 1,000 messages in rooms.' },
  { id: 'storyteller', name: 'Storyteller', group: 'chat', goal: 10_000, how: 'Send 10,000 messages in rooms.' },
  { id: 'loremaster', name: 'Loremaster', group: 'chat', goal: 1_000_000, how: 'Send 1,000,000 messages in rooms.' },
  { id: 'crowd_pleaser', name: 'Crowd Pleaser', group: 'chat', metric: 'likes', goal: 100, how: 'Get 100 likes on your room messages.' },
  { id: 'beloved_bard', name: 'Beloved Bard', group: 'chat', metric: 'likes', goal: 1_000, how: 'Get 1,000 likes on your room messages.' },
  { id: 'toast_of_tavern', name: 'Toast of the Tavern', group: 'chat', metric: 'likes', goal: 10_000, how: 'Get 10,000 likes on your room messages.' },
  { id: 'living_legend', name: 'Living Legend', group: 'chat', metric: 'likes', goal: 500_000, how: 'Get 500,000 likes on your room messages.' },

  { id: 'good_company', name: 'Good Company', group: 'social', goal: 5, how: 'Have 5 friends.' },
  { id: 'circle', name: 'Circle of Friends', group: 'social', goal: 25, how: 'Have 25 friends.' },
  { id: 'butterfly', name: 'Social Butterfly', group: 'social', goal: 60, how: 'Have 60 friends.' },
  { id: 'heart', name: 'Heart of the Realm', group: 'social', goal: 100, how: 'Have 100 friends.' },
  { id: 'luminary', name: 'Luminary', group: 'social', goal: 300, how: 'Have 300 friends.' },

  { id: 'courier', name: 'Courier', group: 'mail', goal: 100, how: 'Send 100 private messages.' },
  { id: 'herald', name: 'Herald', group: 'mail', goal: 1_000, how: 'Send 1,000 private messages.' },
  { id: 'emissary', name: 'Emissary', group: 'mail', goal: 10_000, how: 'Send 10,000 private messages.' },
  { id: 'ravens', name: 'Master of Ravens', group: 'mail', goal: 100_000, how: 'Send 100,000 private messages.' },

  { id: 'shutterbug', name: 'Shutterbug', group: 'photos', goal: 20, how: 'You uploaded 20 photos to your profile.' },
  { id: 'scrapbooker', name: 'Scrapbooker', group: 'photos', goal: 50, how: 'You uploaded 50 photos to your profile.' },
  { id: 'curator', name: 'Curator', group: 'photos', goal: 100, how: 'You uploaded 100 photos to your profile.' },
  { id: 'master_of_light', name: 'Master of Light', group: 'photos', goal: 300, how: 'You uploaded 300 photos to your profile.' },

  { id: 'gift_bearer', name: 'Gift Bearer', group: 'gifts', goal: 100, how: 'Send 100 gifts.' },
  { id: 'generous_soul', name: 'Generous Soul', group: 'gifts', goal: 500, how: 'Send 500 gifts.' },
  { id: 'almsgiver', name: 'Almsgiver', group: 'gifts', goal: 1_000, how: 'Send 1,000 gifts.' },
  { id: 'grand_benefactor', name: 'Grand Benefactor', group: 'gifts', goal: 10_000, how: 'Send 10,000 gifts.' },

  { id: 'passing_glance', name: 'Passing Glance', group: 'views', goal: 100, how: 'Get 100 views on your profile.' },
  { id: 'talk_of_town', name: 'Talk of the Town', group: 'views', goal: 1_000, how: 'Get 1,000 views on your profile.' },
  { id: 'renowned', name: 'Renowned', group: 'views', goal: 10_000, how: 'Get 10,000 views on your profile.' },
  { id: 'household_name', name: 'Household Name', group: 'views', goal: 1_000_000, how: 'Get 1,000,000 views on your profile.' },
];

export const TROPHY_BY_ID = new Map(TROPHIES.map((t) => [t.id, t]));

/** Invite codes are 8 characters, shown as ABCD-EFGH. */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function normalizeInviteCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
export function formatInviteCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
