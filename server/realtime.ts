import type { Server, Socket } from 'socket.io';
import type { ClientToServer, ServerToClient } from '../shared/types.js';
import { tokenFromCookieHeader, userFromToken } from './auth.js';
import { SITE_ROOMS } from '../shared/config.js';
import { sendMessage } from './chat.js';
import { HttpError } from './http.js';
import { assertRoomAccess, roomBySlug } from './rooms.js';
import { slidingWindow } from './safety/limits.js';
import { maskMature } from './safety/mature.js';
import { pushTo } from './push.js';
import { socketBlocked } from './admin.js';
import { recordStrike } from './safety/strikes.js';
import { db, redis } from './store.js';

export type IO = Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;
interface SocketData {
  userId: string;
  handle: string;
  roomId: number | null;
  lastTyping: number;
  filter: boolean;
}
type Sock = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

/**
 * Socket rooms used for delivery (they work across servers via the Redis adapter):
 *   room:<id>   everyone currently viewing a chat room
 *   user:<id>   all of one person's open tabs (mentions, shadow lines, kicks)
 *   ign:<id>    every socket whose owner ignores or blocks user <id>;
 *               a message from <id> is sent with .except(`ign:<id>`)
 *   filter:on / filter:off   whether the owner's chat filter is on; a line containing
 *               mature words goes raw to one group and masked to the other
 */
export const rooms = {
  chat: (id: number) => `room:${id}`,
  user: (id: string) => `user:${id}`,
  ignoredBy: (id: string) => `ign:${id}`,
  filterOn: 'filter:on',
  filterOff: 'filter:off',
};

/** Move all of a user's open tabs into the right filter group (called when the setting changes). */
export function setFilterGroup(io: IO, userId: string, on: boolean) {
  const all = io.in(rooms.user(userId));
  all.socketsLeave(on ? rooms.filterOff : rooms.filterOn);
  all.socketsJoin(on ? rooms.filterOn : rooms.filterOff);
}

/** Online = at least one open tab. Stored as a per-user connection count. */
export async function isOnline(userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const counts = await redis.hmget('online', ...userIds);
  return new Set(userIds.filter((_, i) => Number(counts[i] ?? 0) > 0));
}

async function presenceChange(io: IO, roomId: number, userId: string, delta: 1 | -1) {
  const key = `presence:${roomId}`;
  const n = await redis.hincrby(key, userId, delta);
  if (n <= 0) await redis.hdel(key, userId);
  io.to(rooms.chat(roomId)).emit('presence', { roomId, online: await redis.hlen(key) });
}

async function leaveCurrent(io: IO, socket: Sock) {
  const current = socket.data.roomId;
  if (current == null) return;
  socket.data.roomId = null;
  await socket.leave(rooms.chat(current));
  await presenceChange(io, current, socket.data.userId, -1);
}

export function setupRealtime(io: IO) {
  io.use(async (socket, next) => {
    // Admin bans can block a connection outright (the real address is the first forwarded one behind Render's proxy).
    const fwd = String(socket.handshake.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (socketBlocked(socket.handshake.headers, fwd || socket.handshake.address)) return next(new Error('blocked'));
    const user = await userFromToken(tokenFromCookieHeader(socket.handshake.headers.cookie)).catch(() => null);
    if (!user) return next(new Error('login'));
    socket.data = { userId: user.id, handle: user.handle, roomId: null, lastTyping: 0, filter: user.prefs.chatFilter };
    next();
  });

  io.on('connection', async (socket: Sock) => {
    const { userId, handle } = socket.data;
    await socket.join([rooms.user(userId), socket.data.filter ? rooms.filterOn : rooms.filterOff]);
    await redis.hincrby('online', userId, 1);
    const { rows } = await db.query<{ ignored_user_id: string }>('SELECT ignored_user_id FROM ignores WHERE user_id = $1', [userId]);
    if (rows.length) await socket.join(rows.map((r) => rooms.ignoredBy(r.ignored_user_id)));

    socket.on('room:join', async ({ slug }, ack) => {
      try {
        const room = await roomBySlug(String(slug));
        if (socket.data.roomId === room.id) return ack({ ok: true, roomId: room.id });
        // Room-hopping is a common spam/trolling pattern: limit joins per minute.
        if (!(await slidingWindow(redis, `hop:${userId}`, SITE_ROOMS.maxRoomJoinsPerMinute, 60_000))) {
          const extra = room.kind === 'site' ? await recordStrike(userId, room.id, 'room_hop') : null;
          return ack({ ok: false, message: `You're switching rooms too fast. Wait a minute.${extra ? ' ' + extra : ''}` });
        }
        const { rows: u } = await db.query<{ trust_level: number }>('SELECT trust_level FROM users WHERE id = $1', [userId]);
        await assertRoomAccess({ id: userId, trust: u[0]?.trust_level ?? 0 }, room);
        await leaveCurrent(io, socket);
        socket.data.roomId = room.id;
        await socket.join(rooms.chat(room.id));
        await presenceChange(io, room.id, userId, 1);
        await redis.hdel(`mentions:${userId}`, String(room.id)); // viewing the room clears its mention badge
        ack({ ok: true, roomId: room.id });
      } catch (e) {
        ack({ ok: false, message: e instanceof HttpError ? e.message : 'Could not join that room.' });
      }
    });

    socket.on('room:leave', () => void leaveCurrent(io, socket));

    socket.on('msg:send', async ({ slug, body }, ack) => {
      try {
        if (typeof body !== 'string' || body.length > 20_000) return ack({ ok: false, error: 'invalid', message: 'Invalid message.' });
        const out = await sendMessage(userId, String(slug), body);
        if (!out.ok) return ack(out);
        const m = out.message;
        if (out.shadow) {
          // Only the sender's own tabs see it.
          io.to(rooms.user(userId)).emit('msg:new', socket.data.filter ? { ...m, body: maskMature(m.body) } : m);
        } else {
          const masked = maskMature(m.body);
          if (masked === m.body) {
            io.to(rooms.chat(m.roomId)).except(rooms.ignoredBy(userId)).emit('msg:new', m);
          } else {
            io.to(rooms.chat(m.roomId)).except([rooms.ignoredBy(userId), rooms.filterOn]).emit('msg:new', m);
            io.to(rooms.chat(m.roomId)).except([rooms.ignoredBy(userId), rooms.filterOff]).emit('msg:new', { ...m, body: masked });
          }
          if (out.mentionedIds.length) {
            // Skip people who ignore or block the sender.
            const { rows: skip } = await db.query<{ user_id: string }>(
              'SELECT user_id FROM ignores WHERE ignored_user_id = $1 AND user_id = ANY($2)',
              [userId, out.mentionedIds],
            );
            const skipSet = new Set(skip.map((r) => r.user_id));
            for (const id of out.mentionedIds) {
              if (skipSet.has(id)) continue;
              await redis.hincrby(`mentions:${id}`, String(m.roomId), 1);
              io.to(rooms.user(id)).emit('mention', { roomId: m.roomId, roomSlug: String(slug), from: handle, messageId: m.id });
              pushTo(id, 'mention', { title: `${handle} mentioned you`, body: 'Tap to open the room.', url: `/room/${String(slug)}`, tag: `mention-${m.roomId}` });
            }
          }
        }
        ack({ ok: true, message: m });
      } catch (e) {
        if (e instanceof HttpError) return ack({ ok: false, error: e.code, message: e.message });
        console.error(e);
        ack({ ok: false, error: 'server', message: 'Message not sent. Try again.' });
      }
    });

    socket.on('typing', () => {
      const now = Date.now();
      const roomId = socket.data.roomId;
      if (roomId == null || now - socket.data.lastTyping < 3000) return;
      socket.data.lastTyping = now;
      socket.to(rooms.chat(roomId)).except(rooms.ignoredBy(userId)).emit('typing', { roomId, handle });
    });

    socket.on('disconnect', async () => {
      await leaveCurrent(io, socket);
      if ((await redis.hincrby('online', userId, -1)) <= 0) await redis.hdel('online', userId);
    });
  });
}

/** Called by the HTTP layer when someone ignores/unignores, so open tabs update instantly. */
export async function applyIgnore(io: IO, userId: string, targetId: string, on: boolean) {
  const sockets = io.in(rooms.user(userId));
  if (on) sockets.socketsJoin(rooms.ignoredBy(targetId));
  else sockets.socketsLeave(rooms.ignoredBy(targetId));
}

/** Remove a user's sockets from a chat room (kick / room ban). */
export async function removeFromRoom(io: IO, userId: string, roomId: number, reason: string, minutes: number) {
  io.to(rooms.user(userId)).emit('kicked', { roomId, reason, minutes });
  io.in(rooms.user(userId)).socketsLeave(rooms.chat(roomId));
  await redis.hdel(`presence:${roomId}`, userId);
}

/** Site ban: drop every connection. */
export function disconnectUser(io: IO, userId: string) {
  io.in(rooms.user(userId)).disconnectSockets(true);
}
