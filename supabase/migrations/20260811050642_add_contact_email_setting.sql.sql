
INSERT INTO platform_settings (key, value, updated_at)
VALUES ('contact_email', 'draftarenaofficial@gmail.com', now())
ON CONFLICT (key) DO NOTHING;
