-- Backfill credit refresh for existing users
-- This sets credits back to 3 for any user who:
--   1. Has a depleted credit count (< 3)
--   2. Has never had credits_reset_at set (old accounts before the migration)
-- Safe to run multiple times (WHERE clause prevents overwriting active users)

UPDATE user_profiles
SET 
    credits = 3,
    credits_reset_at = NOW()
WHERE 
    credits_reset_at IS NULL   -- only old accounts that never had the timer set
    AND tier != 'pro';          -- don't touch pro accounts

-- Also ensure credits_reset_at column exists (run this if migration wasn't applied)
-- ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS credits_reset_at TIMESTAMPTZ;
