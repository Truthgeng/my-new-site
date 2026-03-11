const { createClient } = require('@supabase/supabase-js');
async function run() {
  const sb = createClient(
    'https://bqjvgsivwhnyjnzpglrd.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxanZnc2l2d2hueWpuenBnbHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MTc3NTksImV4cCI6MjA4NzA5Mzc1OX0.NvRRo-vHoTpaeCWc53TgWFQmBKZq2qbrTdzIm_lDipA'
  );
  
  const { data: { session }, error: signInErr } = await sb.auth.signInWithPassword({
    email: 'truth7824@gmail.com',
    password: 'password'
  });
  
  if (signInErr) {
    console.error("Login failed:", signInErr.message);
    return;
  }
  
  console.log("Logged in:", session.user.id);
  const { data, error } = await sb.rpc('increment_pitch_count', { user_id: session.user.id });
  console.log("RPC Error:", error);
  console.log("RPC Data:", data);
}
run();
