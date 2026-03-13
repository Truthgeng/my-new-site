-- Fix: Handle NULL credits gracefully in try_deduct_credit
-- A new user profile might have NULL credits, which means they have their full 3 credits available.
-- Attempting to do `credits = credits - 1` when `credits` is NULL yields NULL.
CREATE OR REPLACE FUNCTION try_deduct_credit(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec user_profiles%ROWTYPE;
  now_ts TIMESTAMPTZ := now();
  current_credits INT;
BEGIN
  -- Lock the row for this transaction to prevent race conditions
  SELECT * INTO rec FROM user_profiles WHERE id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;

  -- Pro users always pass
  IF rec.tier = 'pro' THEN RETURN true; END IF;

  -- Treat NULL credits as 3 (full allocation for new users)
  current_credits := COALESCE(rec.credits, 3);

  -- Check if 24 hours have passed since last reset → restore credits
  IF rec.credits_reset_at IS NOT NULL AND
     extract(epoch from (now_ts - rec.credits_reset_at)) > 86400 THEN
    UPDATE user_profiles SET
      credits = 2,  -- Reset to 3, then immediately deduct 1 for this pitch
      credits_reset_at = now_ts,
      total_pitches_generated = COALESCE(total_pitches_generated, 0) + 1,
      last_credit_deduction = now_ts
    WHERE id = p_user_id;
    RETURN true;
  END IF;

  -- Guard against rapid parallel calls (5-second window)
  IF rec.last_credit_deduction IS NOT NULL AND
     extract(epoch from (now_ts - rec.last_credit_deduction)) < 5 THEN
    -- It's a parallel duplicate call for the same pitch
    IF current_credits > 0 THEN RETURN true; END IF;
    RETURN false;
  END IF;

  -- No credits left → reject
  IF current_credits <= 0 THEN RETURN false; END IF;

  -- Deduct 1 credit atomically
  UPDATE user_profiles SET
    credits = current_credits - 1,
    credits_reset_at = COALESCE(credits_reset_at, now_ts),
    total_pitches_generated = COALESCE(total_pitches_generated, 0) + 1,
    last_credit_deduction = now_ts
  WHERE id = p_user_id;

  RETURN true;
END;
$$;
