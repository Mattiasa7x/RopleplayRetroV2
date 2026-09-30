import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { syncRegionalRooms } from './regional.js';
import { registerQuillRoutes } from './quill.js';
import { rooms, setupRealtime, type IO } from './realtime.js';
import { pruneOldSignals } from './safety/signals.js';
import { registerSocialRoutes } from './social.js';
import { registerTrophyRoutes, startTrophies } from './trophies.js';
import { inviteShell, pageDecision } from './pages.js';
import { readFile } from 'node:fs/promises';
import { registerGiftRoutes } from './gifts.js';
import { PROFILE } from '../shared/config.js';
import { db, describeDatabase, redis } from './store.js';

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

// Every page is a real address (/home, /rooms, /room/tavern, /profile/John, /settings...);
// see server/pages.ts for which pages a visitor without an account may open.
/**
 * The app's code and styles are linked with a version (a hash of their contents), so every deploy
 * makes browsers, and phones' home-screen apps, fetch the new ones instead of a cached old copy.
 */
const assetVersion = (() => {
  const h = createHash('sha1');
  for (const f of ['client/public/app.js', 'client/public/styles.css']) {
    try { h.update(readFileSync(resolve(f))); } catch { /* not built (tests) */ }
  }
  return h.digest('hex').slice(0, 10);
})();
const versioned = (html: string) => html
  .replace('href="/styles.css"', `href="/styles.css?v=${assetVersion}"`)
  .replace('src="/app.js"', `src="/app.js?v=${assetVersion}"`);
const shells = new Map<string, string>();
const shell = async (file: string) => {
  let html = shells.get(file);
  if (!html) { html = versioned(await readFile(resolve('client/public', file), 'utf8')); shells.set(file, html); }
  return html;
};
let inviteHtml: string | undefined;
const servePage = async (req: FastifyRequest, reply: FastifyReply) => {
  const [path, query = ''] = req.url.split('?');
  const d = pageDecision(path, query, !!req.user);
  if (d.kind === 'none') return reply.callNotFound();
  // The page shell is always fetched fresh, so the sign-in check can't be skipped by a cached copy.
  reply.header('Cache-Control', 'no-cache, private');
  if (d.kind === 'redirect') return reply.redirect(d.to, 302);
  if (d.invite) {
    inviteHtml ??= await shell('index.html');
    const code = new URLSearchParams(query).get('invite') ?? '';
    return reply.type('text/html; charset=utf-8').send(inviteShell(inviteHtml, `https://roleplayretro.com/signup?invite=${encodeURIComponent(code)}`));
  }
  if (d.file === 'index.html' || d.file === 'mod.html') return reply.type('text/html; charset=utf-8').send(await shell(d.file));
  return reply.sendFile(d.file);
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
registerTrophyRoutes(app);
registerGiftRoutes(app, io);
registerQuillRoutes(app);
registerCommentRoutes(app, io);
registerSocialRoutes(app, io);
registerModerationRoutes(app, io);

// Deliberately doesn't touch the database: uptime monitors and Render's own checks hit this every
// few seconds, and on Neon that would keep the database awake around the clock (and use up the
// free compute hours). Real traffic still wakes it on the first page view.
app.get('/healthz', async () => {
  await redis.ping();
  return { ok: true };
});

// Hourly housekeeping.
const housekeeping = setInterval(async () => {
  try {
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    await db.query('DELETE FROM verification_codes WHERE expires_at < now()');
    await pruneOldSignals();
    await db.query(`DELETE FROM profile_views WHERE viewed_at < now() - make_interval(days => ${PROFILE.viewsKeptDays})`);
  } catch (e) {
    app.log.error(e, 'housekeeping failed');
  }
}, 3600_000);

const shutdown = async () => {
  clearInterval(housekeeping);
  clearInterval(trophyTimer);
  io.close();
  await app.close();
  await db.end();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await migrate((m) => app.log.info(m));
app.log.info(await describeDatabase());
await syncRegionalRooms();
await syncRoomImages();
await loadBlocks();
const trophyTimer = startTrophies((userId, ids) => io.to(rooms.user(userId)).emit('trophy', { ids }), (e) => app.log.error(e, 'trophy check failed'));
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
