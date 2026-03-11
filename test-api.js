const { createClient } = require('@supabase/supabase-js');

async function run() {
  const sb = createClient(
    'https://bqjvgsivwhnyjnzpglrd.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxanZnc2l2d2hueWpuenBnbHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MTc3NTksImV4cCI6MjA4NzA5Mzc1OX0.NvRRo-vHoTpaeCWc53TgWFQmBKZq2qbrTdzIm_lDipA'
  );

  console.log("Signing in as Admin...");
  const { data: { session }, error: signInErr } = await sb.auth.signInWithPassword({
    email: 'truth7824@gmail.com',
    password: 'password'
  });

  if (signInErr || !session) {
    console.log("SignIn err:", signInErr);
    return;
  }

  console.log("Got token length:", session.access_token.length);

  const adminClient = createClient(
    'https://bqjvgsivwhnyjnzpglrd.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxanZnc2l2d2hueWpuenBnbHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MTc3NTksImV4cCI6MjA4NzA5Mzc1OX0.NvRRo-vHoTpaeCWc53TgWFQmBKZq2qbrTdzIm_lDipA'
  );
  // Actually wait, the service role key wasn't in env. Let me just use the REST API manually from the front end's perspective since I don't have the secret locally.
  // We can't actually modify the db without the service key.

  console.log("Hitting Edge Function directly as Admin (Pro)...");
  try {
    const res = await fetch('https://bqjvgsivwhnyjnzpglrd.supabase.co/functions/v1/ai-proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        system: "Say hello",
        messages: [{ role: "user", content: "Hi" }]
      })
    });
    console.log("Status:", res.status);
    console.log("Response:", await res.text());
  } catch (err) {
    console.log("Fetch failed:", err);
  }
}

run().catch(console.error);
