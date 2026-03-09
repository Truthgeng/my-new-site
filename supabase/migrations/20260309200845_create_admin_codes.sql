-- Create admin_codes table for invite code generation and redemption
CREATE TABLE IF NOT EXISTS admin_codes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    code_hash TEXT UNIQUE NOT NULL,       -- SHA-256 of the plaintext code
    duration_days INTEGER NOT NULL DEFAULT 30,
    created_by UUID REFERENCES auth.users(id),
    used_by UUID REFERENCES auth.users(id),
    used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE admin_codes ENABLE ROW LEVEL SECURITY;

-- Only service role (Edge Functions) can read/write admin_codes
DROP POLICY IF EXISTS "Service role only" ON admin_codes;
CREATE POLICY "Service role only"
    ON admin_codes FOR ALL
    USING (true)
    WITH CHECK (true);
