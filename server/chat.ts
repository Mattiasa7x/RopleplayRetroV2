import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RETAINED_PER_ROOM, SAFETY, Trust } from '../shared/config.js';
import type { HistoryPage, MessageDTO, RoomDetail, RoomSummary } from '../shared/types.js';
import { parse, requireUser, type SessionUser } from './http.js';
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
}

export function toDTO(r: MsgRow): MessageDTO {
  return {
    id: r.id, roomId: r.room_id, userId: r.user_id, handle: r.handle, body: r.body,
    mentions: r.mentions ?? [], createdAt: r.created_at.toISOString(),
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
    `SELECT m.id, m.room_id, m.user_id, u.handle, m.body, m.mentions, m.created_at, m.is_shadow
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
       RETURNING id, room_id, user_id, $6::text AS handle, body, mentions, created_at, is_shadow`,
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
    whitelistOnly: r.whitelist_only, ownerHandle: r.owner_handle, isOwner: r.owner_id === user.id,
    online: Number(res[i]?.[1] ?? 0), minTrustToPost: r.min_trust_to_post,
    unreadMentions: Number(mentions[r.id] ?? 0),
    favorite: r.favorite,
    image: roomImageUrl(r.image_id, r.has_image),
  }));
}

export function registerChatRoutes(app: FastifyInstance) {
  app.get('/api/rooms', async (req) => roomList(requireUser(req)));

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
