-- Retro Room Chat schema. Safe to run more than once (drops nothing; creates if missing).

CREATE TABLE IF NOT EXISTS users (
  id                BIGSERIAL PRIMARY KEY,
  handle            TEXT NOT NULL CHECK (handle ~ '^[A-Za-z0-9_]{3,16}$'),
  email             TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  phone_verified_at TIMESTAMPTZ,
  password_hash     TEXT NOT NULL,
  trust_level       SMALLINT NOT NULL DEFAULT 0 CHECK (trust_level BETWEEN 0 AND 4),
  message_count     INTEGER NOT NULL DEFAULT 0,  -- lifetime count; messages themselves are pruned
  needs_review      BOOLEAN NOT NULL DEFAULT false, -- flagged by ban-evasion signals
  prefs             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_lower ON users (lower(handle));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower  ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,               -- sha256 of the cookie token; the token itself is never stored
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  ip_prefix   TEXT,                           -- HMAC of the network prefix
  device_hash TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS verification_codes (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel)
);

CREATE TABLE IF NOT EXISTS rooms (
  id                SERIAL PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,32}$'),
  name              TEXT NOT NULL,
  category          TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  min_trust_to_post SMALLINT NOT NULL DEFAULT 1,
  slow_mode_seconds INTEGER NOT NULL DEFAULT 0 CHECK (slow_mode_seconds >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Room kinds: 'site' = one of the 20 official, strictly auto-moderated rooms;
-- 'member' = created by a verified member, optionally invite-only (whitelist).
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'site';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS whitelist_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS description TEXT;
DO $$ BEGIN
  ALTER TABLE rooms ADD CONSTRAINT rooms_kind_owner CHECK (
    (kind = 'site' AND owner_id IS NULL AND NOT whitelist_only) OR (kind = 'member' AND owner_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE rooms ADD CONSTRAINT rooms_description_len CHECK (description IS NULL OR char_length(description) <= 140);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS rooms_owner ON rooms (owner_id) WHERE owner_id IS NOT NULL;

-- The site-room pool is fixed at 20.
CREATE OR REPLACE FUNCTION rooms_site_cap() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'site' AND (SELECT count(*) FROM rooms WHERE kind = 'site' AND id <> NEW.id) >= 20 THEN
    RAISE EXCEPTION 'there can be at most 20 site rooms';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rooms_site_cap ON rooms;
CREATE TRIGGER rooms_site_cap BEFORE INSERT OR UPDATE OF kind ON rooms
  FOR EACH ROW EXECUTE FUNCTION rooms_site_cap();

-- Who may enter an invite-only member room (the owner always may).
CREATE TABLE IF NOT EXISTS room_whitelist (
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_whitelist_user ON room_whitelist (user_id);

CREATE TABLE IF NOT EXISTS room_moderators (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id       BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The 420 visible-character rule is enforced in the app (emoji need grapheme counting);
  -- this is a hard backstop against anything bypassing it.
  body          TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  mentions      BIGINT[] NOT NULL DEFAULT '{}',
  is_shadow     BOOLEAN NOT NULL DEFAULT false,
  hidden_at     TIMESTAMPTZ,
  hidden_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  hidden_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_room_newest ON messages (room_id, id DESC);

CREATE TABLE IF NOT EXISTS ignores (
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ignored_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL DEFAULT 'ignore' CHECK (mode IN ('ignore', 'block')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ignored_user_id),
  CHECK (user_id <> ignored_user_id)
);
CREATE INDEX IF NOT EXISTS ignores_target ON ignores (ignored_user_id);

CREATE TABLE IF NOT EXISTS reports (
  id               BIGSERIAL PRIMARY KEY,
  reporter_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id          INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  message_id       BIGINT,                    -- no FK: the message may be pruned; the snapshot keeps it
  message_snapshot JSONB NOT NULL,
  reason           TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolved_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, message_id)
);
CREATE INDEX IF NOT EXISTS reports_open ON reports (status, created_at);

CREATE TABLE IF NOT EXISTS sanctions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('mute', 'kick', 'ban', 'shadow_mute')),
  room_id    INTEGER REFERENCES rooms(id) ON DELETE CASCADE, -- NULL = site-wide
  reason     TEXT NOT NULL,
  issued_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- NULL = automatic
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,                                    -- NULL = until revoked
  revoked_at TIMESTAMPTZ,
  revoked_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS sanctions_user_active ON sanctions (user_id) WHERE revoked_at IS NULL;

-- Append-only. No foreign keys, so deleting a user can never rewrite history.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    BIGINT,          -- NULL = system
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_newest ON audit_log (id DESC);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TABLE IF NOT EXISTS device_signals (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_hash TEXT NOT NULL,   -- HMAC with SIGNAL_SECRET; raw IPs and ids are never stored
  kind        TEXT NOT NULL CHECK (kind IN ('device', 'ip_prefix')),
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, signal_hash)
);
CREATE INDEX IF NOT EXISTS device_signals_hash ON device_signals (signal_hash);

-- ================= Accounts: age, clone-proof handles, 2FA =================
ALTER TABLE users ADD COLUMN IF NOT EXISTS birthdate DATE;                 -- never shown to others
ALTER TABLE users ADD COLUMN IF NOT EXISTS handle_skeleton TEXT;           -- see shared/handles.ts
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT CHECK (bio IS NULL OR char_length(bio) <= 500);
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;               -- base32; set while enrolling
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_skeleton ON users (handle_skeleton);

-- Skeletons of deleted accounts stay reserved forever, so nobody can re-register a lookalike.
CREATE TABLE IF NOT EXISTS handle_reservations (
  skeleton   TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backup_codes (
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, code_hash)
);

-- ================= Social =================
-- One row per pair, smaller id first. status 'pending' = requested_by is waiting on the other.
CREATE TABLE IF NOT EXISTS friendships (
  user_a       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at  TIMESTAMPTZ,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships (user_b);

CREATE TABLE IF NOT EXISTS statuses (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  hidden_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS statuses_user_newest ON statuses (user_id, id DESC);

CREATE TABLE IF NOT EXISTS profile_comments (
  id              BIGSERIAL PRIMARY KEY,
  profile_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  hidden_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profile_comments_profile ON profile_comments (profile_user_id, id DESC);

CREATE TABLE IF NOT EXISTS profile_photos (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file       TEXT NOT NULL UNIQUE,         -- random file name under UPLOAD_DIR
  dhash      BIGINT NOT NULL,              -- 64-bit difference hash, for copy detection
  position   SMALLINT NOT NULL DEFAULT 0,  -- 0 = profile picture
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profile_photos_user ON profile_photos (user_id, position);

CREATE TABLE IF NOT EXISTS room_favorites (
  user_id    BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, room_id)
);

-- Reports can now point at profile content as well as chat lines.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'message';
DO $$ BEGIN
  ALTER TABLE reports ADD CONSTRAINT reports_target_kind CHECK (target_kind IN ('message', 'profile', 'comment', 'status', 'photo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_id BIGINT;

-- ================= Clone-proof handles, enforced in the database =================
-- Mirrors shared/handles.ts handleSkeleton() exactly (a test checks they agree).
CREATE OR REPLACE FUNCTION handle_skeleton(h TEXT) RETURNS TEXT IMMUTABLE LANGUAGE sql AS $fn$
  SELECT regexp_replace(
           replace(replace(replace(
             translate(replace(lower(h), '_', ''), '0123456789', 'olzeasbtbg'),
           'rn', 'm'), 'vv', 'w'), 'i', 'l'),
         '(.)\1+', '\1', 'g')
$fn$;

CREATE OR REPLACE FUNCTION users_handle_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.handle IS DISTINCT FROM OLD.handle THEN
    RAISE EXCEPTION 'handles are permanent';
  END IF;
  NEW.handle_skeleton := handle_skeleton(NEW.handle);
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM handle_reservations WHERE skeleton = NEW.handle_skeleton) THEN
    RAISE EXCEPTION 'handle is reserved' USING ERRCODE = '23505', CONSTRAINT = 'handle_reserved';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_handle_guard ON users;
CREATE TRIGGER users_handle_guard BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_handle_guard();

UPDATE users SET handle_skeleton = handle_skeleton(handle) WHERE handle_skeleton IS NULL;
ALTER TABLE users ALTER COLUMN handle_skeleton SET NOT NULL;

-- When an account is deleted its skeleton is reserved forever.
CREATE OR REPLACE FUNCTION users_reserve_on_delete() RETURNS trigger AS $$
BEGIN
  INSERT INTO handle_reservations (skeleton, handle, reason) VALUES (OLD.handle_skeleton, OLD.handle, 'account deleted')
  ON CONFLICT (skeleton) DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_reserve_on_delete ON users;
CREATE TRIGGER users_reserve_on_delete AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION users_reserve_on_delete();
