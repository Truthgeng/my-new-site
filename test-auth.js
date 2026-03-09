import { createClient } from '@supabase/supabase-js'

const sbUrl = 'https://bqjvgsivwhnyjnzpglrd.supabase.co';
const sbKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxanZnc2l2d2hueWpuenBnbHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MTc3NTksImV4cCI6MjA4NzA5Mzc1OX0.NvRRo-vHoTpaeCWc53TgWFQmBKZq2qbrTdzIm_lDipA';

const sb = createClient(sbUrl, sbKey);

async function test() {
  console.log("Testing sign up...");
  const res = await sb.auth.signUp({ email: 'test12345@test.com', password: 'password123' });
  console.log(res);

  console.log("Testing sign in...");
  const res2 = await sb.auth.signInWithPassword({ email: 'test12345@test.com', password: 'password123' });
  console.log(res2);
}

test();
