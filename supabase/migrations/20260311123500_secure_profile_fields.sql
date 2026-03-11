-- Migration: Secure user_profiles billing columns against unauthorized client-side updates
-- This prevents users from manually giving themselves infinite credits or a pro tier via the browser console.

-- Create the trigger function
CREATE OR REPLACE FUNCTION public.protect_profile_fields()
RETURNS TRIGGER AS $$
BEGIN
  -- Only apply this protection to standard users (authenticated via JWT)
  IF auth.role() = 'authenticated' THEN
    
    -- Silently force the critical billing fields to remain unchanged from their old values
    -- The user cannot override these, no matter what they send in their UPDATE payload.
    NEW.credits = OLD.credits;
    NEW.tier = OLD.tier;
    NEW.pro_expires_at = OLD.pro_expires_at;
    NEW.total_pitches_generated = OLD.total_pitches_generated;
    
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop the trigger if it already exists to ensure idempotency
DROP TRIGGER IF EXISTS tr_protect_profile_fields ON public.user_profiles;

-- Attach the trigger to the user_profiles table
CREATE TRIGGER tr_protect_profile_fields
BEFORE UPDATE ON public.user_profiles
FOR EACH ROW
EXECUTE FUNCTION public.protect_profile_fields();
