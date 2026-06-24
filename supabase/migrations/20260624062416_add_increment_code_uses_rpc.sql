
CREATE OR REPLACE FUNCTION increment_code_uses(p_code TEXT)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE access_codes SET uses_count = uses_count + 1 WHERE code = p_code;
$$;
