import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TROPHIES, TROPHY_BY_ID } from '../shared/trophies.js';
import sharp from 'sharp';
import { ADULT_RP_STYLES, CHARACTER_CITY, CHARACTER_GENDER, CHARACTER_SHEET, PROFILE, RP_STYLES, TRUST_LABEL, Trust, type CharacterSheet, type RpStyle } from '../shared/config.js';
import type { CommentDTO, ProfileDTO, ProfileFriendsDTO, ProfileViewsDTO, StatusDTO } from '../shared/types.js';
import { characterAgeText, publicUser, prefsOf, relation, userByHandle, USER_COLS, type UserRow } from './friends.js';
import { HttpError, parse, requireUser, type SessionUser } from './http.js';
import { canViewAlbum, looksLikeImage, photoDTO } from './photos.js';
import { isPoolImage } from './room-images.js';
import { slidingWindow } from './safety/limits.js';
import { rooms, type IO } from './realtime.js';
import { maskMature } from './safety/mature.js';
import { textBlocked } from './safety/pipeline.js';
import { checkSocialText } from './safety/social-text.js';
import { audit, db, redis } from './store.js';
import { afterProfileEdit } from './trophies.js';
import { giftBlockReason } from './gifts.js';
import { GIFT_BY_ID } from '../shared/gifts.js';

// ---------------- profile visibility ----------------

interface Access {
  target: UserRow;
  visible: boolean;
  canComment: boolean;
  canViewFriends: boolean;
  canViewGifts: boolean;
  friendState: ProfileDTO['friendState'];
  iBlocked: boolean;
  iIgnore: boolean;
}

/** Who may see what on a profile. Throws 404 if the owner has blocked the viewer. */
export async function profileAccess(viewer: SessionUser, handle: string): Promise<Access> {
  const target = await userByHandle(handle);
  const rel = await relation(viewer.id, target.id);
  if (rel.theyBlocked) throw new HttpError(404, 'no_user', 'No one has that name.');
  const staff = viewer.trust >= Trust.RoomModerator;
  const self = rel.friendState === 'self';
  const friends = rel.friendState === 'friends';
  const p = prefsOf(target);
  const visible = !rel.iBlocked && (self || staff || friends || p.profileVisibility === 'everyone');
  const canComment =
    visible && !rel.iBlocked && viewer.trust >= Trust.Verified &&
    (self || (p.whoCanComment === 'everyone') || (p.whoCanComment === 'friends' && friends));
  const fl = p.friendsList, gv = p.giftsVisibility;
  const canViewGifts = visible && (self || viewer.trust >= Trust.Admin || gv === 'everyone' || (gv === 'friends' && friends));
  const canViewFriends = visible && (self || viewer.trust >= Trust.Admin || fl === 'everyone' || (fl === 'friends' && friends));
  return { target, visible, canComment, canViewFriends, canViewGifts, friendState: rel.friendState, iBlocked: rel.iBlocked, iIgnore: rel.iIgnore };
}

/** The gift a member shows on their profile (catalog id), if it's still theirs and visible. */
async function shownGift(userId: string): Promise<string | null> {
  const { rows } = await db.query<{ gift_key: string }>(
    `SELECT g.gift_key FROM users u JOIN gifts g ON g.id = u.profile_gift_id
      WHERE u.id = $1 AND g.recipient_id = u.id AND g.hidden_at IS NULL`, [userId]);
  return rows[0] && GIFT_BY_ID.has(rows[0].gift_key) ? rows[0].gift_key : null;
}

const view = (viewer: SessionUser, text: string) => (viewer.prefs.chatFilter ? maskMature(text) : text);

// ---------------- routes ----------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ProfileBody = z.object({
  bio: z.string().max(PROFILE.bioMax, `About can be up to ${PROFILE.bioMax} characters`).nullable().optional(),
  characterCity: z.string().trim().max(CHARACTER_CITY.maxLength, `City can be up to ${CHARACTER_CITY.maxLength} characters`).nullable().optional(),
  characterGender: z.string().trim().max(CHARACTER_GENDER.maxLength, `Gender can be up to ${CHARACTER_GENDER.maxLength} characters`).nullable().optional(),
  characterBirthday: z.string().regex(DATE, 'Pick a date').refine((d) => !Number.isNaN(Date.parse(d)) && d >= '0001-01-01', 'Pick a real date').nullable().optional(),
  rpStyle: z.enum(RP_STYLES).nullable().optional(),
  characterSheet: z.record(z.string(), z.string()).optional(),
  profileThemeId: z.number().int().positive().nullable().optional(),
  /** One of your received gifts (its id), or null for none. */
  profileGift: z.string().regex(/^\d{1,19}$/).nullable().optional(),
  /** A trophy you've earned, or 'none'. */
  profileTrophy: z.string().regex(/^[a-z_]{1,40}$/).optional(),
}).strict();

/** Keep only the sheet's own fields, trimmed and within their lengths; empty ones are dropped. */
function cleanSheet(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of CHARACTER_SHEET) {
    const v = input[f.key]?.trim();
    if (!v) continue;
    if (v.length > f.max) throw new HttpError(400, 'too_long', `${f.label} can be up to ${f.max} characters.`);
    out[f.key] = v;
  }
  return out;
}

/** Banner: any picture in, a wide 1500×500 crop out (metadata and location stripped). */
async function processBanner(input: Buffer): Promise<Buffer> {
  return sharp(input, { limitInputPixels: PROFILE.photoMaxInputPixels, failOn: 'none' }).rotate()
    .resize({ width: 1500, height: 500, fit: 'cover', position: 'attention' })
    .webp({ quality: 80 }).toBuffer();
}
const TextBody = z.object({ body: z.string().max(20_000) });

export function registerProfileRoutes(app: FastifyInstance, io: IO) {
  app.get<{ Params: { handle: string } }>('/api/profiles/:handle', async (req): Promise<ProfileDTO> => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    const t = a.target;
    const [{ rows: photos }, { rows: fc }, albumOk] = await Promise.all([
      a.visible
        ? db.query<{ id: string; is_private: boolean }>('SELECT id, is_private FROM profile_photos WHERE user_id = $1 AND NOT is_private ORDER BY position, id', [t.id])
        : Promise.resolve({ rows: [] as { id: string; is_private: boolean }[] }),
      db.query<{ n: string }>("SELECT count(*) AS n FROM friendships WHERE (user_a = $1 OR user_b = $1) AND status = 'accepted'", [t.id]),
      a.visible ? canViewAlbum(u, t.id) : Promise.resolve(false),
    ]);
    const { rows: ac } = albumOk
      ? await db.query<{ n: string }>('SELECT count(*) AS n FROM profile_photos WHERE user_id = $1 AND is_private', [t.id])
      : { rows: [{ n: '0' }] };
    const self = t.id === u.id;
    // Remember the visit for the owner's Views list (latest visit per person). The site admin's
    // visits aren't listed, so checking on a report never tips anyone off.
    if (!self && a.visible && u.trust < Trust.Admin) {
      await db.query(
        `INSERT INTO profile_views (profile_user_id, viewer_id) VALUES ($1, $2)
         ON CONFLICT (profile_user_id, viewer_id) DO UPDATE SET viewed_at = now()`,
        [t.id, u.id],
      );
    }
    const { rows: nv } = self
      ? await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM profile_views v, users me
            WHERE me.id = $1 AND v.profile_user_id = $1 AND (me.views_seen_at IS NULL OR v.viewed_at > me.views_seen_at)`, [t.id])
      : { rows: [] as { n: number }[] };
    const { rows: ban } = a.visible
      ? await db.query<{ v: string }>('SELECT extract(epoch FROM updated_at)::bigint::text AS v FROM profile_banners WHERE user_id = $1', [t.id])
      : { rows: [] as { v: string }[] };
    const { rows: th } = a.visible && t.profile_theme_id != null
      ? await db.query<{ id: number; title: string }>('SELECT id, title FROM room_images WHERE id = $1 AND full_data IS NOT NULL', [t.profile_theme_id])
      : { rows: [] as { id: number; title: string }[] };
    // Earned trophies, newest first; ones earned together go to the later (bigger) trophy in the list.
    const { rows: tr } = a.visible
      ? await db.query<{ trophy_id: string; ts: string }>('SELECT trophy_id, extract(epoch FROM earned_at)::text AS ts FROM user_trophies WHERE user_id = $1', [t.id])
      : { rows: [] as { trophy_id: string; ts: string }[] };
    const order = (id: string) => TROPHIES.findIndex((x) => x.id === id);
    const earned = tr.filter((r) => TROPHY_BY_ID.has(r.trophy_id))
      .sort((x, y) => Number(y.ts) - Number(x.ts) || order(y.trophy_id) - order(x.trophy_id))
      .map((r) => r.trophy_id);
    const shown = t.profile_trophy === 'none' ? null
      : t.profile_trophy && earned.includes(t.profile_trophy) ? t.profile_trophy
      : earned[0] ?? null;
    const sheet: CharacterSheet = {};
    if (a.visible) {
      for (const f of CHARACTER_SHEET) {
        const v = t.character_sheet?.[f.key];
        if (typeof v === 'string' && v) sheet[f.key] = view(u, v);
      }
    }
    const age = characterAgeText(t);
    return {
      ...publicUser(t, { showAvatar: a.visible }),
      bio: a.visible && t.bio ? view(u, t.bio) : null,
      characterAge: a.visible && age ? view(u, age) : null,
      characterGender: a.visible && t.character_gender ? view(u, t.character_gender) : null,
      characterCity: a.visible && t.character_city ? view(u, t.character_city) : null,
      rpStyle: a.visible && (RP_STYLES as readonly string[]).includes(t.rp_style ?? '') ? (t.rp_style as RpStyle) : null,
      characterSheet: sheet,
      banner: ban[0] ? `/banner/${t.id}?v=${ban[0].v}` : null,
      theme: th[0] ? { id: th[0].id, image: `/room-img/${th[0].id}/full`, title: th[0].title } : null,
      ...(self ? { own: { characterBirthday: t.character_birthday, legacyAge: t.character_birthday ? null : t.character_age, profileTrophy: t.profile_trophy } } : {}),
      trustLabel: TRUST_LABEL[t.trust_level as Trust],
      photos: photos.map(photoDTO),
      // Under 18 there's no private album; the tab only appears if old private photos need moving.
      canViewAlbum: albumOk && !(u.id === t.id && u.isMinor && Number(ac[0].n) === 0),
      albumCount: albumOk ? Number(ac[0].n) : 0,
      friendCount: Number(fc[0].n),
      friendState: a.friendState,
      canComment: a.canComment,
      visible: a.visible,
      blockedByMe: a.iBlocked,
      canViewFriends: a.canViewFriends,
      canViewGifts: a.canViewGifts,
      profileGift: a.canViewGifts ? await shownGift(t.id) : null,
      canSendGift: !self && a.visible && !(await giftBlockReason(u, t)),
      ...(self ? { newViews: Number(nv[0]?.n ?? 0) } : {}),
      trophy: shown,
      trophyCount: earned.length,
    };
  });

  /** Who viewed your profile, newest first. Only ever your own: there's no name in the address. */
  app.get<{ Querystring: { page?: string } }>('/api/me/profile-views', async (req, reply): Promise<ProfileViewsDTO> => {
    const u = requireUser(req);
    reply.header('Cache-Control', 'no-store, private');
    const size = PROFILE.viewsPerPage;
    // Leave out anyone either side has blocked or you ignore.
    const where = `v.profile_user_id = $1 AND v.viewed_at > now() - make_interval(days => ${PROFILE.viewsKeptDays})
      AND NOT EXISTS (SELECT 1 FROM ignores i WHERE (i.user_id = $1 AND i.ignored_user_id = v.viewer_id)
                                               OR (i.user_id = v.viewer_id AND i.ignored_user_id = $1 AND i.mode = 'block'))`;
    const { rows: c } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM profile_views v WHERE ${where}`, [u.id]);
    const total = Number(c[0].n);
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1));
    const { rows } = await db.query<UserRow & { viewed: Date }>(
      `SELECT ${USER_COLS}, v.viewed_at AS viewed FROM profile_views v JOIN users u ON u.id = v.viewer_id
        WHERE ${where} ORDER BY v.viewed_at DESC LIMIT ${size} OFFSET $2`,
      [u.id, (page - 1) * size],
    );
    if (page === 1) await db.query('UPDATE users SET views_seen_at = now() WHERE id = $1', [u.id]);
    return { views: rows.map((r) => ({ user: publicUser(r), viewedAt: r.viewed.toISOString() })), page, pages, total };
  });

  /** A member's friends list, if they allow this viewer to see it. */
  app.get<{ Params: { handle: string } }>('/api/profiles/:handle/friends', async (req): Promise<ProfileFriendsDTO> => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    if (!a.canViewFriends) return { handle: a.target.handle, allowed: false, friends: [] };
    const { rows } = await db.query<UserRow>(
      `SELECT ${USER_COLS} FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
        WHERE (f.user_a = $1 OR f.user_b = $1) AND f.status = 'accepted'
          AND NOT EXISTS (SELECT 1 FROM ignores i WHERE i.user_id = u.id AND i.ignored_user_id = $2 AND i.mode = 'block')
        ORDER BY lower(u.handle)`,
      [a.target.id, u.id],
    );
    return { handle: a.target.handle, allowed: true, friends: rows.map((r) => publicUser(r)) };
  });

  /**
   * Edit your character profile. Send only what changes; null clears a field.
   * A real change shows up for friends as "updated their profile".
   */
  app.patch('/api/me/profile', async (req) => {
    const u = requireUser(req);
    const b = parse(ProfileBody, req.body);
    const quick = ['profileThemeId', 'profileTrophy', 'profileGift'];
    if (b.profileGift !== undefined) {
      if (b.profileGift !== null) {
        const { rowCount } = await db.query('SELECT 1 FROM gifts WHERE id = $1 AND recipient_id = $2 AND hidden_at IS NULL', [b.profileGift, u.id]);
        if (!rowCount) throw new HttpError(400, 'bad_gift', 'Pick one of your gifts.');
      }
      await db.query('UPDATE users SET profile_gift_id = $2 WHERE id = $1', [u.id, b.profileGift]);
    }
    if (b.profileThemeId !== undefined) {
      if (b.profileThemeId !== null && !(await isPoolImage(b.profileThemeId))) throw new HttpError(400, 'bad_theme', 'Pick one of the themes shown.');
      await db.query('UPDATE users SET profile_theme_id = $2 WHERE id = $1', [u.id, b.profileThemeId]);
    }
    if (b.profileTrophy !== undefined) {
      if (b.profileTrophy !== 'none') {
        const { rowCount } = await db.query('SELECT 1 FROM user_trophies WHERE user_id = $1 AND trophy_id = $2', [u.id, b.profileTrophy]);
        if (!rowCount) throw new HttpError(400, 'bad_trophy', "You haven't earned that trophy yet.");
      }
      await db.query('UPDATE users SET profile_trophy = $2 WHERE id = $1', [u.id, b.profileTrophy]);
    }
    if (Object.keys(b).every((k) => quick.includes(k)) && Object.keys(b).length) return { ok: true };
    const { rows } = await db.query<UserRow>(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1`, [u.id]);
    const cur = rows[0];
    const next = {
      bio: b.bio !== undefined ? b.bio || null : cur.bio,
      city: b.characterCity !== undefined ? b.characterCity || null : cur.character_city,
      gender: b.characterGender !== undefined ? b.characterGender || null : cur.character_gender,
      birthday: b.characterBirthday !== undefined ? b.characterBirthday : cur.character_birthday,
      style: b.rpStyle !== undefined ? b.rpStyle : (cur.rp_style as RpStyle | null),
      sheet: b.characterSheet !== undefined ? cleanSheet(b.characterSheet) : (cur.character_sheet ?? {}),
    };
    if (next.birthday && next.birthday > new Date().toISOString().slice(0, 10)) {
      throw new HttpError(400, 'future', "A character's birthday can't be in the future.");
    }
    if (next.style && ADULT_RP_STYLES.includes(next.style) && u.isMinor) {
      throw new HttpError(403, 'adults_only', 'That roleplay style is for members 18 and over.');
    }
    const words = [next.bio, next.city, next.gender, ...Object.values(next.sheet)].filter(Boolean).join('\n');
    if (textBlocked(words)) throw new HttpError(400, 'blocked_word', "Something you wrote contains a word that isn't allowed.");
    const changed =
      next.bio !== cur.bio || next.city !== cur.character_city || next.gender !== cur.character_gender ||
      next.birthday !== cur.character_birthday || next.style !== cur.rp_style ||
      JSON.stringify(next.sheet) !== JSON.stringify(cur.character_sheet ?? {});
    if (!changed) return { ok: true };
    await db.query(
      `UPDATE users SET bio = $2, character_city = $3, character_gender = $4, character_birthday = $5::date, rp_style = $6,
              character_sheet = $7::jsonb, profile_updated_at = now()
        WHERE id = $1`,
      [u.id, next.bio, next.city, next.gender, next.birthday, next.style, JSON.stringify(next.sheet)],
    ).catch((e) => {
      const c = (e as { constraint?: string }).constraint;
      if (c === 'rp_style_adults_only') throw new HttpError(403, 'adults_only', 'That roleplay style is for members 18 and over.');
      if (c?.startsWith('users_')) throw new HttpError(400, 'too_long', 'One of those fields is too long.');
      throw e;
    });
    afterProfileEdit(u.id);
    return { ok: true };
  });

  // ----- banner picture -----
  /** Shown to whoever may see the profile, never to someone the owner blocked. */
  app.get<{ Params: { id: string } }>('/banner/:id', async (req, reply) => {
    const u = requireUser(req);
    if (!/^\d{1,19}$/.test(req.params.id)) throw new HttpError(404, 'no_banner', 'Not found.');
    const { rows: h } = await db.query<{ handle: string }>('SELECT handle FROM users WHERE id = $1', [req.params.id]);
    if (!h[0]) throw new HttpError(404, 'no_banner', 'Not found.');
    const a = await profileAccess(u, h[0].handle);
    if (!a.visible) throw new HttpError(404, 'no_banner', 'Not found.');
    const { rows } = await db.query<{ data: Buffer }>('SELECT data FROM profile_banners WHERE user_id = $1', [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'no_banner', 'Not found.');
    reply.header('Content-Type', 'image/webp');
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(rows[0].data);
  });

  app.post('/api/me/banner', async (req) => {
    const u = requireUser(req, Trust.Verified);
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !raw.length) throw new HttpError(400, 'empty', 'No picture received.');
    if (!looksLikeImage(raw)) throw new HttpError(415, 'type', 'Upload a JPEG, PNG, WebP or GIF picture.');
    if (!(await slidingWindow(redis, `rl:photo:${u.id}`, PROFILE.photoUploadsPerHour, 3600_000))) {
      throw new HttpError(429, 'rate', 'Too many uploads this hour. Try again a little later.');
    }
    let data: Buffer;
    try {
      data = await processBanner(raw);
    } catch {
      throw new HttpError(400, 'bad_image', "That picture couldn't be read. Try saving it as a JPEG first.");
    }
    await db.query(
      `INSERT INTO profile_banners (user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [u.id, data],
    );
    await db.query('UPDATE users SET profile_updated_at = now() WHERE id = $1', [u.id]);
    return { ok: true };
  });

  app.delete('/api/me/banner', async (req) => {
    const u = requireUser(req);
    await db.query('DELETE FROM profile_banners WHERE user_id = $1', [u.id]);
    return { ok: true };
  });

  // ----- a member's own status updates, on their profile -----
  app.get<{ Params: { handle: string } }>('/api/profiles/:handle/statuses', async (req): Promise<StatusDTO[]> => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    if (!a.visible || a.iIgnore) return [];
    const { rows } = await db.query<{ id: string; body: string; created_at: Date }>(
      `SELECT id, body, created_at FROM statuses WHERE user_id = $1 AND (hidden_at IS NULL OR user_id = $2) ORDER BY id DESC LIMIT 1`,
      [a.target.id, u.id],
    );
    return rows.map((r) => ({
      id: r.id, author: publicUser(a.target), body: view(u, r.body), createdAt: r.created_at.toISOString(),
      canDelete: a.target.id !== u.id && u.trust >= Trust.RoomModerator,
    }));
  });
}
