-- Fix 1: Initialize credits_reset_at for all existing users who have NULL
-- (Set it to now() so they get a fresh 24h window from today)
UPDATE user_profiles 
SET credits_reset_at = now()
WHERE credits_reset_at IS NULL AND tier != 'pro';

-- Fix 2: Rewrite increment_pitch_count with correct 24-hour logic
-- KEY FIX: credits_reset_at IS NULL now means "use current credits, just initialize timer"
-- It NEVER resets credits just because the timestamp is null.
CREATE OR REPLACE FUNCTION increment_pitch_count(user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  profile_record user_profiles%ROWTYPE;
  now_ts TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO profile_record FROM user_profiles WHERE id = user_id;
  
  IF NOT FOUND THEN RETURN; END IF;

  -- Skip if Pro user (unlimited pitches)
  IF profile_record.tier = 'pro' THEN RETURN; END IF;

  -- Guard: only deduct once per 5 seconds (prevents triple-deduction from parallel calls)
  IF profile_record.last_credit_deduction IS NOT NULL AND
     extract(epoch from (now_ts - profile_record.last_credit_deduction)) < 5 THEN
    RETURN;
  END IF;

  -- Auto-refresh credits ONLY if credits_reset_at is set AND 24 hours have genuinely passed
  IF profile_record.credits_reset_at IS NOT NULL AND
     extract(epoch from (now_ts - profile_record.credits_reset_at)) > 86400 THEN
    -- Genuine 24-hour refresh: restore to 3 credits and deduct 1 for this pitch
    UPDATE user_profiles SET 
      credits = 2,
      credits_reset_at = now_ts,
      total_pitches_generated = COALESCE(total_pitches_generated, 0) + 1,
      last_credit_deduction = now_ts
    WHERE id = user_id;
    RETURN;
  END IF;

  -- Normal case: just deduct 1 credit (floor at 0)
  UPDATE user_profiles SET
    credits = GREATEST(0, profile_record.credits - 1),
    credits_reset_at = COALESCE(profile_record.credits_reset_at, now_ts),
    total_pitches_generated = COALESCE(total_pitches_generated, 0) + 1,
    last_credit_deduction = now_ts
  WHERE id = user_id;
END;
$$;
