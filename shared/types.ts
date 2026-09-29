import type { CharacterSheet, RpStyle } from './config.js';
import type { Prefs } from './config.js';

/** Shapes shared by the HTTP API, the socket events and the browser client. */

export interface MessageDTO {
  id: string; // bigint as string
  roomId: number;
  userId: string;
  handle: string;
  body: string;
  mentions: string[]; // user ids
  createdAt: string; // ISO
}

export type RoomKind = 'site' | 'member';

export interface RoomDetail {
  id: number;
  slug: string;
  name: string;
  kind: RoomKind;
  description: string | null;
  whitelistOnly: boolean;
  slowModeSeconds: number;
  ownerHandle: string | null;
  /** Owner or admin: may edit the room, its invite list, or delete it. */
  canManage: boolean;
  /** May hide lines and kick/mute people here (owner, admin, or assigned site moderator). */
  canModerate: boolean;
  /** Invite list (handles); only sent to people who can manage the room. */
  whitelist?: string[];
  /** Room picture (wide) or null for the colour art. */
  image: string | null;
  imageId: number | null;
  imageCredit: { name: string; url: string } | null;
  online: number;
  /** Member room owner's chat filter: messages with swear words can't be sent here. */
  chatFilter: boolean;
}

export interface RoomImageDTO {
  id: number;
  title: string;
  thumb: string;
  credit: string | null;
  creditUrl: string | null;
}

/** Someone in a chat room right now. Details are null when their profile isn't visible to you. */
export interface RoomPersonDTO {
  id: string;
  handle: string;
  avatar: string | null;
  /** Roleplay character's city and age as the member wrote them. Never the real age. */
  characterCity: string | null;
  characterAge: string | null;
  isFriend: boolean;
  self: boolean;
}

/** A member in the Online Users list (adults only). Details are null when their profile is friends-only. */
export interface OnlineUserDTO {
  id: string;
  handle: string;
  avatar: string | null;
  rpStyle: string | null;
  /** "33, M, Hyrule": character age, gender and city. */
  characterLine: string | null;
  isFriend: boolean;
}

export interface OnlineUsersDTO {
  users: OnlineUserDTO[];
  total: number;
  page: number;
  pages: number;
}

export interface RoomPeopleDTO {
  people: RoomPersonDTO[];
  /** People here you've ignored or blocked (not listed). */
  hidden: number;
}

export interface HistoryPage {
  room: RoomDetail;
  /** Oldest → newest within the page, like a classic chat screen. */
  messages: MessageDTO[];
  /** 1 = newest page. */
  page: number;
  totalPages: number;
  /** Pass as ?before= to load the next older page, or null at the oldest kept page. */
  olderCursor: string | null;
  /** Pass as ?after= to load the next newer page, or null when this is page 1. */
  newerCursor: string | null;
}

export interface RoomSummary {
  id: number;
  slug: string;
  name: string;
  category: string;
  kind: RoomKind;
  description: string | null;
  whitelistOnly: boolean;
  ownerHandle: string | null;
  isOwner: boolean;
  online: number;
  minTrustToPost: number;
  unreadMentions: number;
  favorite: boolean;
  /** Room picture thumbnail, or null for the colour art. */
  image: string | null;
}

export interface MeDTO {
  id: string;
  handle: string;
  trust: number;
  email: string;
  emailVerified: boolean;
  prefs: Prefs;
  /** Under 18 (or birthdate unknown): chat filter and privacy locks apply. */
  isMinor: boolean;
  lockedPrefs: string[];
  twoFactor: boolean;
  moderates: number[]; // room ids
}

export interface LoginResult {
  /** Present when the account has 2FA on: send the code with this ticket to /api/login/2fa. */
  twoFactorTicket?: string;
  me?: MeDTO;
}

export interface SessionInfo {
  id: string; // short public id
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export interface PublicUser {
  id: string;
  handle: string;
  avatar: string | null; // URL
  online?: boolean;
}

export type FriendState = 'none' | 'friends' | 'request_sent' | 'request_received' | 'self';

export interface PhotoDTO {
  id: string;
  /** Display version (up to 2560 px). */
  url: string;
  /** Small version for grids. */
  thumb: string;
  private: boolean;
}

/** The signed-in member's own private details. Never about anyone else. */
export interface AccountDTO {
  handle: string;
  email: string;
  emailVerified: boolean;
  phone: string | null;
  /** Real birthdate, YYYY-MM-DD. */
  birthdate: string | null;
  /** Your permanent invite code (8 characters, no dash). */
  inviteCode: string;
  /** People who joined with your code and confirmed their email. */
  invites: number;
  /** Joined with your code but haven't confirmed their email yet. */
  invitesPending: number;
}

export interface ProfileDTO extends PublicUser {
  bio: string | null;
  /** Character's age (from their character birthday). Never the member's real age. */
  characterAge: string | null;
  characterGender: string | null;
  /** Roleplay character's city. */
  characterCity: string | null;
  /** Gold nameplate: preferred roleplay style. */
  rpStyle: RpStyle | null;
  /** Filled-in character sheet fields. */
  characterSheet: CharacterSheet;
  /** Wide banner picture, or null. */
  banner: string | null;
  /** Background theme: one of the room pictures. */
  theme: { id: number; image: string; title: string } | null;
  /** Only sent on your own profile: the editable values. */
  own?: { characterBirthday: string | null; legacyAge: string | null; profileTrophy: string | null };
  trustLabel: string;
  /** Public photos; the first is the profile picture. */
  photos: PhotoDTO[];
  /** Owner, or a friend granted album access. */
  canViewAlbum: boolean;
  albumCount: number;
  friendCount: number;
  friendState: FriendState;
  canComment: boolean;
  /** False when the profile is friends-only and the viewer isn't a friend: only the name and picture show. */
  visible: boolean;
  blockedByMe: boolean;
  /** The one trophy shown on the profile (the member's pick, else their newest), or null. */
  trophy: string | null;
  /** How many trophies they've earned (0 when the profile isn't visible). */
  trophyCount: number;
}

export interface TrophyPageDTO {
  handle: string;
  self: boolean;
  visible: boolean;
  earned: { id: string; earnedAt: string }[];
  /** Only on your own trophy page. */
  progress?: {
    accountHours: number;
    messages: number;
    privateMessages: number;
    friends: number;
    /** People who joined with your code and confirmed their email. */
    invites: number;
    /** Photos you have now (profile and album). */
    photos: number;
    /** Days in a row with a status update (0 once broken), and the best ever. */
    statusStreak: number;
    bestStatusStreak: number;
    /** Which profile parts are filled in (for Fully Realized). */
    profile: { birthday: boolean; gender: boolean; city: boolean; style: boolean; about: boolean; sheetFilled: number; sheetTotal: number };
    security: { email: boolean; phone: boolean; twoFactor: boolean };
  };
}

export interface CommentDTO {
  id: string;
  author: PublicUser;
  body: string;
  createdAt: string;
  canDelete: boolean;
}

export interface CommentPageDTO {
  comments: CommentDTO[];
  /** 1 = newest. */
  page: number;
  pages: number;
  total: number;
}

export interface PhotoPageDTO {
  photo: PhotoDTO;
  owner: PublicUser;
  canComment: boolean;
  /** Owner's own photo. */
  mine: boolean;
}

export interface StatusDTO {
  id: string;
  author: PublicUser;
  body: string;
  createdAt: string;
  canDelete: boolean;
}

export interface FriendsDTO {
  friends: PublicUser[];
  incoming: PublicUser[];
  outgoing: PublicUser[];
}

export interface DirectMessageDTO {
  id: string;
  mine: boolean;
  body: string | null;
  photo: PhotoDTO | null;
  /** The message had a photo that was deleted or is no longer shared with you. */
  photoRemoved: boolean;
  createdAt: string;
  /** For your own messages: whether they've been read. */
  read: boolean;
}

export interface ThreadDTO {
  with: PublicUser;
  canSend: boolean;
  reason: string | null;
  /** Oldest → newest. */
  messages: DirectMessageDTO[];
  olderCursor: string | null;
}

export interface ConversationDTO {
  with: PublicUser;
  preview: string;
  lastFromMe: boolean;
  lastAt: string;
  unread: number;
}

/** One entry in the friend activity feed. Your own actions never appear in it. */
export type ActivityDTO =
  | { kind: 'status'; key: string; at: string; actor: PublicUser; statusId: string; body: string }
  | { kind: 'comment'; key: string; at: string; actor: PublicUser; commentId: string; body: string; target: PublicUser; onMe: boolean }
  | { kind: 'photos'; key: string; at: string; actor: PublicUser; photos: PhotoDTO[]; count: number }
  | { kind: 'profile'; key: string; at: string; actor: PublicUser };

export interface HomeDTO {
  /** Your most recent status, shown above the status box. */
  myStatus: StatusDTO | null;
  feed: ActivityDTO[];
  /** Pass as ?before= for older activity, or null when there's no more. */
  olderCursor: string | null;
  /** The six busiest rooms you can enter, busiest first. */
  topRooms: RoomSummary[];
  pendingRequests: number;
}

export interface ApiError {
  error: string; // machine code
  message: string; // human sentence, safe to show
}

export type SendResult = { ok: true; message: MessageDTO } | ({ ok: false } & ApiError);

export interface ServerToClient {
  'msg:new': (m: MessageDTO) => void;
  'msg:hidden': (p: { id: string; roomId: number }) => void;
  presence: (p: { roomId: number; online: number }) => void;
  typing: (p: { roomId: number; handle: string }) => void;
  mention: (p: { roomId: number; roomSlug: string; from: string; messageId: string }) => void;
  kicked: (p: { roomId: number; reason: string; minutes: number }) => void;
  notice: (p: { message: string }) => void;
  social: (p: { kind: 'friend_request' | 'friend_accept' | 'comment'; from: string }) => void;
  dm: (p: { from: string; id: string }) => void;
  /** Newly earned trophies (ids from shared/trophies.ts). */
  trophy: (p: { ids: string[] }) => void;
}

export interface ClientToServer {
  'room:join': (p: { slug: string }, ack: (r: { ok: boolean; message?: string; roomId?: number }) => void) => void;
  'room:leave': () => void;
  'msg:send': (p: { slug: string; body: string }, ack: (r: SendResult) => void) => void;
  typing: (p: { slug: string }) => void;
}
