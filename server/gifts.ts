import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Trust } from '../shared/config.js';
import { GIFT_BY_ID, GIFT_RULES } from '../shared/gifts.js';
import type { GiftAllowanceDTO, MyGiftsDTO, ProfileGiftsDTO } from '../shared/types.js';
import { publicUser, relation, USER_COLS, type UserRow } from './friends.js';
import { HttpError, parse, requireUser, type SessionUser } from './http.js';
import { profileAccess } from './profiles.js';
import { pushTo } from './push.js';
import { rooms, type IO } from './realtime.js';
import { maskMature } from './safety/mature.js';
import { checkSocialText } from './safety/social-text.js';
import { db, tx } from './store.js';

/**
 * Gifts: pick one of the 100 catalog gifts, add a message if you like, send. Five a day each.
 * The message is private to the recipient (and reportable); other people only ever see which
 * gifts someone has, and only if that member allows it.
 */

const SendBody = z.object({
  gift: z.string().regex(/^[a-z_]{1,40}$/),
  message: z.string().max(20_000).optional(),
});

/** Why this member can't send that one a gift right now, or null. */
export async function giftBlockReason(me: SessionUser, target: UserRow): Promise<string | null> {
  if (target.id === me.id) return "You can't send yourself a gift.";
  if (me.trust < Trust.Verified) return 'Confirm your email to send gifts.';
  const rel = await relation(me.id, target.id);
  if (rel.theyBlocked || rel.iBlocked) return "You can't send gifts to this member.";
  return null;
}

async function allowance(userId: string): Promise<GiftAllowanceDTO> {
  const { rows } = await db.query<{ n: number; oldest: Date | null }>(
    `SELECT count(*)::int AS n, min(created_at) AS oldest FROM gifts
      WHERE sender_id = $1 AND created_at > now() - interval '24 hours'`,
    [userId],
  );
  const used = Number(rows[0].n);
  const left = Math.max(0, GIFT_RULES.perDay - used);
  const nextAt = left === 0 && rows[0].oldest ? new Date(rows[0].oldest.getTime() + 24 * 3600_000).toISOString() : null;
  return { left, limit: GIFT_RULES.perDay, nextAt };
}

export function registerGiftRoutes(app: FastifyInstance, io: IO) {
  app.get('/api/gifts/allowance', async (req): Promise<GiftAllowanceDTO> => allowance(requireUser(req).id));

  app.post<{ Params: { handle: string } }>('/api/profiles/:handle/gifts', async (req, reply) => {
    const u = requireUser(req);
    const b = parse(SendBody, req.body);
    if (!GIFT_BY_ID.has(b.gift)) throw new HttpError(400, 'bad_gift', 'Pick one of the gifts shown.');
    const a = await profileAccess(u, req.params.handle);
    if (!a.visible) throw new HttpError(403, 'no_gift', "You can't send gifts to this member.");
    const why = await giftBlockReason(u, a.target);
    if (why) throw new HttpError(403, 'no_gift', why);

    let message: string | null = null;
    let shadow = false;
    const raw = (b.message ?? '').trim();
    if (raw) {
      const v = await checkSocialText(u, raw, 'dm');
      if (!v.ok) throw new HttpError(400, v.error, v.message);
      if ([...v.body].length > GIFT_RULES.messageMax) throw new HttpError(400, 'too_long', `A gift message can be up to ${GIFT_RULES.messageMax} characters.`);
      message = v.body;
      shadow = v.shadow;
    }

    const id = await tx(async (q) => {
      // Lock this sender's row so two quick taps can't both slip under the daily limit.
      await q.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [u.id]);
      const { rows: c } = await q.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM gifts WHERE sender_id = $1 AND created_at > now() - interval '24 hours'", [u.id]);
      if (Number(c[0].n) >= GIFT_RULES.perDay) {
        throw new HttpError(429, 'gift_limit', `You can send ${GIFT_RULES.perDay} gifts a day. Try again later.`);
      }
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO gifts (gift_key, sender_id, recipient_id, message, hidden_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END) RETURNING id::text AS id`,
        [b.gift, u.id, a.target.id, message, shadow],
      );
      return rows[0].id;
    });
    if (!shadow) {
      io.to(rooms.user(a.target.id)).emit('social', { kind: 'gift', from: u.handle });
      pushTo(a.target.id, 'friend', { title: `${u.handle} sent you a gift`, url: '/gifts', tag: `gift-${id}` });
    }
    return reply.status(201).send({ id, ...(await allowance(u.id)) });
  });

  /** Your gifts, newest first, with who sent them and their messages. Only ever your own. */
  app.get<{ Querystring: { page?: string } }>('/api/me/gifts', async (req, reply): Promise<MyGiftsDTO> => {
    const u = requireUser(req);
    reply.header('Cache-Control', 'no-store, private');
    const where = `g.recipient_id = $1 AND g.hidden_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ignores i WHERE i.user_id = $1 AND i.ignored_user_id = g.sender_id)`;
    const { rows: c } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gifts g WHERE ${where}`, [u.id]);
    const total = Number(c[0].n);
    const pages = Math.max(1, Math.ceil(total / GIFT_RULES.perPage));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1));
    const { rows } = await db.query<Partial<UserRow> & { gid: string; gift_key: string; message: string | null; gat: Date; sender: string | null }>(
      `SELECT g.id::text AS gid, g.gift_key, g.message, g.created_at AS gat, g.sender_id::text AS sender, ${USER_COLS}
         FROM gifts g LEFT JOIN users u ON u.id = g.sender_id
        WHERE ${where} ORDER BY g.id DESC LIMIT ${GIFT_RULES.perPage} OFFSET $2`,
      [u.id, (page - 1) * GIFT_RULES.perPage],
    );
    const { rows: pg } = await db.query<{ id: string | null }>('SELECT profile_gift_id::text AS id FROM users WHERE id = $1', [u.id]);
    return {
      gifts: rows.filter((r) => GIFT_BY_ID.has(r.gift_key)).map((r) => ({
        id: r.gid, gift: r.gift_key, createdAt: r.gat.toISOString(),
        from: r.sender ? publicUser(r as UserRow) : null,
        message: r.message ? (u.prefs.chatFilter ? maskMature(r.message) : r.message) : null,
      })),
      page, pages, total, profileGiftId: pg[0]?.id ?? null,
    };
  });

  /** Remove a gift from your collection. */
  app.delete<{ Params: { id: string } }>('/api/me/gifts/:id', async (req) => {
    const u = requireUser(req);
    const { rowCount } = await db.query('DELETE FROM gifts WHERE id = $1 AND recipient_id = $2', [req.params.id, u.id]);
    if (!rowCount) throw new HttpError(404, 'no_gift', 'Gift not found.');
    return { ok: true };
  });

  /** Another member's gifts: just which gifts and how many, if they allow it. */
  app.get<{ Params: { handle: string } }>('/api/profiles/:handle/gifts', async (req): Promise<ProfileGiftsDTO> => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    if (!a.canViewGifts) return { handle: a.target.handle, allowed: false, gifts: [], total: 0 };
    const { rows } = await db.query<{ gift_key: string; n: number }>(
      `SELECT gift_key, count(*)::int AS n FROM gifts WHERE recipient_id = $1 AND hidden_at IS NULL
        GROUP BY gift_key ORDER BY count(*) DESC, max(id) DESC`,
      [a.target.id],
    );
    const gifts = rows.filter((r) => GIFT_BY_ID.has(r.gift_key)).map((r) => ({ gift: r.gift_key, count: Number(r.n) }));
    return { handle: a.target.handle, allowed: true, gifts, total: gifts.reduce((s, g) => s + g.count, 0) };
  });
}
