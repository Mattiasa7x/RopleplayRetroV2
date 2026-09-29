import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TROPHIES } from '../shared/trophies.js';
import { CHARACTER_SHEET, type CharacterSheet } from '../shared/config.js';
import type { TrophyPageDTO } from '../shared/types.js';
import { parse, requireUser } from './http.js';
import { profileAccess } from './profiles.js';
import { db } from './store.js';

/**
 * Awarding trophies. Every rule is one SQL condition on the member's row (`u`), so one
 * statement can check one member or everybody at once. Earned trophies are kept for good,
 * even if, say, two-factor is later turned off.
 */
const FRIENDS = `(SELECT count(*) FROM friendships f WHERE (f.user_a = u.id OR f.user_b = u.id) AND f.status = 'accepted')`;
/** Invitees who joined with this member's code and confirmed their email. */
const INVITES = `(SELECT count(*) FROM users i WHERE i.invited_by = u.id AND i.email_verified_at IS NOT NULL)`;
/** Every profile field and every character-sheet section filled in. */
const SHEET_KEYS = CHARACTER_SHEET.map((f) => f.key);
const PROFILE_COMPLETE = `(u.character_birthday IS NOT NULL AND btrim(coalesce(u.character_gender, '')) <> ''
  AND btrim(coalesce(u.character_city, '')) <> '' AND u.rp_style IS NOT NULL AND btrim(coalesce(u.bio, '')) <> ''
  AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[${SHEET_KEYS.map((k) => `'${k}'`).join(', ')}]) AS k(key)
                   WHERE btrim(coalesce(u.character_sheet ->> k.key, '')) = ''))`;
/** Photos they have now, public and private album. */
const PHOTOS = `(SELECT count(*) FROM profile_photos p WHERE p.user_id = u.id)`;
/** Status-streak trophies (account group, goal in days). */
const STREAK_IDS = ['diarist', 'chronicler', 'keeper_of_days'];
const RULE: Record<string, string> = {
  fully_realized: PROFILE_COMPLETE,
  warded: 'u.email_verified_at IS NOT NULL AND u.phone IS NOT NULL AND u.totp_enabled',
};
for (const t of TROPHIES) {
  if (t.group === 'time') RULE[t.id] = `u.created_at <= now() - interval '${Number(t.goal)} hours'`;
  if (t.group === 'chat') RULE[t.id] = `u.message_count >= ${Number(t.goal)}`;
  if (t.group === 'social') RULE[t.id] = `${FRIENDS} >= ${Number(t.goal)}`;
  if (STREAK_IDS.includes(t.id)) RULE[t.id] = `u.status_best_streak >= ${Number(t.goal)}`;
  else if (t.group === 'account' && t.goal) RULE[t.id] = `${INVITES} >= ${Number(t.goal)}`;
  if (t.group === 'photos') RULE[t.id] = `${PHOTOS} >= ${Number(t.goal)}`;
  if (t.group === 'mail') RULE[t.id] = `u.dm_count >= ${Number(t.goal)}`;
}
const AWARD_SQL = `
  INSERT INTO user_trophies (user_id, trophy_id)
  SELECT u.id, t.id FROM users u
   CROSS JOIN (VALUES ${TROPHIES.map((t) => `('${t.id}')`).join(', ')}) AS t(id)
   WHERE ($1::bigint[] IS NULL OR u.id = ANY($1::bigint[]))
     AND ($2::text[] IS NULL OR t.id = ANY($2::text[]))
     AND CASE t.id ${TROPHIES.map((t) => `WHEN '${t.id}' THEN (${RULE[t.id]})`).join(' ')} ELSE false END
  ON CONFLICT DO NOTHING
  RETURNING user_id::text AS user_id`;

/** Counts at which a chat trophy is earned, so sending a message only checks when it matters. */
const CHAT_GOALS = new Set(TROPHIES.filter((t) => t.group === 'chat').map((t) => t.goal!));

type Notify = (userId: string, trophyIds: string[]) => void;
let notify: Notify = () => {};

/** Tell a member's open tabs about trophies they haven't seen yet (a tab confirms when shown). */
export async function sendUnseen(userId: string): Promise<void> {
  const { rows } = await db.query<{ trophy_id: string }>(
    'SELECT trophy_id FROM user_trophies WHERE user_id = $1 AND seen_at IS NULL ORDER BY earned_at, trophy_id', [userId]);
  if (rows.length) notify(userId, rows.map((r) => r.trophy_id));
}

const TIME_IDS = TROPHIES.filter((t) => t.group === 'time').map((t) => t.id);
const SOCIAL_IDS = TROPHIES.filter((t) => t.group === 'social').map((t) => t.id);

/** Award whatever these members (or everyone, with null) have newly earned, and tell them. */
export async function awardTrophies(userIds: string[] | null, only: string[] | null = null): Promise<void> {
  const { rows } = await db.query<{ user_id: string }>(AWARD_SQL, [userIds, only]);
  for (const id of new Set(rows.map((r) => r.user_id))) await sendUnseen(id);
}

/** After a room message: only worth checking when the count lands on a goal. */
export function afterRoomMessage(userId: string, count: number): void {
  if (CHAT_GOALS.has(count)) void awardTrophies([userId]).catch((e) => console.error(e));
}

/** After a security change (email confirmed, phone added, two-factor on). */
export function afterSecurityChange(userId: string): void {
  void awardTrophies([userId]).catch((e) => console.error(e));
}

const MAIL_GOALS = new Set(TROPHIES.filter((t) => t.group === 'mail').map((t) => t.goal!));

/** After a private message: only worth checking when the count lands on a goal. */
export function afterPrivateMessage(userId: string, count: number): void {
  if (MAIL_GOALS.has(count)) void awardTrophies([userId]).catch((e) => console.error(e));
}

/** When a new member confirms their email, the person who invited them may reach a goal. */
export async function afterInviteeConfirmed(userId: string): Promise<void> {
  const { rows } = await db.query<{ invited_by: string | null }>('SELECT invited_by::text AS invited_by FROM users WHERE id = $1', [userId]);
  if (rows[0]?.invited_by) await awardTrophies([rows[0].invited_by]);
}

/** After a status update (the streak may have reached a goal). */
export function afterStatusPost(userId: string): void {
  void awardTrophies([userId], STREAK_IDS).catch((e) => console.error(e));
}

/** After the profile is edited. */
export function afterProfileEdit(userId: string): void {
  void awardTrophies([userId], ['fully_realized']).catch((e) => console.error(e));
}

const PHOTO_IDS = TROPHIES.filter((t) => t.group === 'photos').map((t) => t.id);
/** After a photo is uploaded. */
export function afterPhotoUpload(userId: string): void {
  void awardTrophies([userId], PHOTO_IDS).catch((e) => console.error(e));
}

/** After a friendship is accepted (both people may reach a goal). */
export function afterFriendsChange(userIds: string[]): void {
  void awardTrophies(userIds, SOCIAL_IDS).catch((e) => console.error(e));
}

/**
 * Account-age goals were lengthened after launch: take back age trophies that no longer
 * qualify. (Other trophies are kept for good once earned.)
 */
async function revokeStaleAgeTrophies(): Promise<void> {
  await db.query(
    `DELETE FROM user_trophies x USING users u
      WHERE u.id = x.user_id AND x.trophy_id = ANY($1::text[])
        AND NOT CASE x.trophy_id ${TROPHIES.filter((t) => t.group === 'time').map((t) => `WHEN '${t.id}' THEN (${RULE[t.id]})`).join(' ')} ELSE true END`,
    [TIME_IDS]);
}

/** When someone connects: catch up their account-age trophies, then show anything unseen. */
export async function checkOnConnect(userId: string): Promise<void> {
  await db.query(AWARD_SQL, [[userId], TIME_IDS]);
  await sendUnseen(userId);
}

/**
 * Start the hourly check (account-age trophies depend only on the clock). Hourly rather than
 * every minute so an idle site lets the database sleep; people online also get checked on connect.
 */
export function startTrophies(n: Notify, log: (e: unknown) => void): NodeJS.Timeout {
  notify = n;
  // first start: catches up every member on every trophy
  void revokeStaleAgeTrophies().then(() => awardTrophies(null)).catch(log);
  // After that only account age needs the clock; everything else is checked when it changes.
  const timer = setInterval(() => void awardTrophies(null, TIME_IDS).catch(log), 3_600_000);
  timer.unref();
  return timer;
}

const SeenBody = z.object({ ids: z.array(z.string().max(40)).max(50) });

export function registerTrophyRoutes(app: FastifyInstance) {
  /** A member's trophy case. Your own also shows how close you are to the rest. */
  app.get<{ Params: { handle: string } }>('/api/trophies/:handle', async (req): Promise<TrophyPageDTO> => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    const self = a.target.id === u.id;
    if (!a.visible) return { handle: a.target.handle, self, visible: false, earned: [] };
    const { rows } = await db.query<{ trophy_id: string; earned_at: Date }>(
      'SELECT trophy_id, earned_at FROM user_trophies WHERE user_id = $1', [a.target.id]);
    const out: TrophyPageDTO = {
      handle: a.target.handle, self, visible: true,
      earned: rows.map((r) => ({ id: r.trophy_id, earnedAt: r.earned_at.toISOString() })),
    };
    if (self) {
      const { rows: p } = await db.query<{ hours: number; messages: number; dms: number; friends: number; invites: number; photos: number; streak: number; best_streak: number;
        birthday: boolean; gender: boolean; city: boolean; style: boolean; about: boolean; sheet: CharacterSheet | null; email: boolean; phone: boolean; two_factor: boolean }>(
        `SELECT extract(epoch FROM now() - created_at) / 3600 AS hours, message_count AS messages, dm_count AS dms,
                ${INVITES.replace(/u\.id/g, 'users.id')} AS invites,
                ${PHOTOS.replace(/u\.id/g, 'users.id')} AS photos,
                -- a streak is still alive if the last update was yesterday or today in any timezone
                CASE WHEN status_last_day >= (now() AT TIME ZONE 'UTC')::date - 2 THEN status_streak ELSE 0 END AS streak,
                status_best_streak AS best_streak,
                character_birthday IS NOT NULL AS birthday, btrim(coalesce(character_gender, '')) <> '' AS gender,
                btrim(coalesce(character_city, '')) <> '' AS city, rp_style IS NOT NULL AS style,
                btrim(coalesce(bio, '')) <> '' AS about, character_sheet AS sheet,
                ${FRIENDS.replace(/u\.id/g, 'users.id')} AS friends,
                email_verified_at IS NOT NULL AS email, phone IS NOT NULL AS phone, totp_enabled AS two_factor
           FROM users WHERE id = $1`, [u.id]);
      out.progress = {
        accountHours: Number(p[0].hours), messages: Number(p[0].messages), privateMessages: Number(p[0].dms), friends: Number(p[0].friends), invites: Number(p[0].invites), photos: Number(p[0].photos), statusStreak: Number(p[0].streak), bestStatusStreak: Number(p[0].best_streak),
        profile: {
          birthday: p[0].birthday, gender: p[0].gender, city: p[0].city, style: p[0].style, about: p[0].about,
          sheetFilled: SHEET_KEYS.filter((k) => (p[0].sheet?.[k] ?? '').trim() !== '').length, sheetTotal: SHEET_KEYS.length,
        },
        security: { email: p[0].email, phone: p[0].phone, twoFactor: p[0].two_factor },
      };
    }
    return out;
  });

  /** The earned-trophy announcement was shown. */
  app.post('/api/me/trophies/seen', async (req) => {
    const u = requireUser(req);
    const b = parse(SeenBody, req.body);
    await db.query('UPDATE user_trophies SET seen_at = now() WHERE user_id = $1 AND trophy_id = ANY($2) AND seen_at IS NULL', [u.id, b.ids]);
    return { ok: true };
  });
}
