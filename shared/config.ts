/**
 * Single source of truth for chat rules and safety thresholds.
 * Imported by both the server and the browser bundle, so the two can never disagree.
 */

/** Product name. Run a trademark search before launch. */
export const SITE_NAME = 'RoleplayRetro';

export const CHAT = {
  /** Max user-visible characters (grapheme clusters) per message. An emoji counts as 1. */
  MAX_CHARS: 420,
  /** Messages shown per page. */
  PAGE_SIZE: 10,
  /** Pages of history kept per room. */
  MAX_PAGES: 20,
  /** Counter turns amber when this many characters remain. */
  WARN_REMAINING: 40,
  /** Max @mentions in one message. */
  MAX_MENTIONS: 3,
} as const;

/** Messages retained per room: PAGE_SIZE × MAX_PAGES = 200. Older ones are pruned on insert. */
export const RETAINED_PER_ROOM = CHAT.PAGE_SIZE * CHAT.MAX_PAGES;

/** Any existing username (older ones may contain digits). Used to look names up. */
export const HANDLE_PATTERN = /^[A-Za-z0-9_-]{3,16}$/;
/**
 * New usernames: 3–16 characters of letters, hyphens (-) and underscores (_). The first and
 * last characters must be letters, so a name never starts or ends with - or _.
 */
export const NEW_HANDLE_PATTERN = /^[A-Za-z][A-Za-z_-]{1,14}[A-Za-z]$/;
export const PASSWORD_MIN = 10;

export enum Trust {
  New = 0,
  Verified = 1,
  Established = 2,
  RoomModerator = 3,
  Admin = 4,
}

export const TRUST_LABEL: Record<Trust, string> = {
  [Trust.New]: 'New',
  [Trust.Verified]: 'Verified',
  [Trust.Established]: 'Established',
  [Trust.RoomModerator]: 'Room moderator',
  [Trust.Admin]: 'Admin',
};

export const SAFETY = {
  /** VPN guard: new accounts (this many days) and accounts banned before can't use a VPN; sign-ups never can. */
  vpnNewAccountDays: 7,
  /** Sliding-window message limits per user, by trust level. */
  rateLimit: {
    windowMs: 10_000,
    maxByTrust: { 0: 3, 1: 3, 2: 5, 3: 10, 4: 10 } as Record<number, number>,
  },
  /** Same/near-identical message blocked if repeated within this window. */
  floodWindowMs: 60_000,
  /** Messages with at least this many letters and this share of capitals are rejected. */
  capsMinLetters: 20,
  capsRatio: 0.7,
  /** Accounts a single network prefix may create per day. */
  signupsPerNetworkPerDay: 3,
  /** Login attempts per handle+network per 15 minutes. */
  loginAttemptsPer15Min: 10,
  /** Distinct Established+ reporters that auto-hide a message pending review. */
  autoHideReports: 3,
  /** Promotion to Established. */
  establishedMinDays: 7,
  establishedMinMessages: 100,
  establishedCleanDays: 30,
  /** Verified users can't start private messages until the account is this old (future PM feature). */
  pmMinAccountHours: 24,
  /** Hashed device/network signals are deleted after this many days. */
  signalRetentionDays: 90,
  verificationCodeMinutes: 15,
  verificationMaxAttempts: 5,
  sessionDays: 30,
} as const;

/**
 * Site rooms: the fixed pool of 20 official rooms every account can use.
 * They run in strict auto-moderation mode (see server/safety/strikes.ts).
 */
export const SITE_ROOMS = {
  count: 20,
  /** Links are blocked for everyone below room moderator, whatever their trust level. */
  blockLinksForAll: true,
  maxMentions: 2,
  /** Accounts younger than this post at most once per `newAccountSlowSeconds`. */
  newAccountHours: 24,
  newAccountSlowSeconds: 10,
  /** Strikes = messages rejected for rule-breaking (filter, flood, caps, spam, rate). */
  strikeWindowMinutes: 10,
  strikesToRoomMute: 3,
  roomMuteMinutes: 15,
  strikesToSiteMute: 6, // within one hour, across all site rooms
  siteMuteMinutes: 60,
  /** Established reporters needed to auto-hide a line (member rooms use SAFETY.autoHideReports). */
  autoHideReports: 2,
  /** Joining more rooms than this per minute is treated as suspicious. */
  maxRoomJoinsPerMinute: 8,
} as const;

/** Member rooms: created by verified members; optionally invite-only (whitelist). */
/** Automatic clean-up of things nobody uses. */
export const INACTIVITY = {
  /** A member room with no messages for this long is deleted (site and regional rooms never are). */
  roomDays: 7,
  /** An account nobody has signed in to for this long is deleted, with all its data. */
  accountDays: 730,
  /** Email a warning this many days before deleting an inactive account. */
  warnDaysBefore: 30,
} as const;

export const MEMBER_ROOMS = {
  maxOwnedPerUser: 3,
  /** Room team a member-room owner can appoint. */
  maxModerators: 10,
  maxOperators: 20,
  maxWhitelist: 200,
  nameMin: 3,
  nameMax: 32,
  descriptionMax: 140,
} as const;

export const AGE = {
  /**
   * The site is for adults only: the youngest real age allowed to sign up or sign in. Checked
   * against the real birthdate given at signup, which is never shown and can't be changed.
   * (18 here matches is_adult_user() in schema.sql.)
   */
  minimum: 18,
} as const;

/**
 * Character ages are free (newborns to ancient beings), but a profile marked NSFW must show a
 * character at least this old. Sexual content involving characters under 18 isn't allowed anywhere.
 */
export const NSFW_CHARACTER_MIN_AGE = 18;

/** Date of the Terms of Service now in force (client/public/terms.html). Stored with each signup. */
export const TERMS_VERSION = '2026-09-29';

/** Character age: public, roleplay-only free text on the profile ("0", "3,000 years"). Never affects safety rules. */
export const CHARACTER_AGE = { maxLength: 24 } as const;
/** Where the character lives, free text (a real city, "Gotham", "The Moon"). */
export const CHARACTER_CITY = { maxLength: 75 } as const;
/** Character gender as the member writes it: "M", "F", "NB", "Male"... */
export const CHARACTER_GENDER = { maxLength: 10 } as const;

/** Roleplay styles a member can show on the gold nameplate under their picture (one at a time). */
export const RP_STYLES = ['Literary', 'Casual', 'Worldbuilding', 'Slice of Life', 'NSFW', 'Chatter'] as const;
export type RpStyle = (typeof RP_STYLES)[number];

/** The character sheet: a classic roleplay sheet, every field optional. */
export const CHARACTER_SHEET = [
  { key: 'fullName', label: 'Full name', max: 80 },
  { key: 'aliases', label: 'Nicknames / aliases', max: 120 },
  { key: 'species', label: 'Species / race', max: 60 },
  { key: 'occupation', label: 'Occupation', max: 80 },
  { key: 'affiliation', label: 'Allegiance / faction', max: 80 },
  { key: 'height', label: 'Height', max: 30 },
  { key: 'build', label: 'Build', max: 60 },
  { key: 'hair', label: 'Hair', max: 60 },
  { key: 'eyes', label: 'Eyes', max: 60 },
  { key: 'marks', label: 'Distinguishing features', max: 300, long: true },
  { key: 'personality', label: 'Personality', max: 1000, long: true },
  { key: 'skills', label: 'Skills & abilities', max: 1000, long: true },
  { key: 'weaknesses', label: 'Weaknesses & flaws', max: 600, long: true },
  { key: 'likes', label: 'Likes', max: 300, long: true },
  { key: 'dislikes', label: 'Dislikes', max: 300, long: true },
  { key: 'relationships', label: 'Relationships', max: 1000, long: true },
] as const;
export type CharacterSheet = Partial<Record<(typeof CHARACTER_SHEET)[number]['key'], string>>;

/** Phone number on the account: digits with an optional leading +, set once. */
export const PHONE_PATTERN = /^\+?[0-9]{7,15}$/;

/** Whole years from a character's birthday (YYYY-MM-DD, any past date) to today. */
export function characterAgeFrom(birthday: string, today = new Date()): number {
  const [y, m, d] = birthday.split('-').map(Number);
  let age = today.getUTCFullYear() - y;
  const mm = today.getUTCMonth() + 1, dd = today.getUTCDate();
  if (mm < m || (mm === m && dd < d)) age--;
  return Math.max(0, age);
}

export const PROFILE = {
  /** "About" on the profile: a character's story. */
  bioMax: 1000,
  /** Largest photo file accepted, in bytes (phone originals are usually 2-20 MB). */
  photoMaxBytes: 30 * 1024 * 1024,
  /** Any resolution is accepted up to this many pixels (250 MP covers every phone camera). */
  photoMaxInputPixels: 250_000_000,
  /** Stored display version: at most 3840 × 2160 (4K), or 2160 × 3840 for portrait photos. Larger photos are scaled down to fit. */
  photoMaxLong: 3840,
  photoMaxShort: 2160,
  /** Most photos a member can keep: public photos, and photos in the private album. */
  publicPhotoMax: 300,
  privatePhotoMax: 50,
  /** Stored thumbnail: longest edge in pixels, used in grids and lists. */
  photoThumbEdge: 480,
  /** Anti-spam: photo uploads allowed per hour. */
  photoUploadsPerHour: 120,
  /** A new photo this close (bits of 64) to another member's photo is refused as a copy. */
  photoCloneDistance: 5,
  commentMax: 420,
  /** Each profile and each photo keeps its newest 1000 comments; the oldest goes first. */
  commentsKept: 1000,
  /** Comments shown on the profile itself, and per page on the full comments page. */
  commentsOnProfile: 5,
  commentsPerPage: 10,
  /** Profile viewers per page, and how long a view is remembered. */
  viewsPerPage: 20,
  viewsKeptDays: 90,
  /** Newest photos shown on the profile above the gallery button. */
  recentPhotos: 5,
  statusMax: 420,
  feedPageSize: 20,
} as const;

/** Private messages: friends only, same 420-character rule and filters as chat. */
export const MESSAGES = {
  pageSize: 30,
  perMinute: 20,
} as const;

export const VISIBILITY = ['everyone', 'friends'] as const;
export type Visibility = (typeof VISIBILITY)[number];
/** Who may open your friends list ('me' = only you). */
export const FRIENDS_LIST_VISIBILITY = ['everyone', 'friends', 'me'] as const;
export type FriendsListVisibility = (typeof FRIENDS_LIST_VISIBILITY)[number];
export const COMMENT_PERMISSION = ['everyone', 'friends', 'nobody'] as const;
export type CommentPermission = (typeof COMMENT_PERMISSION)[number];
export const FRIEND_REQUESTS = ['everyone', 'nobody'] as const;
export type FriendRequestPermission = (typeof FRIEND_REQUESTS)[number];

/** Every setting stored in users.prefs, with defaults. */
export interface Prefs {
  theme: Theme;
  textSize: TextSize;
  /** Mask mature language in chat, comments and statuses. */
  chatFilter: boolean;
  profileVisibility: Visibility;
  whoCanComment: CommentPermission;
  whoCanFriend: FriendRequestPermission;
  /** Who can open your friends list. Private ('me') unless you allow it. */
  friendsList: FriendsListVisibility;
  /** Who can see the gifts you've received (never the messages or senders). Private unless you allow it. */
  giftsVisibility: FriendsListVisibility;
  showOnline: boolean;
  mentionAlerts: boolean;
  friendAlerts: boolean;
  /** Browser push notifications (phone/computer notifications when the site isn't open). */
  pushAlerts: boolean;
  enterToSend: boolean;
  showTimestamps: boolean;
  /** Gold Quill members: show the gold ring around your picture. */
  showQuillBadge: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  textSize: 'm',
  chatFilter: true,
  profileVisibility: 'everyone',
  whoCanComment: 'friends',
  whoCanFriend: 'everyone',
  friendsList: 'me',
  giftsVisibility: 'me',
  showOnline: true,
  mentionAlerts: true,
  friendAlerts: true,
  pushAlerts: false,
  enterToSend: true,
  showTimestamps: true,
  showQuillBadge: true,
};


export const MOD = {
  kickMinutes: 15,
  muteMinMinutes: 5,
  muteMaxMinutes: 7 * 24 * 60,
} as const;

/** Light = white background, black text, red borders. Dark = black background, white text, red borders. */
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
export const TEXT_SIZES = ['s', 'm', 'l', 'xl'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/**
 * Family tree on a character's profile: the people in their story. Each relation belongs to a
 * generation row of the tree (grandparents at the top, grandchildren at the bottom); extended
 * family and anything custom ("other") are listed under the tree.
 */
export type FamilyGroup = 'grandparents' | 'parents' | 'self' | 'children' | 'grandchildren' | 'extended' | 'other';
export const FAMILY_GROUPS: { id: FamilyGroup; title: string }[] = [
  { id: 'grandparents', title: 'Grandparents' },
  { id: 'parents', title: 'Parents' },
  { id: 'self', title: 'Siblings & partners' },
  { id: 'children', title: 'Children' },
  { id: 'grandchildren', title: 'Grandchildren' },
  { id: 'extended', title: 'Extended family' },
  { id: 'other', title: 'Others' },
];
export const FAMILY_RELATIONS: { id: string; label: string; group: FamilyGroup }[] = [
  { id: 'grandmother', label: 'Grandmother', group: 'grandparents' },
  { id: 'grandfather', label: 'Grandfather', group: 'grandparents' },
  { id: 'grandparent', label: 'Grandparent', group: 'grandparents' },
  { id: 'mother', label: 'Mother', group: 'parents' },
  { id: 'father', label: 'Father', group: 'parents' },
  { id: 'parent', label: 'Parent', group: 'parents' },
  { id: 'stepmother', label: 'Stepmother', group: 'parents' },
  { id: 'stepfather', label: 'Stepfather', group: 'parents' },
  { id: 'guardian', label: 'Guardian', group: 'parents' },
  { id: 'spouse', label: 'Spouse', group: 'self' },
  { id: 'partner', label: 'Partner', group: 'self' },
  { id: 'sister', label: 'Sister', group: 'self' },
  { id: 'brother', label: 'Brother', group: 'self' },
  { id: 'sibling', label: 'Sibling', group: 'self' },
  { id: 'twin', label: 'Twin', group: 'self' },
  { id: 'half_sibling', label: 'Half-sibling', group: 'self' },
  { id: 'step_sibling', label: 'Step-sibling', group: 'self' },
  { id: 'daughter', label: 'Daughter', group: 'children' },
  { id: 'son', label: 'Son', group: 'children' },
  { id: 'child', label: 'Child', group: 'children' },
  { id: 'stepchild', label: 'Stepchild', group: 'children' },
  { id: 'adopted_child', label: 'Adopted child', group: 'children' },
  { id: 'granddaughter', label: 'Granddaughter', group: 'grandchildren' },
  { id: 'grandson', label: 'Grandson', group: 'grandchildren' },
  { id: 'grandchild', label: 'Grandchild', group: 'grandchildren' },
  { id: 'aunt', label: 'Aunt', group: 'extended' },
  { id: 'uncle', label: 'Uncle', group: 'extended' },
  { id: 'cousin', label: 'Cousin', group: 'extended' },
  { id: 'niece', label: 'Niece', group: 'extended' },
  { id: 'nephew', label: 'Nephew', group: 'extended' },
  { id: 'in_law', label: 'In-law', group: 'extended' },
  { id: 'godparent', label: 'Godparent', group: 'extended' },
  { id: 'godchild', label: 'Godchild', group: 'extended' },
  { id: 'other', label: 'Other…', group: 'other' },
];
export const FAMILY_TREE = { maxMembers: 40, nameMax: 60, labelMax: 30, noteMax: 150 };
