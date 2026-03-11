-- Create the missing increment_pitch_count RPC that the currently live ai-proxy is tying to call
CREATE OR REPLACE FUNCTION increment_pitch_count(user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE user_profiles
  SET 
    credits = GREATEST(0, credits - 1),
    total_pitches_generated = total_pitches_generated + 1
  WHERE id = user_id;
END;
$$;
