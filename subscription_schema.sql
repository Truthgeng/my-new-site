-- ============================================================
-- PitchProtocol — Non-Custodial Subscription Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Subscription Payments table
CREATE TABLE IF NOT EXISTS subscription_payments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    wallet_address TEXT NOT NULL,
    tx_hash TEXT UNIQUE NOT NULL,
    chain_id INTEGER NOT NULL DEFAULT 8453,
    amount_raw TEXT NOT NULL,           -- raw uint256 string (e.g. "5000000")
    purchase_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | rejected
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: users can only read their own payments
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own payments"
    ON subscription_payments FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Service role can insert payments"
    ON subscription_payments FOR INSERT
    WITH CHECK (true);   -- Edge Function uses service_role key

-- 2. Admin Codes table
CREATE TABLE IF NOT EXISTS admin_codes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    code_hash TEXT UNIQUE NOT NULL,       -- SHA-256 of the plaintext code
    duration_days INTEGER NOT NULL DEFAULT 30,
    created_by UUID REFERENCES auth.users(id),
    used_by UUID REFERENCES auth.users(id),
    used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,      -- code itself expires (not the sub)
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE admin_codes ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write admin_codes (Edge Functions)
CREATE POLICY "Service role only"
    ON admin_codes FOR ALL
    USING (true)
    WITH CHECK (true);

-- 3. Add wallet columns to user_profiles
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS encrypted_private_key TEXT,
    ADD COLUMN IF NOT EXISTS key_salt TEXT;
