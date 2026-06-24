CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_platform_settings" ON platform_settings FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_platform_settings" ON platform_settings FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_platform_settings" ON platform_settings FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_platform_settings" ON platform_settings FOR DELETE TO anon USING (false);
