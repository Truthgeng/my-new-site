import { createClient } from '@supabase/supabase-js'

const sbUrl = 'https://bqjvgsivwhnyjnzpglrd.supabase.co';
const sbKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxanZnc2l2d2hueWpuenBnbHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MTc3NTksImV4cCI6MjA4NzA5Mzc1OX0.NvRRo-vHoTpaeCWc53TgWFQmBKZq2qbrTdzIm_lDipA';

const sb = createClient(sbUrl, sbKey);

async function test() {
  const email = 'user_' + Date.now() + '@example.com';
  console.log("Testing sign up with:", email);
  const res = await sb.auth.signUp({ email, password: 'password123' });
  console.log("Signup res:", res.data, res.error);

  console.log("Testing sign in...");
  const res2 = await sb.auth.signInWithPassword({ email, password: 'password123' });
  console.log("Signin res:", res2.data.user ? "Success" : "Failed", res2.error);
}

test();
