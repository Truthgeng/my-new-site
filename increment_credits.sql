-- Run this in your Supabase Dashboard → SQL Editor
-- It creates a safe atomic function to increment user credits

CREATE OR REPLACE FUNCTION increment_credits(
    p_user_id UUID,
    p_amount   INT,
    p_wallet   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER  -- runs with the privileges of the function owner (bypasses RLS safely)
AS $$
BEGIN
    UPDATE user_profiles
    SET
        credits        = credits + p_amount,
        wallet_address = COALESCE(p_wallet, wallet_address)
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User profile not found for id %', p_user_id;
    END IF;
END;
$$;

-- Grant execute permission to the service role (used by your Edge Function)
GRANT EXECUTE ON FUNCTION increment_credits(UUID, INT, TEXT) TO service_role;
