
-- ============================================================
--  ACCESS CODES  (licenze: superadmin / promo / paid)
-- ============================================================
CREATE TABLE IF NOT EXISTS access_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT UNIQUE NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('superadmin','promo','paid')),
  max_uses      INTEGER,          -- NULL = illimitato
  uses_count    INTEGER NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ,      -- NULL = mai
  note          TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE access_codes ENABLE ROW LEVEL SECURITY;

-- Solo il server (service role) può leggere/scrivere codici
CREATE POLICY "service_select_access_codes" ON access_codes FOR SELECT TO service_role USING (true);
CREATE POLICY "service_insert_access_codes" ON access_codes FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service_update_access_codes" ON access_codes FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_delete_access_codes" ON access_codes FOR DELETE TO service_role USING (true);

-- ============================================================
--  ROOMS
-- ============================================================
CREATE TABLE IF NOT EXISTS rooms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT UNIQUE NOT NULL,
  admin_pin     TEXT NOT NULL,
  access_code   TEXT REFERENCES access_codes(code),
  host_url      TEXT,
  auto_advance  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_select_rooms" ON rooms FOR SELECT TO service_role USING (true);
CREATE POLICY "service_insert_rooms" ON rooms FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service_update_rooms" ON rooms FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_delete_rooms" ON rooms FOR DELETE TO service_role USING (true);

-- ============================================================
--  AUCTION SESSIONS  (una stanza può avere più leghe)
-- ============================================================
CREATE TABLE IF NOT EXISTS auction_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code       TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  auction_name    TEXT NOT NULL DEFAULT 'default',
  config          JSONB NOT NULL DEFAULT '{"STARTING_BUDGET":500,"MAX_TOTAL_PLAYERS":25,"MAX_OFFENSIVE_PLAYERS":6,"LIMITS":{"P":3,"D":10,"C":8,"A":4}}'::jsonb,
  timer_duration  INTEGER NOT NULL DEFAULT 10,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(room_code, auction_name)
);

ALTER TABLE auction_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_select_sessions" ON auction_sessions FOR SELECT TO service_role USING (true);
CREATE POLICY "service_insert_sessions" ON auction_sessions FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service_update_sessions" ON auction_sessions FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_delete_sessions" ON auction_sessions FOR DELETE TO service_role USING (true);

-- ============================================================
--  TEAMS
-- ============================================================
CREATE TABLE IF NOT EXISTS teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code     TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  auction_name  TEXT NOT NULL DEFAULT 'default',
  team_key      TEXT NOT NULL,
  team_name     TEXT NOT NULL,
  budget        INTEGER NOT NULL DEFAULT 500,
  slots         JSONB NOT NULL DEFAULT '{"P":0,"D":0,"C":0,"A":0}'::jsonb,
  UNIQUE(room_code, auction_name, team_key)
);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_select_teams" ON teams FOR SELECT TO service_role USING (true);
CREATE POLICY "service_insert_teams" ON teams FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service_update_teams" ON teams FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_delete_teams" ON teams FOR DELETE TO service_role USING (true);

-- ============================================================
--  PLAYERS LIST  (mazzo disponibile)
-- ============================================================
CREATE TABLE IF NOT EXISTS players_list (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code     TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  auction_name  TEXT NOT NULL DEFAULT 'default',
  nome          TEXT NOT NULL,
  ruolo         TEXT NOT NULL,
  squadra       TEXT NOT NULL DEFAULT 'Svincolato',
  UNIQUE(room_code, auction_name, nome)
);

ALTER TABLE players_list ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_select_players" ON players_list FOR SELECT TO service_role USING (true);
CREATE POLICY "service_insert_players" ON players_list FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service_update_players" ON players_list FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_delete_players" ON players_list FOR DELETE TO service_role USING (true);

-- ============================================================
--  SOLD PLAYERS  (acquisti completati)
-- ============================================================
CREATE TABLE IF NOT EXISTS sold_players (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code         TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  auction_name      TEXT NOT NULL DEFAULT 'default',
  player_name       TEXT NOT NULL,
  ruolo             TEXT NOT NULL,
  squadra           TEXT NOT NULL DEFAULT '',
  winner            TEXT NOT NULL,
  price             INTEGER NOT NULL,
  reparto_assegnato TEXT NOT NULL,
  sold_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sold_players ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_select_sold" ON sold_players FOR SELECT TO service_role USING (true);
CREATE POLICY "service_insert_sold" ON sold_players FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service_update_sold" ON sold_players FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_delete_sold" ON sold_players FOR DELETE TO service_role USING (true);

-- ============================================================
--  SEED: codice SUPERADMIN
-- ============================================================
INSERT INTO access_codes (code, type, max_uses, note, is_active)
VALUES ('DRAFTARENA-SUPERADMIN', 'superadmin', NULL, 'Codice proprietario - accesso illimitato', TRUE)
ON CONFLICT (code) DO NOTHING;
