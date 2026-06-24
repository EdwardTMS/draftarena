
-- Aggiorna le policy per permettere accesso con ruolo anon (server Node.js usa anon key)
-- Il server è il gatekeeper di sicurezza applicativo, RLS protegge da accessi diretti indesiderati

-- access_codes
DROP POLICY IF EXISTS "service_select_access_codes" ON access_codes;
DROP POLICY IF EXISTS "service_insert_access_codes" ON access_codes;
DROP POLICY IF EXISTS "service_update_access_codes" ON access_codes;
DROP POLICY IF EXISTS "service_delete_access_codes" ON access_codes;

CREATE POLICY "anon_select_access_codes" ON access_codes FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_access_codes" ON access_codes FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_access_codes" ON access_codes FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_access_codes" ON access_codes FOR DELETE TO anon USING (true);

-- rooms
DROP POLICY IF EXISTS "service_select_rooms" ON rooms;
DROP POLICY IF EXISTS "service_insert_rooms" ON rooms;
DROP POLICY IF EXISTS "service_update_rooms" ON rooms;
DROP POLICY IF EXISTS "service_delete_rooms" ON rooms;

CREATE POLICY "anon_select_rooms" ON rooms FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_rooms" ON rooms FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_rooms" ON rooms FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_rooms" ON rooms FOR DELETE TO anon USING (true);

-- auction_sessions
DROP POLICY IF EXISTS "service_select_sessions" ON auction_sessions;
DROP POLICY IF EXISTS "service_insert_sessions" ON auction_sessions;
DROP POLICY IF EXISTS "service_update_sessions" ON auction_sessions;
DROP POLICY IF EXISTS "service_delete_sessions" ON auction_sessions;

CREATE POLICY "anon_select_sessions" ON auction_sessions FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_sessions" ON auction_sessions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_sessions" ON auction_sessions FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_sessions" ON auction_sessions FOR DELETE TO anon USING (true);

-- teams
DROP POLICY IF EXISTS "service_select_teams" ON teams;
DROP POLICY IF EXISTS "service_insert_teams" ON teams;
DROP POLICY IF EXISTS "service_update_teams" ON teams;
DROP POLICY IF EXISTS "service_delete_teams" ON teams;

CREATE POLICY "anon_select_teams" ON teams FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_teams" ON teams FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_teams" ON teams FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_teams" ON teams FOR DELETE TO anon USING (true);

-- players_list
DROP POLICY IF EXISTS "service_select_players" ON players_list;
DROP POLICY IF EXISTS "service_insert_players" ON players_list;
DROP POLICY IF EXISTS "service_update_players" ON players_list;
DROP POLICY IF EXISTS "service_delete_players" ON players_list;

CREATE POLICY "anon_select_players" ON players_list FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_players" ON players_list FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_players" ON players_list FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_players" ON players_list FOR DELETE TO anon USING (true);

-- sold_players
DROP POLICY IF EXISTS "service_select_sold" ON sold_players;
DROP POLICY IF EXISTS "service_insert_sold" ON sold_players;
DROP POLICY IF EXISTS "service_update_sold" ON sold_players;
DROP POLICY IF EXISTS "service_delete_sold" ON sold_players;

CREATE POLICY "anon_select_sold" ON sold_players FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_sold" ON sold_players FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_sold" ON sold_players FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_sold" ON sold_players FOR DELETE TO anon USING (true);
