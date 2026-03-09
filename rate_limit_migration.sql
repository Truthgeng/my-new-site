-- ============================================================
-- PitchProtocol — Rate Limiting Migration
-- Run in Supabase SQL Editor
-- ============================================================

-- Add daily pitch count tracking to user_profiles
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS daily_pitch_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS daily_reset_at TIMESTAMPTZ DEFAULT now();

-- Reset all counts (clean slate)
UPDATE user_profiles SET daily_pitch_count = 0, daily_reset_at = now();
