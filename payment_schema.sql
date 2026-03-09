-- 1. Create payment_sessions table for custodial checkout
create table public.payment_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  deposit_address text not null,
  encrypted_private_key text not null, -- Stored encrypted
  purchase_type text not null check (purchase_type in ('pro', 'credits', 'packs')),
  expected_amount numeric not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'expired')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  expires_at timestamp with time zone default timezone('utc'::text, now() + interval '1 hour') not null
);

-- Enable RLS for payment_sessions
alter table public.payment_sessions enable row level security;

-- Policies for payment_sessions
-- Users can view their own payment sessions
create policy "Users can view own payment sessions" on public.payment_sessions
  for select using (auth.uid() = user_id);

-- Only edge functions (service role) can insert or update Payment sessions to prevent cheating
create policy "Only service role can manage payment sessions" on public.payment_sessions
  for all using (current_setting('request.jwt.claims', true)::json->>'role' = 'service_role');
