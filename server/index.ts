import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { createAdapter } from '@socket.io/redis-adapter';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Server } from 'socket.io';
import { registerAuthRoutes, userFromToken } from './auth.js';
import { registerChatRoutes } from './chat.js';
import { env } from './env.js';
import { sendError } from './http.js';
import { registerFeedRoutes } from './feed.js';
import { registerFriendRoutes } from './friends.js';
import { registerModerationRoutes } from './moderation.js';
import { registerMessageRoutes } from './messages.js';
import { registerPhotoRoutes } from './photos.js';
import { registerProfileRoutes } from './profiles.js';
import { migrate } from './migrate.js';
import { registerSettingsRoutes } from './settings.js';
import { registerRoomRoutes } from './rooms.js';
import { registerOnlineRoutes, registerPeopleRoutes } from './people.js';
import { registerPushRoutes, setupPush } from './push.js';
import { blockAndRecord, loadBlocks, registerAdminRoutes } from './admin.js';
import { registerCommentRoutes } from './comments.js';
import { downloadMissingRoomImages, registerRoomImageRoutes, syncRoomImages } from './room-images.js';
import { setupRealtime, type IO } from './realtime.js';
import { pruneOldSignals } from './safety/signals.js';
import { registerSocialRoutes } from './social.js';
import { db, redis } from './store.js';

const app = Fastify({
  logger: { level: env.isProd ? 'info' : 'debug' },
  trustProxy: env.trustProxy,
  bodyLimit: 16 * 1024,
});

await app.register(cookie);
app.decorateRequest('user', null);

app.addHook('onRequest', async (req, reply) => {
  // Long-lived device id (http-only; used only as a hashed ban-evasion signal).
  if (!req.cookies.did) {
    reply.setCookie('did', randomBytes(18).toString('base64url'), {
      httpOnly: true, sameSite: 'lax', secure: env.isProd, path: '/', maxAge: 2 * 365 * 24 * 3600,
    });
  }
  req.user = await userFromToken(req.cookies.sid);
  return blockAndRecord(req, reply);
});

// Basic hardening headers. No third-party scripts, so the policy can be strict.
app.addHook('onSend', async (_req, reply) => {
  reply.header('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
});

app.setErrorHandler((err, _req, reply) => sendError(reply, err));

await app.register(fastifyStatic, { root: resolve('client/public'), index: false, wildcard: false }); // one route per built file; the catch-all below handles pages

// Every page is a real address (/home, /rooms, /room/tavern, /profile/John, /settings...).
// Anything that isn't the API or a file gets the site's single HTML page, which draws that page.
const PAGE = /^\/(|home|rooms|room\/[a-z0-9-]+(\/manage)?|new-room|edit-profile|people|admin|friends|messages(\/[A-Za-z0-9_]{3,16})?|profile\/[A-Za-z0-9_]{3,16}(\/(photos|comments))?|photo\/\d{1,19}|settings(\/[a-z-]+)?|login|signup|verify|mod)\/?$/;
const servePage = async (req: FastifyRequest, reply: FastifyReply) => {
  const path = req.url.split('?')[0];
  if (path === '/mod') return reply.sendFile('mod.html');
  if (PAGE.test(path)) return reply.sendFile('index.html');
  return reply.callNotFound();
};
app.get('/', servePage);
app.get('/*', servePage);

const io: IO = new Server(app.server, { serveClient: false, maxHttpBufferSize: 16 * 1024 });
io.adapter(createAdapter(redis.duplicate(), redis.duplicate()));
setupRealtime(io);

registerAuthRoutes(app);
registerSettingsRoutes(app, io);
registerPhotoRoutes(app);
registerProfileRoutes(app, io);
registerMessageRoutes(app, io);
registerFriendRoutes(app, io);
registerFeedRoutes(app);
registerChatRoutes(app);
registerRoomRoutes(app, io);
registerRoomImageRoutes(app);
registerPeopleRoutes(app);
registerOnlineRoutes(app);
registerPushRoutes(app);
registerAdminRoutes(app, io);
registerCommentRoutes(app, io);
registerSocialRoutes(app, io);
registerModerationRoutes(app, io);

app.get('/healthz', async () => {
  await db.query('SELECT 1');
  await redis.ping();
  return { ok: true };
});

// Hourly housekeeping.
const housekeeping = setInterval(async () => {
  try {
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    await db.query('DELETE FROM verification_codes WHERE expires_at < now()');
    await pruneOldSignals();
  } catch (e) {
    app.log.error(e, 'housekeeping failed');
  }
}, 3600_000);

const shutdown = async () => {
  clearInterval(housekeeping);
  io.close();
  await app.close();
  await db.end();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await migrate((m) => app.log.info(m));
await syncRoomImages();
await loadBlocks();
await setupPush((m) => app.log.info(m)).catch((e) => app.log.error(e, 'push notifications unavailable'));

// One server: nobody is connected yet, so start the online and in-room counts from zero.
// (Open pages reconnect within seconds and rejoin their room.)
if (process.env.RESET_PRESENCE_ON_START !== 'false') {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'presence:*', 'COUNT', 200);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
  await redis.del('online');
}

await app.listen({ port: env.port, host: env.host });

// Fetch any room pictures not stored yet, without holding up the site.
void downloadMissingRoomImages((m) => app.log.info(m)).catch((e) => app.log.error(e, 'room pictures failed'));
