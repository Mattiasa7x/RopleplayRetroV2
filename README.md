# RoleplayRetro

A text-first roleplay and chat site with the feel of early-2000s phone chat — pick a handle, pick a room,
read ten short lines, reply — rebuilt from scratch with modern safety tools and quality-of-life upgrades.

> **Clean-room project.** Nothing here comes from any existing chat service: no code, graphics,
> names, logos, copy text or traced screen layouts. Keep it that way — see `LICENSES.md`.
> Run a trademark search on "RoleplayRetro" before launch.

## Chat rules (all in `shared/config.ts`)

| Rule | Value |
| --- | --- |
| Message length | 420 visible characters (an emoji counts as 1) |
| Messages per page | 10 |
| Pages of history | 20 |
| Messages kept per room | 200 (older ones pruned on every send; reported lines are snapshotted first) |

## The website

RoleplayRetro is a website (nothing to install) laid out for phones first. Every page has its own
address, a sticky header, and a five-button navigation bar: **Home, Rooms, Friends, Profile, Settings**.

| Page | Address | What's on it |
| --- | --- | --- |
| Home | `/home` | Post a status, favorite rooms, your friends' status feed |
| Rooms | `/rooms`, `/room/:slug` | The 20 site rooms, member rooms, and the chat itself (★ to favorite) |
| Friends | `/friends` | Requests to accept or decline, friends with online dots, add by name |
| Profile | `/profile/:name` | Picture, bio, up to 6 photos, recent statuses, comments; add friend, block, report |
| Settings | `/settings` | Account, password, two-factor sign-in, devices, privacy, chat filter, blocked list, theme, text size, alerts, delete account |

**Look:** light mode is a white background, black text and red borders; dark mode is a black background,
white text and red borders. "Match my device" follows the phone's own setting.

## Accounts and safety

- **Birthdate at signup** (never shown). Minimum age 13. Under 18: the chat filter is locked on, and
  profile visibility and profile comments are locked to friends only.
- **Chat filter:** slurs are always blocked for everyone; milder mature words (`mature-words.txt`) are
  masked (`h***`) for anyone with the filter on, in chat, comments and statuses.
- **Two-factor sign-in** with any authenticator app, plus ten one-time backup codes.
- **Names can't be copied or cloned.** Names are ASCII only, permanent, and reduced to a "skeleton" that
  ignores case, underscores, doubled letters and look-alike swaps (0/o, 1/l/i/I, 5/s, rn/m, vv/w...).
  The database enforces the skeleton as unique, so `John`, `J0HN_` and `jo_hn` can never coexist. Staff
  words (admin, mod, official...) are reserved, and a deleted account's name is reserved forever.
- **Photos can't be cloned either:** each upload is re-encoded (location data stripped) and fingerprinted;
  a photo matching another member's photo is refused.
- **Blocking** hides chat, profiles, comments and friend requests both ways and ends any friendship.

## Two kinds of rooms

| | Site rooms | Member rooms |
| --- | --- | --- |
| How many | Exactly 20 (seeded; a database trigger refuses a 21st) | Up to 3 per verified member |
| Who can see and enter | Every account | Verified members only (email confirmed); invite-only rooms: owner, invited members, admins |
| Who can post | Verified members (new accounts: Newcomers and Help Desk) | Verified members allowed in |
| Moderation | Strict automatic moderation + site moderators | Room owner (kick, mute, room ban, hide lines) + admins |
| Links | Blocked for everyone below staff | Allowed for Established members |

**Strict auto-moderation in site rooms:** each message rejected for rule-breaking (blocked word, link,
repeat, caps, too many mentions, rate limit) or room-hopping counts as a strike. 3 strikes in 10 minutes
= automatic 15-minute mute in that room; 6 in an hour = 60-minute site-wide mute and a spot in the admin
review queue. Accounts under a day old post at most once per 10 seconds, 2 agreeing reports hide a line,
and at most 2 @mentions per message. All thresholds live in `SITE_ROOMS` in `shared/config.ts`.

## Run it locally

Requirements: Node 22+, and either Docker or local PostgreSQL 16 + Redis 7.

```bash
cp .env.example .env            # then set SIGNAL_SECRET to a long random string
docker compose up -d            # PostgreSQL + Redis (skip if you run your own)
npm install
npm run db:init                 # tables + starter rooms (safe to re-run)
npm run dev                     # http://localhost:3000
```

Sign up in the browser. Verification codes are printed in the server log (`[mail] verification code ...`)
until you add a real email adapter in `server/mail.ts`. Make yourself an admin:

```bash
npm run make-admin -- YourHandle
```

Admins and room moderators get a **Mod console** link in the room list (`/mod.html`).
Assign room moderators with `POST /api/admin/moderators {"handle","room","action":"add"}`.

Other scripts: `npm test` (chat rules, paging, filter), `npm run typecheck`, `npm run build && npm start` (production).

## Deploy on Render

`render.yaml` creates the website, its PostgreSQL database and Redis in one step:

1. Put this folder in a GitHub repository.
2. In Render: **New > Blueprint**, pick the repository, fill in `ADMIN_HANDLE` (the name you'll sign up with), **Apply**.
3. The site creates its own tables on first start. Sign up with your `ADMIN_HANDLE` name, then use **Manual Deploy > Restart service** (or any redeploy) so it becomes an admin.
4. Verification codes appear in the service's **Logs** tab until a real email adapter is added.

Free-tier limits to know: the site sleeps after 15 minutes without visitors (about a minute to wake),
uploaded photos are lost whenever it restarts (no disk on free plans), and the free database expires after 30 days.
Move to paid instances plus a disk before real launch.

## Layout

```
shared/           config.ts (all limits), text.ts (length/cleanup/mentions), types.ts (API + socket shapes)
server/
  index.ts        Fastify + Socket.IO wiring, security headers, housekeeping
  auth.ts         signup, login, sessions, email verification, prefs
  chat.ts         room list, history paging, send + prune + promotion
  rooms.ts        room access rules, member rooms (create/edit/delete) and invite lists
  realtime.ts     socket events, presence, typing, ignore-aware delivery
  social.ts       ignore / block lists
  moderation.ts   reports, auto-hide, sanctions, review queue, audit log
  paging.ts       cursor paging (pure, tested)
  safety/         pipeline.ts (the ordered checks), strikes.ts (site-room auto-mutes), filter.ts,
                  limits.ts, signals.ts, blocklist.txt
  settings.ts     preferences with under-18 locks, password, email, devices, 2FA, delete account
  totp.ts         two-factor codes (RFC 6238), backup codes
  account.ts      age and effective settings
  profiles.ts     profiles, photos (re-encode + copy detection), profile comments
  friends.ts      friend requests, friends list, block/friend relationships
  feed.ts         status updates, home feed, favorite rooms
  db/schema.sql   19 tables, clone-proof name triggers; db/seed.sql the 20 site rooms
client/
  src/app.ts      page router (real addresses, no framework)
  src/core.ts     header + navigation, theme, live connection, shared form helpers
  src/views/      home, rooms, room (chat), friends, profile, settings, auth
  src/mod.ts      moderator console
  public/         index.html, mod.html, styles.css (themes: classic, dark, high contrast)
test/             node:test suites
```

## Safety model in one paragraph

Every message passes, in order: sanctions (ban / kick / mute) → trust level for the room →
rate limits (sliding window per user + room slow mode) → flood (repeat and caps checks) →
content filter (blocklist that sees through look-alike spellings, links blocked below Established,
max 3 mentions). New accounts earn trust over time (email → 7 days + 100 messages → Established).
Reports from 3 established members auto-hide a line pending review. Signups that share a hashed
device or network signal with a banned account are shadow-muted and queued for an admin. Every
moderator action lands in an append-only audit log enforced by a database trigger.

## Before going live

- Replace the placeholder `blocklist.txt` and `mature-words.txt`, and review `disposable-domains.txt`.
- Add a real email (and optionally SMS) adapter in `server/mail.ts`.
- Run behind HTTPS; set `NODE_ENV=production` and `TRUST_PROXY=true` behind a proxy.
- Consider swapping scrypt for Argon2id (`@node-rs/argon2`) — see the note in `server/auth.ts`.
- Write a privacy policy that covers the hashed device/network signals (kept 90 days).
- Get the name and branding checked by a trademark lawyer.
