require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL || 'https://bqjvgsivwhnyjnzpglrd.supabase.co', process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxanZnc2l2d2hueWpuenBnbHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MTc3NTksImV4cCI6MjA4NzA5Mzc1OX0.NvRRo-vHoTpaeCWc53TgWFQmBKZq2qbrTdzIm_lDipA');

async function run() {
  const { data: { users }, error: authErr } = await sb.auth.admin?.listUsers() || { data: { users: [] } };
  
  // Since we don't have service role key in local script easily, let's just use anon key to call the RPC
  // Wait, RPC requires an authenticated user or service role.
  // We can just log in with a test user or just see if the RPC signature exists.
  const { data, error } = await sb.rpc('try_deduct_credit', { p_user_id: '00000000-0000-0000-0000-000000000000' });
  console.log('RPC Response:', { data, error });
}
run();
