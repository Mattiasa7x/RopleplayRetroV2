/**
 * Trophies members earn just by using the site. The list order is the display order.
 * How each one is checked lives on the server (server/trophies.ts); the look of each
 * badge lives in the browser (client/src/trophyart.ts).
 */

export type TrophyGroup = 'time' | 'security' | 'chat' | 'social';

export interface TrophyDef {
  id: string;
  name: string;
  group: TrophyGroup;
  /** How it's earned, shown under the badge. */
  how: string;
  /** Account age in hours (time), messages sent in rooms (chat) or friends (social). */
  goal?: number;
}

export const TROPHY_GROUPS: { id: TrophyGroup; title: string }[] = [
  { id: 'time', title: 'Time on RoleplayRetro' },
  { id: 'security', title: 'Security' },
  { id: 'chat', title: 'Room chat' },
  { id: 'social', title: 'Friends' },
];

const DAY = 24;
const YEAR = 365 * DAY;

export const TROPHIES: TrophyDef[] = [
  { id: 'noob', name: 'Noob', group: 'time', goal: 1, how: 'Your account is 1 hour old.' },
  { id: 'wanderer', name: 'Wanderer', group: 'time', goal: 183 * DAY, how: 'Your account is 6 months old.' },
  { id: 'regular', name: 'Tavern Regular', group: 'time', goal: YEAR, how: 'Your account is 1 year old.' },
  { id: 'veteran', name: 'Veteran', group: 'time', goal: 2 * YEAR + DAY, how: 'Your account is 2 years old.' },
  { id: 'old_guard', name: 'Old Guard', group: 'time', goal: 5 * YEAR + 2 * DAY, how: 'Your account is 5 years old.' },

  { id: 'warded', name: 'Warded', group: 'security', how: 'Confirm your email, add a phone number and turn on two-factor sign-in.' },

  { id: 'chatterbox', name: 'Gift of Gab', group: 'chat', goal: 100, how: 'Send 100 messages in rooms.' },
  { id: 'wordsmith', name: 'Wordsmith', group: 'chat', goal: 1_000, how: 'Send 1,000 messages in rooms.' },
  { id: 'storyteller', name: 'Storyteller', group: 'chat', goal: 10_000, how: 'Send 10,000 messages in rooms.' },
  { id: 'loremaster', name: 'Loremaster', group: 'chat', goal: 1_000_000, how: 'Send 1,000,000 messages in rooms.' },

  { id: 'good_company', name: 'Good Company', group: 'social', goal: 5, how: 'Have 5 friends.' },
  { id: 'circle', name: 'Circle of Friends', group: 'social', goal: 25, how: 'Have 25 friends.' },
  { id: 'butterfly', name: 'Social Butterfly', group: 'social', goal: 50, how: 'Have 50 friends.' },
  { id: 'heart', name: 'Heart of the Realm', group: 'social', goal: 100, how: 'Have 100 friends.' },
];

export const TROPHY_BY_ID = new Map(TROPHIES.map((t) => [t.id, t]));
