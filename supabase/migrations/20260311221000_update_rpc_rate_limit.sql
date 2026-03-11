CREATE OR REPLACE FUNCTION increment_pitch_count(user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  last_ts TIMESTAMPTZ;
BEGIN
  -- Get the last update timestamp
  SELECT last_name_update INTO last_ts FROM user_profiles WHERE id = user_id;
  
  -- If we haven't deducted a credit in the last 10 seconds, do it.
  -- (We are hijacking the last_name_update column temporarily or we can just use a session variable if we could, but a new column is safer).
  -- Actually, let's just add a dedicated column 'last_credit_deduction'
  BEGIN
    ALTER TABLE user_profiles ADD COLUMN last_credit_deduction TIMESTAMPTZ DEFAULT (now() - interval '1 day');
  EXCEPTION WHEN duplicate_column THEN
    NULL;
  END;

  SELECT last_credit_deduction INTO last_ts FROM user_profiles WHERE id = user_id;

  IF last_ts IS NULL OR extract(epoch from (now() - last_ts)) > 5 THEN
    UPDATE user_profiles
    SET 
      credits = GREATEST(0, credits - 1),
      total_pitches_generated = COALESCE(total_pitches_generated, 0) + 1,
      last_credit_deduction = now()
    WHERE id = user_id;
  END IF;
END;
$$;
