-- 1. Add referred_by to user_profiles
ALTER TABLE user_profiles 
ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES user_profiles(id);

-- 2. Create the trigger function to reward the referrer
CREATE OR REPLACE FUNCTION handle_new_referral()
RETURNS TRIGGER AS $$
BEGIN
  -- If this new user was referred by someone and they aren't referring themselves
  IF NEW.referred_by IS NOT NULL AND NEW.referred_by != NEW.id THEN
    -- Increment the referrer's credits by 1
    UPDATE user_profiles
    SET credits = COALESCE(credits, 0) + 1
    WHERE id = NEW.referred_by;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Attach the trigger to user_profiles
DROP TRIGGER IF EXISTS trg_handle_new_referral ON user_profiles;
CREATE TRIGGER trg_handle_new_referral
AFTER INSERT ON user_profiles
FOR EACH ROW
EXECUTE FUNCTION handle_new_referral();
