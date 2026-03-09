-- SUPABASE SCHEMA FOR CRYPTO MONETIZATION

-- 1. Users Extension Table 
-- This table links to the authenticated Supabase user and stores their monetization state
CREATE TABLE public.user_profiles (
    id UUID REFERENCES auth.users(id) PRIMARY KEY,
    wallet_address VARCHAR(42) UNIQUE, -- Associated crypto wallet
    tier VARCHAR(20) DEFAULT 'free', -- 'free' or 'pro'
    pro_expires_at TIMESTAMP WITH TIME ZONE, -- When the monthly crypto sub expires
    credits INTEGER DEFAULT 3, -- Starts with 3 free credits
    total_pitches_generated INTEGER DEFAULT 0,
    full_name VARCHAR(100),
    avatar_url TEXT,
    last_name_update TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. User Niche Packs
-- Tracks which premium niche packs a user has unlocked via one-time crypto payment
CREATE TABLE public.user_niche_packs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.user_profiles(id) NOT NULL,
    pack_name VARCHAR(50) NOT NULL, -- e.g., 'web3_builder', 'community_strategist', 'founder_cold_dm'
    purchased_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    transaction_hash VARCHAR(66) UNIQUE NOT NULL, -- TxHash of the crypto payment
    UNIQUE(user_id, pack_name)
);

-- 3. Crypto Transactions Log
-- Records all verified payments to prevent replay attacks and maintain an audit trail
CREATE TABLE public.crypto_transactions (
    hash VARCHAR(66) PRIMARY KEY, -- The on-chain transaction hash
    user_id UUID REFERENCES public.user_profiles(id) NOT NULL,
    wallet_from VARCHAR(42) NOT NULL,
    amount_usdc NUMERIC NOT NULL, -- Amount paid in USDC
    tx_type VARCHAR(30) NOT NULL, -- 'subscription_pro', 'credit_bundle_25', 'niche_pack_web3'
    status VARCHAR(20) DEFAULT 'verified',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Pitch History (Requires Pro or valid credits)
CREATE TABLE public.pitch_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.user_profiles(id) NOT NULL,
    target_project VARCHAR(255),
    pitch_text TEXT NOT NULL,
    tone VARCHAR(50) DEFAULT 'standard',
    used_template VARCHAR(50) DEFAULT 'basic',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- RLS (Row Level Security) Policies Example for User Profiles
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile" 
    ON public.user_profiles FOR SELECT 
    USING (auth.uid() = id);

-- Allow users to update their own profile (Full Name and Avatar)
CREATE POLICY "Users can update their own profile" 
    ON public.user_profiles FOR UPDATE 
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- Allow users to insert their own profile on first login
CREATE POLICY "Users can insert their own profile" 
    ON public.user_profiles FOR INSERT 
    WITH CHECK (auth.uid() = id);

-- Only a secure backend process (Service Role) should update sensitive fields (credits, tier)
-- Note: In a production app, you should use separate policies or columns to prevent users
-- from manually increasing their own credits via the update policy above.
CREATE POLICY "Service role manages profiles"
    ON public.user_profiles FOR ALL
    USING (auth.role() = 'service_role');

-- STORAGE POLICIES (Run these in Supabase SQL editor)
-- Note: These apply to the 'avatars' bucket
/*
CREATE POLICY "Public Access" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');

CREATE POLICY "Authenticated users can upload avatars" ON storage.objects FOR INSERT 
WITH CHECK (bucket_id = 'avatars' AND auth.role() = 'authenticated');
*/
