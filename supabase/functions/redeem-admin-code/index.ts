/**
 * redeem-admin-code — validates and redeems a Pro activation code
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

        const { code } = await req.json();
        if (!code || typeof code !== "string") {
            return json({ error: "Invalid code" }, 400, origin);
        }

        // SHA-256 hash the submitted code
        const hashBuf = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(code.trim())
        );
        const codeHash = Array.from(new Uint8Array(hashBuf))
            .map(b => b.toString(16).padStart(2, "0")).join("");

        // Look up
        const { data: codeRow, error: lookupErr } = await db
            .from("admin_codes")
            .select("*")
            .eq("code_hash", codeHash)
            .single();

        if (lookupErr || !codeRow) {
            return json({ error: "Invalid or unknown code." }, 404, origin);
        }

        if (codeRow.used_by) {
            return json({ error: "This code has already been used." }, 400, origin);
        }

        if (new Date(codeRow.expires_at) < new Date()) {
            return json({ error: "This code has expired." }, 400, origin);
        }

        // Mark as used
        const { error: updateErr } = await db
            .from("admin_codes")
            .update({ used_by: user.id, used_at: new Date().toISOString() })
            .eq("id", codeRow.id);

        if (updateErr) return json({ error: updateErr.message }, 500, origin);

        // Apply Pro subscription
        const proExpiresAt = new Date(
            Date.now() + codeRow.duration_days * 24 * 60 * 60 * 1000
        ).toISOString();

        const { error: profileErr } = await db
            .from("user_profiles")
            .update({
                tier: "pro",
                pro_expires_at: proExpiresAt,
            })
            .eq("id", user.id);

        if (profileErr) return json({ error: profileErr.message }, 500, origin);

        return json({
            success: true,
            pro_expires_at: proExpiresAt,
            duration_days: codeRow.duration_days,
        }, 200, origin);

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
