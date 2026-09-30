import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RETAINED_PER_ROOM, SAFETY, Trust } from '../shared/config.js';
import type { HistoryPage, MessageDTO, RoomDetail, RoomSummary } from '../shared/types.js';
import { HttpError, parse, requireUser, type SessionUser } from './http.js';
import { rooms as sockRooms, type IO } from './realtime.js';
import { slidingWindow } from './safety/limits.js';
import { afterLikeReceived } from './trophies.js';
import { paginate } from './paging.js';
import { roomImageUrl } from './room-images.js';
import { ROOM_COLS, assertRoomAccess, canSpeakIn, roomBySlug, roomDetail, type RoomRow } from './rooms.js';
import { maskMature, matureEntries } from './safety/mature.js';
import { checkMessage } from './safety/pipeline.js';
import { db, redis, tx } from './store.js';

interface MsgRow {
  id: string;
  room_id: number;
  user_id: string;
  handle: string;
  body: string;
  mentions: string[];
  created_at: Date;
  is_shadow: boolean;
  like_count?: number;
  liked?: boolean;
}

export function toDTO(r: MsgRow): MessageDTO {
  return {
    id: r.id, roomId: r.room_id, userId: r.user_id, handle: r.handle, body: r.body,
    mentions: r.mentions ?? [], createdAt: r.created_at.toISOString(),
    likes: Number(r.like_count ?? 0), liked: !!r.liked,
    // is_shadow is deliberately never sent: a shadow-muted user must not be able to tell.
  };
}

/**
 * What this viewer may see in a room, newest first: not hidden by moderators, not
 * someone else's shadow-muted lines, and nothing from people the viewer ignores.
 * Filtering happens here, so ignored users' messages never reach the browser.
 */
export async function visibleNewestFirst(roomId: number, viewerId: string): Promise<MessageDTO[]> {
  const { rows } = await db.query<MsgRow>(
    `SELECT m.id, m.room_id, m.user_id, u.handle, m.body, m.mentions, m.created_at, m.is_shadow, m.like_count,
            EXISTS (SELECT 1 FROM message_likes l WHERE l.message_id = m.id AND l.user_id = $2) AS liked
       FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.room_id = $1
        AND m.hidden_at IS NULL
        AND (NOT m.is_shadow OR m.user_id = $2)
        AND NOT EXISTS (SELECT 1 FROM ignores i WHERE i.user_id = $2 AND i.ignored_user_id = m.user_id)
      ORDER BY m.id DESC
      LIMIT $3`,
    [roomId, viewerId, RETAINED_PER_ROOM * 2], // shadow lines don't count toward the 200, so allow headroom
  );
  return rows.map(toDTO);
}

export type SendOutcome =
  | { ok: true; message: MessageDTO; shadow: boolean; mentionedIds: string[]; messageCount: number }
  | { ok: false; error: string; message: string };

export async function sendMessage(userId: string, slug: string, raw: string): Promise<SendOutcome> {
  const room = await roomBySlug(slug);
  const { rows: urows } = await db.query<{ id: string; handle: string; trust_level: number; created_at: Date }>(
    'SELECT id, handle, trust_level, created_at FROM users WHERE id = $1',
    [userId],
  );
  const user = urows[0];
  if (!user) return { ok: false, error: 'login', message: 'Please log in.' };
  await assertRoomAccess({ id: user.id, trust: user.trust_level }, room); // member-room rules + bans/kicks
  if (!(await canSpeakIn({ id: user.id, trust: user.trust_level }, room))) {
    return { ok: false, error: 'read_only', message: 'This room is read-only right now. The owner can give you a voice.' };
  }

  const verdict = await checkMessage({ user: { id: user.id, trust: user.trust_level, createdAt: user.created_at }, room, raw });
  if (!verdict.ok) return verdict;

  return tx(async (q) => {
    // Resolve @handles to users who exist, aren't the sender, and are allowed in this room
    // (so a mention never leaks an invite-only room to someone outside it).
    let mentionedIds: string[] = [];
    if (verdict.mentionHandles.length) {
      const { rows } = await q.query<{ id: string }>(
        `SELECT u.id FROM users u
          WHERE lower(u.handle) = ANY($1) AND u.id <> $2
            AND ($3 = 'site' OR u.trust_level >= $4)
            AND (NOT $5 OR u.id = $6 OR u.trust_level >= $7
                 OR EXISTS (SELECT 1 FROM room_whitelist w WHERE w.room_id = $8 AND w.user_id = u.id))`,
        [verdict.mentionHandles, user.id, room.kind, Trust.Verified, room.whitelist_only, room.owner_id, Trust.Admin, room.id],
      );
      mentionedIds = rows.map((r) => r.id);
    }

    const { rows } = await q.query<MsgRow>(
      `INSERT INTO messages (room_id, user_id, body, mentions, is_shadow)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, room_id, user_id, $6::text AS handle, body, mentions, created_at, is_shadow, like_count, false AS liked`,
      [room.id, user.id, verdict.body, mentionedIds, verdict.shadow, user.handle],
    );

    // Keep the newest 200 real messages. Shadow lines older than the cutoff go too.
    await q.query(
      `DELETE FROM messages
        WHERE room_id = $1
          AND id <= (SELECT id FROM messages WHERE room_id = $1 AND NOT is_shadow
                      ORDER BY id DESC OFFSET $2 LIMIT 1)`,
      [room.id, RETAINED_PER_ROOM],
    );

    let messageCount = 0;
    if (!verdict.shadow) {
      const { rows: mc } = await q.query<{ n: number }>('UPDATE users SET message_count = message_count + 1 WHERE id = $1 RETURNING message_count AS n', [user.id]);
      messageCount = Number(mc[0].n);
      // Automatic promotion to Established.
      await q.query(
        `UPDATE users SET trust_level = $2
          WHERE id = $1 AND trust_level = $3
            AND created_at < now() - make_interval(days => $4)
            AND message_count >= $5
            AND NOT EXISTS (SELECT 1 FROM sanctions s WHERE s.user_id = users.id AND s.kind <> 'kick'
                              AND s.created_at > now() - make_interval(days => $6))`,
        [user.id, Trust.Established, Trust.Verified, SAFETY.establishedMinDays, SAFETY.establishedMinMessages, SAFETY.establishedCleanDays],
      );
    }

    return { ok: true as const, message: toDTO(rows[0]), shadow: verdict.shadow, mentionedIds: verdict.shadow ? [] : mentionedIds, messageCount };
  });
}

const HistoryQuery = z.object({
  before: z.string().regex(/^\d{1,19}$/).optional(),
  after: z.string().regex(/^\d{1,19}$/).optional(),
});

/** Site rooms for everyone; member rooms only for verified members, invite-only ones only for those invited. */
export async function roomList(user: SessionUser): Promise<RoomSummary[]> {
  const { rows } = await db.query<RoomRow & { owner_handle: string | null; favorite: boolean }>(
    `SELECT ${ROOM_COLS}, o.handle AS owner_handle,
            EXISTS (SELECT 1 FROM room_favorites f WHERE f.room_id = r.id AND f.user_id = $1) AS favorite
       FROM rooms r LEFT JOIN users o ON o.id = r.owner_id
      WHERE r.kind = 'site'
         OR ($2 >= $3 AND (NOT r.whitelist_only OR r.owner_id = $1 OR $2 >= $4
              OR EXISTS (SELECT 1 FROM room_whitelist w WHERE w.room_id = r.id AND w.user_id = $1)))
      ORDER BY r.kind = 'member', r.sort_order, lower(r.name)`,
    [user.id, user.trust, Trust.Verified, Trust.Admin],
  );
  const pipe = redis.pipeline();
  for (const r of rows) pipe.hlen(`presence:${r.id}`);
  pipe.hgetall(`mentions:${user.id}`);
  const res = (await pipe.exec()) ?? [];
  const mentions = (res[rows.length]?.[1] ?? {}) as Record<string, string>;
  return rows.map((r, i) => ({
    id: r.id, slug: r.slug, name: r.name, category: r.category, kind: r.kind, description: r.description,
    region: r.region, subregion: r.subregion,
    whitelistOnly: r.whitelist_only, ownerHandle: r.owner_handle, isOwner: r.owner_id === user.id,
    online: Number(res[i]?.[1] ?? 0), minTrustToPost: r.min_trust_to_post,
    unreadMentions: Number(mentions[r.id] ?? 0),
    favorite: r.favorite,
    image: roomImageUrl(r.image_id, r.has_image),
  }));
}

const LikeParams = z.object({ id: z.string().regex(/^\d{1,19}$/) });

export function registerChatRoutes(app: FastifyInstance, io: IO) {
  app.get('/api/rooms', async (req) => roomList(requireUser(req)));

  /**
   * Like (PUT) or unlike (DELETE) a room message. Only lines you can actually see, never your
   * own, and each person counts once. The author's likes-received total drives the chat trophies.
   */
  const setLike = async (req: { params: unknown; user?: SessionUser | null }, like: boolean) => {
    const u = requireUser(req as never, Trust.Verified);
    const { id } = parse(LikeParams, req.params);
    if (!(await slidingWindow(redis, `rl:like:${u.id}`, 90, 60_000))) {
      throw new HttpError(429, 'rate', 'Slow down a little with the likes.');
    }
    const { rows: mr } = await db.query<{ id: string; room_id: number; user_id: string; slug: string }>(
      `SELECT m.id::text AS id, m.room_id, m.user_id::text AS user_id, r.slug
         FROM messages m JOIN rooms r ON r.id = m.room_id
        WHERE m.id = $1 AND m.hidden_at IS NULL AND NOT m.is_shadow
          AND NOT EXISTS (SELECT 1 FROM ignores i WHERE i.user_id = $2 AND i.ignored_user_id = m.user_id)`, [id, u.id]);
    const m = mr[0];
    if (!m) throw new HttpError(404, 'no_message', 'That message is gone.');
    if (m.user_id === u.id) throw new HttpError(403, 'own_message', "You can't like your own messages.");
    await assertRoomAccess(u, await roomBySlug(m.slug));
    const out = await tx(async (q) => {
      const changed = like
        ? await q.query('INSERT INTO message_likes (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [m.id, u.id])
        : await q.query('DELETE FROM message_likes WHERE message_id = $1 AND user_id = $2 RETURNING 1', [m.id, u.id]);
      const d = changed.rowCount ? (like ? 1 : -1) : 0;
      const { rows: c } = await q.query<{ n: number }>(
        'UPDATE messages SET like_count = GREATEST(like_count + $2, 0) WHERE id = $1 RETURNING like_count AS n', [m.id, d]);
      let received = 0;
      if (d) {
        const { rows: r } = await q.query<{ n: number }>(
          'UPDATE users SET like_count = GREATEST(like_count + $2, 0) WHERE id = $1 RETURNING like_count AS n', [m.user_id, d]);
        received = Number(r[0]?.n ?? 0);
      }
      return { likes: Number(c[0]?.n ?? 0), changed: d, received };
    });
    if (out.changed) {
      io.to(sockRooms.chat(Number(m.room_id))).emit('msg:likes', { id: m.id, roomId: Number(m.room_id), likes: out.likes });
      if (out.changed > 0) afterLikeReceived(m.user_id, out.received);
    }
    return { likes: out.likes, liked: like };
  };
  app.put<{ Params: { id: string } }>('/api/messages/:id/like', async (req) => setLike(req, true));
  app.delete<{ Params: { id: string } }>('/api/messages/:id/like', async (req) => setLike(req, false));

  /** Swear-word list (normalised) so a filtered room can stop them as they're typed; the server checks again on send. */
  app.get('/api/filter/room-words', async (req, reply) => {
    requireUser(req);
    reply.header('Cache-Control', 'private, max-age=3600');
    return { entries: matureEntries() };
  });

  app.get<{ Params: { slug: string } }>('/api/rooms/:slug/messages', async (req): Promise<HistoryPage> => {
    const u = requireUser(req);
    const q = parse(HistoryQuery, req.query);
    const room = await roomBySlug(req.params.slug);
    await assertRoomAccess(u, room);
    const all = (await visibleNewestFirst(room.id, u.id)).slice(0, RETAINED_PER_ROOM); // never more than 20 pages
    const p = paginate(u.prefs.chatFilter ? all.map((m) => ({ ...m, body: maskMature(m.body) })) : all, q);
    const detail: RoomDetail = await roomDetail(u, room);
    delete detail.whitelist;
    return {
      room: detail,
      messages: p.items, page: p.page, totalPages: p.totalPages,
      olderCursor: p.olderCursor, newerCursor: p.newerCursor,
    };
  });
}
