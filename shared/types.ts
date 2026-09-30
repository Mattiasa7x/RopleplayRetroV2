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
  /** Read-only: only the owner and members they've given a voice can post. */
  readOnly: boolean;
  /** Whether this viewer may post right now. */
  canSpeak: boolean;
  /** Member rooms: your place on the room team, if any. */
  myRole: RoomRole | null;
  /** Member rooms: everyone on the room team, by user id (owner, moderators, operators). */
  roles: Record<string, RoomRole>;
  /** Moderators and operators by name; only sent to people who can manage the room. */
  team?: RoomTeamMemberDTO[];
}

/** A member room's team: the owner, then moderators, then operators. */
export type RoomRole = 'owner' | 'moderator' | 'operator';

/** A room ban or mute, for the owner's Bans and mutes list. */
export interface RoomSanctionDTO {
  id: string;
  handle: string;
  kind: 'mute' | 'kick' | 'ban';
  reason: string;
  issuedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface RoomTeamMemberDTO { handle: string; role: 'moderator' | 'operator' }

export interface RoomImageDTO {
  id: number;
  title: string;
  thumb: string;
  /** Gold Quill members only. */
  quill?: boolean;
  credit: string | null;
  creditUrl: string | null;
}

/** Someone in a chat room right now. Details are null when their profile isn't visible to you. */
export interface RoomPersonDTO {
  id: string;
  handle: string;
  quill?: boolean;
  /** Place on the room team (member rooms), or null. */
  role: RoomRole | null;
  avatar: string | null;
  /** Roleplay character's city and age as the member wrote them. Never the real age. */
  characterCity: string | null;
  characterAge: string | null;
  isFriend: boolean;
  self: boolean;
  /** The room's owner. */
  isOwner: boolean;
  /** May post while the room is read-only (owner, or given a voice). */
  voice: boolean;
}

/** A member in the Online Users list. Details are null when their profile is friends-only. */
export interface OnlineUserDTO {
  id: string;
  handle: string;
  avatar: string | null;
  quill?: boolean;
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
  readOnly: boolean;
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
  /** Regional rooms: listed under this section ("United States"), and this sub-section ("West") if any. */
  region: string | null;
  subregion: string | null;
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
  twoFactor: boolean;
  moderates: number[]; // room ids
  /** Gold Quill pass end (ISO), or null. */
  quillUntil: string | null;
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
  /** Gold Quill member showing the gold ring around their picture. */
  quill?: boolean;
}

/** Settings › Subscriptions: your Gold Quill pass and purchases. */
export interface QuillStatusDTO {
  active: boolean;
  /** When the current pass ends (ISO), if you've ever had one. */
  until: string | null;
  /** PayPal is set up, so passes can be bought. */
  available: boolean;
  /** Test mode: PayPal sandbox money, not real. */
  sandbox: boolean;
  history: { orderId: string; pass: 'day' | 'week' | 'month'; amount: string; status: 'completed' | 'pending'; date: string; until: string | null }[];
}

export type FriendState = 'none' | 'friends' | 'request_sent' | 'request_received' | 'self';

export interface PhotoDTO {
  id: string;
  /** Display version (up to 3840 × 2160). */
  url: string;
  /** Small version for grids. */
  thumb: string;
  private: boolean;
  /** Public photo still waiting for admin approval (only its owner and the admin ever see it). */
  pending?: boolean;
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
  /** Whether this viewer may open the friends list (owner always; others per the owner's privacy setting). */
  canViewFriends: boolean;
  /** Whether this viewer may see the member's gifts (owner always; others per their privacy setting). */
  canViewGifts: boolean;
  /** The gift they chose to show (catalog id), when this viewer may see gifts. */
  profileGift: string | null;
  /** Whether this viewer may send them a gift (confirmed email, not blocked, same side of 18). */
  canSendGift: boolean;
  /** Own profile only: people who viewed it since you last opened Views. */
  newViews?: number;
  /** Your own profile: people who viewed it in the last 90 days. */
  viewCount?: number;
  /** Gifts received (your own profile, or when they share their gifts). */
  giftCount?: number;
  /** The one trophy shown on the profile (the member's pick, else their newest), or null. */
  trophy: string | null;
  /** How many trophies they've earned (0 when the profile isn't visible). */
  trophyCount: number;
}

export interface ReceivedGiftDTO {
  id: string;
  gift: string;
  /** Null once the sender's account is deleted. */
  from: PublicUser | null;
  message: string | null;
  createdAt: string;
}
export interface MyGiftsDTO {
  gifts: ReceivedGiftDTO[];
  page: number;
  pages: number;
  total: number;
  /** The gift row shown on your profile. */
  profileGiftId: string | null;
}
export interface GiftAllowanceDTO {
  left: number;
  limit: number;
  /** When the next one frees up, if you're out. */
  nextAt: string | null;
}
export interface ProfileGiftsDTO {
  handle: string;
  allowed: boolean;
  /** Catalog ids with how many of each, most received first. */
  gifts: { gift: string; count: number }[];
  total: number;
}

export interface ProfileViewsDTO {
  views: { user: PublicUser; viewedAt: string }[];
  page: number;
  pages: number;
  total: number;
}

export interface ProfileFriendsDTO {
  handle: string;
  /** False when the owner keeps their friends list private from this viewer. */
  allowed: boolean;
  friends: PublicUser[];
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
  /** (Owner only) this photo is their profile picture, or will be once approved. */
  isMain?: boolean;
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
  social: (p: { kind: 'friend_request' | 'friend_accept' | 'comment' | 'gift'; from: string }) => void;
  dm: (p: { from: string; id: string }) => void;
  /** Read-only changed in a room: whether it's on and who has a voice (user ids). */
  'room:voice': (p: { roomId: number; readOnly: boolean; voices: string[] }) => void;
  /** The room team changed: everyone's role by user id. */
  'room:roles': (p: { roomId: number; roles: Record<string, RoomRole> }) => void;
  /** Newly earned trophies (ids from shared/trophies.ts). */
  trophy: (p: { ids: string[] }) => void;
}

export interface ClientToServer {
  'room:join': (p: { slug: string }, ack: (r: { ok: boolean; message?: string; roomId?: number }) => void) => void;
  'room:leave': () => void;
  'msg:send': (p: { slug: string; body: string }, ack: (r: SendResult) => void) => void;
  typing: (p: { slug: string }) => void;
}
