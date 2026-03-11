-- Add a timestamp to track when credits were last reset for free users
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'credits_reset_at') THEN
    ALTER TABLE user_profiles ADD COLUMN credits_reset_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $$;

-- Update the increment_pitch_count RPC to:
-- 1. Auto-refresh credits if 24 hours have passed
-- 2. Only deduct once per 5-second window (prevents triple-deduction)
CREATE OR REPLACE FUNCTION increment_pitch_count(user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  profile_record user_profiles%ROWTYPE;
  current_credits INT;
  now_ts TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO profile_record FROM user_profiles WHERE id = user_id;
  
  IF NOT FOUND THEN RETURN; END IF;

  -- Auto-refresh credits every 24 hours for free users
  IF profile_record.tier != 'pro' AND (
    profile_record.credits_reset_at IS NULL OR 
    extract(epoch from (now_ts - profile_record.credits_reset_at)) > 86400
  ) THEN
    -- Reset to full 3 credits and mark the reset time
    UPDATE user_profiles SET 
      credits = 3,
      credits_reset_at = now_ts
    WHERE id = user_id;
    -- After reset, deduct 1 for the current pitch
    UPDATE user_profiles SET
      credits = 2,
      total_pitches_generated = COALESCE(profile_record.total_pitches_generated, 0) + 1,
      last_credit_deduction = now_ts
    WHERE id = user_id;
    RETURN;
  END IF;

  -- Guard: only deduct once per 5 seconds
  IF profile_record.last_credit_deduction IS NOT NULL AND
     extract(epoch from (now_ts - profile_record.last_credit_deduction)) < 5 THEN
    RETURN;
  END IF;

  -- Normal credit deduction
  UPDATE user_profiles SET
    credits = GREATEST(0, profile_record.credits - 1),
    total_pitches_generated = COALESCE(profile_record.total_pitches_generated, 0) + 1,
    last_credit_deduction = now_ts
  WHERE id = user_id;
END;
$$;
