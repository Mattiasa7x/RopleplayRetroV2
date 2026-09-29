import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MESSAGES, Trust } from '../shared/config.js';
import type { ConversationDTO, DirectMessageDTO, ThreadDTO } from '../shared/types.js';
import { publicUser, relation, userByHandle, USER_COLS, type UserRow } from './friends.js';
import { HttpError, parse, requireUser, type SessionUser } from './http.js';
import { ADULTS_ONLY, bothAdults, canViewPhoto, photoDTO, photoRow } from './photos.js';
import { rooms, type IO } from './realtime.js';
import { maskMature } from './safety/mature.js';
import { pushTo } from './push.js';
import { checkSocialText } from './safety/social-text.js';
import { db } from './store.js';
import { afterPrivateMessage } from './trophies.js';

/**
 * Private messages. Friends only, blocks respected both ways, same 420-character rule,
 * blocklist, link rules and rate limits as the rest of the site. Messages can carry one
 * photo; sharing a private-album photo gives just that friend access to just that photo.
 */

interface MsgRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string | null;
  photo_id: string | null;
  photo_private: boolean | null;
  photo_owner: string | null;
  read_at: Date | null;
  created_at: Date;
}

/** Why these two can't message each other, or null if they can. */
async function cannotMessage(me: SessionUser, otherId: string): Promise<string | null> {
  if (me.trust < Trust.Verified) return 'Confirm your email to send messages.';
  const rel = await relation(me.id, otherId);
  if (rel.theyBlocked || rel.iBlocked) return "You can't message this member.";
  if (rel.friendState !== 'friends') return 'You can message friends only. Send a friend request first.';
  const { rows } = await db.query<{ same: boolean }>('SELECT is_adult_user($1) = is_adult_user($2) AS same', [me.id, otherId]);
  if (!rows[0]?.same) {
    // Adults see a vague message so the site never reveals a member's age.
    return me.isMinor
      ? 'Private messages with this member unlock on your 18th birthday. You can still chat in rooms and comment on profiles.'
      : "You can't send private messages to this member. You can still chat in rooms and comment on profiles.";
  }
  return null;
}

async function toDTO(me: SessionUser, r: MsgRow): Promise<DirectMessageDTO> {
  let photo: DirectMessageDTO['photo'] = null;
  if (r.photo_id && r.photo_owner != null) {
    const ok = await canViewPhoto(me, { id: r.photo_id, user_id: r.photo_owner, is_private: !!r.photo_private });
    photo = ok ? photoDTO({ id: r.photo_id, is_private: !!r.photo_private }) : null;
  }
  return {
    id: r.id,
    mine: r.sender_id === me.id,
    body: r.body == null ? null : me.prefs.chatFilter ? maskMature(r.body) : r.body,
    photo,
    photoRemoved: photo === null && (r.photo_id !== null || r.body == null),
    createdAt: r.created_at.toISOString(),
    read: !!r.read_at,
  };
}

const MSG_COLS = `m.id, m.sender_id, m.recipient_id, m.body, m.photo_id, m.read_at, m.created_at,
  p.is_private AS photo_private, p.user_id AS photo_owner`;

const SendBody = z.object({
  body: z.string().max(20_000).optional(),
  photoId: z.string().regex(/^\d{1,19}$/).optional(),
});

export function registerMessageRoutes(app: FastifyInstance, io: IO) {
  /** Inbox: one row per person, newest conversation first. */
  app.get('/api/messages', async (req): Promise<ConversationDTO[]> => {
    const me = requireUser(req);
    const { rows } = await db.query<UserRow & { last_id: string; last_body: string | null; last_photo: string | null; last_mine: boolean; last_at: Date; unread: string }>(
      `WITH mine AS (
         SELECT m.*, CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END AS other
           FROM direct_messages m
          WHERE (m.sender_id = $1 AND NOT m.deleted_by_sender)
             OR (m.recipient_id = $1 AND NOT m.deleted_by_recipient AND NOT m.is_shadow)
       ), latest AS (
         SELECT DISTINCT ON (other) other, id AS last_id, body AS last_body, photo_id AS last_photo,
                sender_id = $1 AS last_mine, created_at AS last_at
           FROM mine ORDER BY other, id DESC
       )
       SELECT ${USER_COLS}, l.last_id, l.last_body, l.last_photo, l.last_mine, l.last_at,
              (SELECT count(*) FROM mine x WHERE x.other = l.other AND x.recipient_id = $1 AND x.read_at IS NULL) AS unread
         FROM latest l JOIN users u ON u.id = l.other
        WHERE NOT EXISTS (SELECT 1 FROM ignores i WHERE i.user_id = l.other AND i.ignored_user_id = $1 AND i.mode = 'block')
        ORDER BY l.last_id DESC LIMIT 100`,
      [me.id],
    );
    return rows.map((r) => ({
      with: publicUser(r),
      preview: r.last_body != null ? (me.prefs.chatFilter ? maskMature(r.last_body) : r.last_body).slice(0, 80) : '📷 Photo',
      lastFromMe: r.last_mine,
      lastAt: r.last_at.toISOString(),
      unread: Number(r.unread),
    }));
  });

  app.get('/api/messages/unread-count', async (req) => {
    const me = requireUser(req);
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*) AS n FROM direct_messages WHERE recipient_id = $1 AND read_at IS NULL AND NOT is_shadow AND NOT deleted_by_recipient',
      [me.id],
    );
    return { unread: Number(rows[0].n) };
  });

  /** A conversation, newest page first (?before= for older). Opening it marks their messages read. */
  app.get<{ Params: { handle: string }; Querystring: { before?: string } }>('/api/messages/:handle', async (req): Promise<ThreadDTO> => {
    const me = requireUser(req);
    const other = await userByHandle(req.params.handle);
    if (other.id === me.id) throw new HttpError(400, 'self', "That's you!");
    const rel = await relation(me.id, other.id);
    if (rel.theyBlocked) throw new HttpError(404, 'no_user', 'No one has that name.');
    const before = /^\d{1,19}$/.test(req.query.before ?? '') ? req.query.before : null;
    const { rows } = await db.query<MsgRow>(
      `SELECT ${MSG_COLS} FROM direct_messages m LEFT JOIN profile_photos p ON p.id = m.photo_id
        WHERE ((m.sender_id = $1 AND m.recipient_id = $2 AND NOT m.deleted_by_sender)
            OR (m.sender_id = $2 AND m.recipient_id = $1 AND NOT m.deleted_by_recipient AND NOT m.is_shadow))
          AND ($3::bigint IS NULL OR m.id < $3)
        ORDER BY m.id DESC LIMIT $4`,
      [me.id, other.id, before, MESSAGES.pageSize],
    );
    await db.query('UPDATE direct_messages SET read_at = now() WHERE sender_id = $2 AND recipient_id = $1 AND read_at IS NULL', [me.id, other.id]);
    const messages = await Promise.all(rows.reverse().map((r) => toDTO(me, r)));
    return {
      with: publicUser(other),
      canSend: (await cannotMessage(me, other.id)) === null,
      reason: await cannotMessage(me, other.id),
      messages,
      olderCursor: rows.length === MESSAGES.pageSize ? rows[0].id : null,
    };
  });

  /** Send text, a photo, or both. */
  app.post<{ Params: { handle: string } }>('/api/messages/:handle', async (req, reply) => {
    const me = requireUser(req);
    const b = parse(SendBody, req.body);
    const other = await userByHandle(req.params.handle);
    const why = await cannotMessage(me, other.id);
    if (why) throw new HttpError(403, 'cannot_message', why);

    let body: string | null = null;
    let shadow = false;
    if (b.body && b.body.trim()) {
      const v = await checkSocialText(me, b.body, 'dm');
      if (!v.ok) throw new HttpError(400, v.error, v.message);
      body = v.body;
      shadow = v.shadow;
    }
    let photo: Awaited<ReturnType<typeof photoRow>> = null;
    if (b.photoId) {
      photo = await photoRow(b.photoId);
      if (!photo || photo.user_id !== me.id) throw new HttpError(400, 'photo', 'You can only share your own photos.');
      if (photo.is_private) {
        if (me.isMinor) throw new HttpError(403, 'adults_only', ADULTS_ONLY);
        // Deliberately vague, so the message never reveals the other member's age.
        if (!(await bothAdults(me.id, other.id))) throw new HttpError(403, 'not_allowed', "Private photos can't be shared with this member. Try one of your public photos.");
      }
    }
    if (!body && !photo) throw new HttpError(400, 'empty', 'Type a message or pick a photo.');

    let rows: { id: string }[];
    try {
      ({ rows } = await db.query<{ id: string }>(
        'INSERT INTO direct_messages (sender_id, recipient_id, body, photo_id, is_shadow) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [me.id, other.id, body, photo?.id ?? null, shadow],
      ));
    } catch (e) {
      // The database's own age-group guard (backstop for the check above).
      if ((e as { constraint?: string }).constraint === 'dm_same_age_group') throw new HttpError(403, 'cannot_message', "You can't send private messages to this member.");
      throw e;
    }
    // Sharing a private photo lets this one friend see this one photo.
    if (photo?.is_private && !shadow) {
      await db.query('INSERT INTO photo_shares (photo_id, recipient_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [photo.id, other.id]);
    }
    if (!shadow) {
      const { rows: c } = await db.query<{ n: number }>('UPDATE users SET dm_count = dm_count + 1 WHERE id = $1 RETURNING dm_count AS n', [me.id]);
      afterPrivateMessage(me.id, Number(c[0]?.n ?? 0));
      io.to(rooms.user(other.id)).emit('dm', { from: me.handle, id: rows[0].id });
      pushTo(other.id, 'dm', { title: `${me.handle} sent you a message`, body: 'Tap to read it.', url: `/messages/${me.handle}`, tag: `dm-${me.handle}` });
    }
    return reply.status(201).send({ id: rows[0].id });
  });

  /** Delete a message from your own view (the other person keeps their copy, as with texts). */
  app.delete<{ Params: { id: string } }>('/api/messages/item/:id', async (req) => {
    const me = requireUser(req);
    await db.query(
      `UPDATE direct_messages SET deleted_by_sender = deleted_by_sender OR sender_id = $2,
              deleted_by_recipient = deleted_by_recipient OR recipient_id = $2
        WHERE id = $1 AND (sender_id = $2 OR recipient_id = $2)`,
      [req.params.id, me.id],
    );
    return { ok: true };
  });
}
