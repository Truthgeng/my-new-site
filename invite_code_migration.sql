-- ============================================================
-- PitchProtocol — Invite Code Migration
-- Run this in Supabase SQL Editor (after existing schema)
-- ============================================================

-- 1. Add pro_expires_at to user_profiles (if not already present)
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS pro_expires_at TIMESTAMPTZ;

-- 2. Ensure admin_codes table exists with correct structure
--    (this is safe to run even if table already exists)
CREATE TABLE IF NOT EXISTS admin_codes (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    code_hash    TEXT UNIQUE NOT NULL,        -- SHA-256 of the plaintext code
    duration_days INTEGER NOT NULL DEFAULT 30,
    created_by   UUID REFERENCES auth.users(id),
    used_by      UUID REFERENCES auth.users(id),
    used_at      TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ NOT NULL,        -- code redemption window (default 24h)
    created_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE admin_codes ENABLE ROW LEVEL SECURITY;

-- Only Edge Functions (service role) can touch admin_codes
DROP POLICY IF EXISTS "Service role only" ON admin_codes;
CREATE POLICY "Service role only"
    ON admin_codes FOR ALL
    USING (true)
    WITH CHECK (true);

-- 3. Remove unused wallet columns from user_profiles (optional cleanup)
-- ALTER TABLE user_profiles
--     DROP COLUMN IF EXISTS encrypted_private_key,
--     DROP COLUMN IF EXISTS key_salt;
