/**
 * generate-admin-code — creates a one-time Pro activation code
 * Only callable by allowlisted admin emails.
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAILS = ["truth7824@gmail.com"];

function corsHeaders(origin: string | null) {
    const isAllowed =
        origin &&
        (
            origin.startsWith("http://localhost") ||
            origin.startsWith("http://127.0.0.1") ||
            origin === "https://www.pitchprotocolhq.xyz" ||
            origin === "https://pitchprotocolhq.xyz" ||
            /^https:\/\/[a-z0-9-]+-[a-z0-9]+-[a-z0-9]+\.vercel\.app$/.test(origin)
        );
    const allowed = isAllowed ? origin : "https://www.pitchprotocolhq.xyz";
    return {
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
}

serve(async (req) => {
    const origin = req.headers.get("origin");
    const headers = corsHeaders(origin);

    if (req.method === "OPTIONS") {
        return new Response("ok", { headers });
    }

    try {
        // Authenticate
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) return json({ error: "Missing auth" }, 401, origin);

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const db = createClient(supabaseUrl, serviceKey);

        // Verify JWT
        const { data: { user }, error: authErr } = await createClient(
            supabaseUrl,
            Deno.env.get("SUPABASE_ANON_KEY")!
        ).auth.getUser(authHeader.replace("Bearer ", ""));

        if (authErr || !user) return json({ error: "Unauthorized" }, 401, origin);
        if (!ADMIN_EMAILS.includes(user.email || "")) {
            return json({ error: "Admin only" }, 403, origin);
        }

        const { durationDays } = await req.json();
        const duration = durationDays || 30;

        // Generate 8-char code
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
        const rnd = new Uint8Array(8);
        crypto.getRandomValues(rnd);
        const code = Array.from(rnd).map(b => chars[b % chars.length]).join("");

        // SHA-256 hash
        const hashBuf = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(code)
        );
        const codeHash = Array.from(new Uint8Array(hashBuf))
            .map(b => b.toString(16).padStart(2, "0")).join("");

        // Store (expires in 7 days — plenty of time to share and redeem)
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        const { error: insertErr } = await db.from("admin_codes").insert({
            code_hash: codeHash,
            duration_days: duration,
            created_by: user.id,
            expires_at: expiresAt,
        });

        if (insertErr) return json({ error: insertErr.message }, 500, origin);

        return json({ code, expires_at: expiresAt, duration_days: duration }, 200, origin);

    } catch (e) {
        return json({ error: e.message }, 500, origin);
    }
});

function json(body: object, status: number, origin: string | null) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...corsHeaders(origin),
            "Content-Type": "application/json",
        },
    });
}
