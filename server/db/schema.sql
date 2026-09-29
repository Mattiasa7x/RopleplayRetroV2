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

-- ================= Photos stored in the database, private album, private messages =================
-- Photos now live in PostgreSQL (photo_blobs), so they survive restarts on hosts without a disk.
ALTER TABLE profile_photos ALTER COLUMN file DROP NOT NULL;
ALTER TABLE profile_photos ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE profile_photos ADD COLUMN IF NOT EXISTS width INTEGER;
ALTER TABLE profile_photos ADD COLUMN IF NOT EXISTS height INTEGER;
CREATE INDEX IF NOT EXISTS profile_photos_user_private ON profile_photos (user_id, is_private, position);

CREATE TABLE IF NOT EXISTS photo_blobs (
  photo_id BIGINT NOT NULL REFERENCES profile_photos(id) ON DELETE CASCADE,
  variant  TEXT NOT NULL CHECK (variant IN ('full', 'thumb')),
  mime     TEXT NOT NULL,
  data     BYTEA NOT NULL,
  PRIMARY KEY (photo_id, variant)
);

-- Friends the owner lets see their whole private album.
CREATE TABLE IF NOT EXISTS album_access (
  owner_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, viewer_id),
  CHECK (owner_id <> viewer_id)
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id                   BIGSERIAL PRIMARY KEY,
  sender_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body                 TEXT CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 5000),
  photo_id             BIGINT REFERENCES profile_photos(id) ON DELETE SET NULL,
  is_shadow            BOOLEAN NOT NULL DEFAULT false,
  read_at              TIMESTAMPTZ,
  deleted_by_sender    BOOLEAN NOT NULL DEFAULT false,
  deleted_by_recipient BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)  -- body and photo may both end up empty if the photo is later deleted
);
CREATE INDEX IF NOT EXISTS dm_pair ON direct_messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), id DESC);
CREATE INDEX IF NOT EXISTS dm_unread ON direct_messages (recipient_id) WHERE read_at IS NULL;

-- One photo shared with one person in a private message (works even for private-album photos).
CREATE TABLE IF NOT EXISTS photo_shares (
  photo_id     BIGINT NOT NULL REFERENCES profile_photos(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (photo_id, recipient_id)
);

DO $$ BEGIN
  ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_kind;
  ALTER TABLE reports ADD CONSTRAINT reports_target_kind CHECK (target_kind IN ('message', 'profile', 'comment', 'status', 'photo', 'dm'));
END $$;

-- ================= Private album: members 18 and over only =================
-- 18 here matches AGE.adult in shared/config.ts. No birthdate on file counts as under 18.
CREATE OR REPLACE FUNCTION is_adult_user(uid BIGINT) RETURNS BOOLEAN STABLE LANGUAGE sql AS $fn$
  SELECT COALESCE((SELECT birthdate <= current_date - interval '18 years' FROM users WHERE id = uid), false)
$fn$;

-- No new private photos for under-18 accounts (uploading as private, or moving a photo to private).
CREATE OR REPLACE FUNCTION private_photo_adults_only() RETURNS trigger AS $$
BEGIN
  IF NEW.is_private AND NOT is_adult_user(NEW.user_id) THEN
    RAISE EXCEPTION 'private photos are for members 18 and over' USING ERRCODE = '23514', CONSTRAINT = 'private_album_adults';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS private_photo_adults_only ON profile_photos;
CREATE TRIGGER private_photo_adults_only BEFORE INSERT OR UPDATE OF is_private ON profile_photos
  FOR EACH ROW EXECUTE FUNCTION private_photo_adults_only();

-- Album access only between two adults.
CREATE OR REPLACE FUNCTION album_access_adults_only() RETURNS trigger AS $$
BEGIN
  IF NOT is_adult_user(NEW.owner_id) OR NOT is_adult_user(NEW.viewer_id) THEN
    RAISE EXCEPTION 'album access is for members 18 and over' USING ERRCODE = '23514', CONSTRAINT = 'private_album_adults';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS album_access_adults_only ON album_access;
CREATE TRIGGER album_access_adults_only BEFORE INSERT OR UPDATE ON album_access
  FOR EACH ROW EXECUTE FUNCTION album_access_adults_only();

-- A private photo can only be shared from an adult to an adult.
CREATE OR REPLACE FUNCTION photo_share_adults_only() RETURNS trigger AS $$
BEGIN
  IF NOT is_adult_user(NEW.recipient_id)
     OR NOT is_adult_user((SELECT user_id FROM profile_photos WHERE id = NEW.photo_id)) THEN
    RAISE EXCEPTION 'private photos are for members 18 and over' USING ERRCODE = '23514', CONSTRAINT = 'private_album_adults';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS photo_share_adults_only ON photo_shares;
CREATE TRIGGER photo_share_adults_only BEFORE INSERT OR UPDATE ON photo_shares
  FOR EACH ROW EXECUTE FUNCTION photo_share_adults_only();

-- Clean up anything from before this rule (runs on every start; cheap).
DELETE FROM album_access WHERE NOT is_adult_user(owner_id) OR NOT is_adult_user(viewer_id);
DELETE FROM photo_shares s USING profile_photos p
 WHERE s.photo_id = p.id AND (NOT is_adult_user(s.recipient_id) OR NOT is_adult_user(p.user_id));

-- ================= Character age, and no private messages between adults and under-18s =================
-- Character age is roleplay only (15-999) and shown on the profile. Safety rules use the real birthdate.
-- Free text up to 24 characters ("0", "Newborn", "12,000 years", "Ageless"); no age limits.
ALTER TABLE users ADD COLUMN IF NOT EXISTS character_age TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_character_age;
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'character_age') <> 'text' THEN
    ALTER TABLE users ALTER COLUMN character_age TYPE TEXT USING character_age::text;
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_character_age_len CHECK (character_age IS NULL OR char_length(character_age) BETWEEN 1 AND 24);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The real birthdate can never be changed once set (so an under-18 account can't make itself "adult").
CREATE OR REPLACE FUNCTION users_birthdate_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.birthdate IS NOT NULL AND NEW.birthdate IS DISTINCT FROM OLD.birthdate THEN
    RAISE EXCEPTION 'birthdate cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_birthdate_locked ON users;
CREATE TRIGGER users_birthdate_locked BEFORE UPDATE OF birthdate ON users
  FOR EACH ROW EXECUTE FUNCTION users_birthdate_locked();

-- Private messages only between two adults or two under-18 members, never across.
CREATE OR REPLACE FUNCTION dm_same_age_group() RETURNS trigger AS $$
BEGIN
  IF is_adult_user(NEW.sender_id) <> is_adult_user(NEW.recipient_id) THEN
    RAISE EXCEPTION 'private messages between adults and members under 18 are not allowed'
      USING ERRCODE = '23514', CONSTRAINT = 'dm_same_age_group';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS dm_same_age_group ON direct_messages;
CREATE TRIGGER dm_same_age_group BEFORE INSERT ON direct_messages
  FOR EACH ROW EXECUTE FUNCTION dm_same_age_group();

-- ---------------------------------------------------------------------------
-- Room pictures. Photos come from room-images.json (free-licence photos, fetched
-- and resized by the server on start) and are shared by site rooms and the pool
-- members pick from for their own rooms.
CREATE TABLE IF NOT EXISTS room_images (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  title       TEXT NOT NULL,
  source_url  TEXT,
  credit      TEXT,
  credit_url  TEXT,
  in_pool     BOOLEAN NOT NULL DEFAULT true,
  full_data   BYTEA,
  thumb_data  BYTEA,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS image_id INTEGER REFERENCES room_images(id) ON DELETE SET NULL;

-- Where a member's character lives (roleplay, free text), shown in room people lists.
ALTER TABLE users ADD COLUMN IF NOT EXISTS character_city TEXT;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_character_city_len CHECK (character_city IS NULL OR char_length(character_city) BETWEEN 1 AND 40);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- When a member last edited their profile (bio, character age or city): feeds "updated their profile".
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ;

-- Friend activity feed reads these newest-first per person.
CREATE INDEX IF NOT EXISTS profile_comments_author ON profile_comments (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS profile_photos_user_created ON profile_photos (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS statuses_user_created ON statuses (user_id, created_at DESC);

-- One status per member (a new one replaces the old): drop any older ones left from before.
DELETE FROM statuses s WHERE EXISTS (SELECT 1 FROM statuses n WHERE n.user_id = s.user_id AND n.id > s.id);

-- ---------------------------------------------------------------------------
-- Profile redesign: banner picture, character birthday/gender/style/sheet, 1000-character About,
-- and a phone number that, like the birthdate, can't be changed once set.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_bio_check;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_bio_len CHECK (bio IS NULL OR char_length(bio) <= 1000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS character_birthday DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS character_gender TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rp_style TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS character_sheet JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_character_gender_len CHECK (character_gender IS NULL OR char_length(character_gender) BETWEEN 1 AND 16);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_rp_style_valid CHECK (rp_style IS NULL OR rp_style IN ('Literary', 'Casual', 'Worldbuilding', 'Slice of Life', 'NSFW', 'Chatter'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_character_sheet_size CHECK (octet_length(character_sheet::text) <= 20000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_phone_format CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{7,15}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Phone number, like the birthdate, is set once and then locked.
CREATE OR REPLACE FUNCTION users_phone_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.phone IS NOT NULL AND NEW.phone IS DISTINCT FROM OLD.phone THEN
    RAISE EXCEPTION 'phone number cannot be changed' USING ERRCODE = '23514', CONSTRAINT = 'users_phone_locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_phone_locked ON users;
CREATE TRIGGER users_phone_locked BEFORE UPDATE OF phone ON users
  FOR EACH ROW EXECUTE FUNCTION users_phone_locked();

-- NSFW as a roleplay style is for adults only.
CREATE OR REPLACE FUNCTION users_rp_style_adult() RETURNS trigger AS $$
BEGIN
  IF NEW.rp_style = 'NSFW' AND NOT is_adult_user(NEW.id) THEN
    RAISE EXCEPTION 'NSFW roleplay style is for members 18 and over' USING ERRCODE = '23514', CONSTRAINT = 'rp_style_adults_only';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_rp_style_adult ON users;
CREATE TRIGGER users_rp_style_adult BEFORE UPDATE OF rp_style ON users
  FOR EACH ROW EXECUTE FUNCTION users_rp_style_adult();

-- One banner picture per member (wide, shown across the top of their profile).
CREATE TABLE IF NOT EXISTS profile_banners (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comments under each photo (each photo keeps its newest 1000, like profiles).
CREATE TABLE IF NOT EXISTS photo_comments (
  id         BIGSERIAL PRIMARY KEY,
  photo_id   BIGINT NOT NULL REFERENCES profile_photos(id) ON DELETE CASCADE,
  author_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  hidden_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_comments_photo ON photo_comments (photo_id, id DESC);

DO $$ BEGIN
  ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_kind;
  ALTER TABLE reports ADD CONSTRAINT reports_target_kind CHECK (target_kind IN ('message', 'profile', 'comment', 'status', 'photo', 'dm', 'photo_comment'));
END $$;

-- Profile background: one of the room pictures (site rooms and the pool).
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_theme_id INTEGER REFERENCES room_images(id) ON DELETE SET NULL;

-- Member room settings: the owner's chat filter (on = messages with swear words are refused
-- in that room), and names that can't be changed once the room is made.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS chat_filter BOOLEAN NOT NULL DEFAULT true;
CREATE OR REPLACE FUNCTION rooms_member_name_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.kind = 'member' AND NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'member room names cannot be changed' USING ERRCODE = '23514', CONSTRAINT = 'room_name_locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rooms_member_name_locked ON rooms;
CREATE TRIGGER rooms_member_name_locked BEFORE UPDATE OF name ON rooms
  FOR EACH ROW EXECUTE FUNCTION rooms_member_name_locked();

-- Browser push notifications: one row per device that turned them on.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE CHECK (char_length(endpoint) <= 1000),
  p256dh     TEXT NOT NULL CHECK (char_length(p256dh) <= 200),
  auth       TEXT NOT NULL CHECK (char_length(auth) <= 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

-- Server-generated keys (e.g. the push signing key pair), created once on first start.
CREATE TABLE IF NOT EXISTS app_secrets (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Exact addresses are kept too (hashed, like everything else here) so an admin ban can
-- block the banned member's own connection, not just their whole network.
ALTER TABLE device_signals DROP CONSTRAINT IF EXISTS device_signals_kind_check;
DO $$ BEGIN
  ALTER TABLE device_signals ADD CONSTRAINT device_signals_kind_ok CHECK (kind IN ('device', 'ip_prefix', 'ip'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Site-wide blocks from an admin ban: hashed IP addresses and device ids. Any request from a
-- blocked address or device is refused, logged in or not.
CREATE TABLE IF NOT EXISTS site_blocks (
  signal_hash TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('device', 'ip')),
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_blocks_user ON site_blocks (user_id);

-- One admin only: the site owner's account (set from ADMIN_HANDLE on start). The database
-- refuses to make anyone else an admin, however the request arrives.
CREATE OR REPLACE FUNCTION users_single_admin() RETURNS trigger AS $$
BEGIN
  IF NEW.trust_level >= 4 AND NEW.id::text IS DISTINCT FROM (SELECT value FROM app_secrets WHERE key = 'admin_user_id') THEN
    RAISE EXCEPTION 'only the site owner can be an admin' USING ERRCODE = '23514', CONSTRAINT = 'single_admin';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_single_admin ON users;
CREATE TRIGGER users_single_admin BEFORE INSERT OR UPDATE OF trust_level ON users
  FOR EACH ROW EXECUTE FUNCTION users_single_admin();

-- Trophies earned just by using the site (definitions in shared/trophies.ts).
CREATE TABLE IF NOT EXISTS user_trophies (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trophy_id  TEXT NOT NULL CHECK (trophy_id ~ '^[a-z_]{1,40}$'),
  earned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at    TIMESTAMPTZ,  -- when the "trophy earned" announcement was shown
  PRIMARY KEY (user_id, trophy_id)
);

-- The one trophy shown on a profile: a trophy id, 'none' to show none, or NULL for the newest earned.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_trophy TEXT;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_profile_trophy_format CHECK (profile_trophy IS NULL OR profile_trophy ~ '^[a-z_]{1,40}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Lifetime count of private messages sent (for trophies). Filled from existing messages the first time.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'dm_count') THEN
    ALTER TABLE users ADD COLUMN dm_count INTEGER NOT NULL DEFAULT 0;
    UPDATE users u SET dm_count = c.n
      FROM (SELECT sender_id, count(*) AS n FROM direct_messages WHERE NOT is_shadow GROUP BY sender_id) c
     WHERE c.sender_id = u.id;
  END IF;
END $$;

-- Invitations: every member has a permanent invite code; a new member can enter one at sign-up.
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_invited_by ON users (invited_by) WHERE invited_by IS NOT NULL;
-- 8 characters without look-alikes (no 0/O, 1/I/L), shown as ABCD-EFGH.
CREATE OR REPLACE FUNCTION new_invite_code() RETURNS TEXT AS $$
DECLARE
  alphabet CONSTANT TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  c TEXT;
BEGIN
  LOOP
    c := '';
    FOR i IN 1..8 LOOP
      c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE invite_code = c);
  END LOOP;
  RETURN c;
END $$ LANGUAGE plpgsql VOLATILE;
UPDATE users SET invite_code = new_invite_code() WHERE invite_code IS NULL;
ALTER TABLE users ALTER COLUMN invite_code SET DEFAULT new_invite_code();
ALTER TABLE users ALTER COLUMN invite_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_invite_code ON users (invite_code);

-- Status streak: consecutive days (the member's local date) with a status update.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_best_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_last_day DATE;

-- Who viewed whose profile, and when (latest visit per viewer). Only the profile owner sees it.
CREATE TABLE IF NOT EXISTS profile_views (
  profile_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_user_id, viewer_id),
  CHECK (profile_user_id <> viewer_id)
);
CREATE INDEX IF NOT EXISTS profile_views_recent ON profile_views (profile_user_id, viewed_at DESC);
-- When the owner last opened their Views list (for the "new" count).
ALTER TABLE users ADD COLUMN IF NOT EXISTS views_seen_at TIMESTAMPTZ;

-- Gifts: one of the catalog gifts (shared/gifts.ts), with an optional private message.
CREATE TABLE IF NOT EXISTS gifts (
  id           BIGSERIAL PRIMARY KEY,
  gift_key     TEXT NOT NULL CHECK (gift_key ~ '^[a-z_]{1,40}$'),
  sender_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message      TEXT CHECK (message IS NULL OR char_length(message) BETWEEN 1 AND 1000),
  hidden_at    TIMESTAMPTZ,  -- held back by the safety filter: the recipient never sees it
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_id IS NULL OR sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS gifts_sender_recent ON gifts (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gifts_recipient ON gifts (recipient_id, id DESC);
-- The one received gift shown on your profile.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_gift_id BIGINT REFERENCES gifts(id) ON DELETE SET NULL;
DO $$ BEGIN
  ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_kind;
  ALTER TABLE reports ADD CONSTRAINT reports_target_kind CHECK (target_kind IN ('message', 'profile', 'comment', 'status', 'photo', 'dm', 'photo_comment', 'gift'));
END $$;
