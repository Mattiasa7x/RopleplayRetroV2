/**
 * Trophies members earn just by using the site. The list order is the display order.
 * How each one is checked lives on the server (server/trophies.ts); the look of each
 * badge lives in the browser (client/src/trophyart.ts).
 */

export type TrophyGroup = 'time' | 'security' | 'chat';

export interface TrophyDef {
  id: string;
  name: string;
  group: TrophyGroup;
  /** How it's earned, shown under the badge. */
  how: string;
  /** Account age in hours (time trophies) or messages sent (chat trophies). */
  goal?: number;
}

export const TROPHY_GROUPS: { id: TrophyGroup; title: string }[] = [
  { id: 'time', title: 'Time on RoleplayRetro' },
  { id: 'security', title: 'Security' },
  { id: 'chat', title: 'Room chat' },
];

const DAY = 24;

export const TROPHIES: TrophyDef[] = [
  { id: 'noob', name: 'Noob', group: 'time', goal: 1, how: 'Your account is 1 hour old.' },
  { id: 'wanderer', name: 'Wanderer', group: 'time', goal: DAY, how: 'Your account is 1 day old.' },
  { id: 'regular', name: 'Tavern Regular', group: 'time', goal: 7 * DAY, how: 'Your account is 1 week old.' },
  { id: 'veteran', name: 'Veteran', group: 'time', goal: 30 * DAY, how: 'Your account is 30 days old.' },
  { id: 'old_guard', name: 'Old Guard', group: 'time', goal: 365 * DAY, how: 'Your account is 1 year old.' },

  { id: 'warded', name: 'Warded', group: 'security', how: 'Confirm your email, add a phone number and turn on two-factor sign-in.' },

  { id: 'chatterbox', name: 'Chatterbox', group: 'chat', goal: 100, how: 'Send 100 messages in rooms.' },
  { id: 'wordsmith', name: 'Wordsmith', group: 'chat', goal: 1_000, how: 'Send 1,000 messages in rooms.' },
  { id: 'storyteller', name: 'Storyteller', group: 'chat', goal: 10_000, how: 'Send 10,000 messages in rooms.' },
  { id: 'loremaster', name: 'Loremaster', group: 'chat', goal: 1_000_000, how: 'Send 1,000,000 messages in rooms.' },
];

export const TROPHY_BY_ID = new Map(TROPHIES.map((t) => [t.id, t]));
