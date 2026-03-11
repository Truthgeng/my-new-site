/**
 * PitchProtocol — AI Proxy Edge Function
 *
 * Security:
 * - Groq API key stored server-side as a Supabase secret — never in the browser
 * - Validates that caller has a Supabase session JWT (token length > 100 chars)
 * - CORS restricted to allowed origins only
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: { env: { get(key: string): string | undefined } };

const GROQ_MODEL = "llama-3.1-8b-instant";
const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";

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
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
}

function json(body: object, status: number, origin: string | null) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
}

serve(async (req: Request) => {
    const origin = req.headers.get("origin");

    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (req.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, origin);
    }

    // ── Auth: manually verify the JWT since API Gateway verification is disabled ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return json({ error: "Unauthorized" }, 401, origin);
    }

    const token = authHeader.replace("Bearer ", "").trim();
    if (token.length < 100) {
        return json({ error: "Invalid token" }, 401, origin);
    }

    // Validate JWT signature and expiration
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const sbClient = createClient(supabaseUrl, anonKey);
    const { data: { user }, error: authErr } = await sbClient.auth.getUser(token);

    if (authErr || !user) {
        return json({ error: "Invalid JWT" }, 401, origin);
    }

    // ── Enforce Billing Rules via Service Role ──
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(supabaseUrl, serviceKey);

    const { data: profile, error: profileErr } = await db
        .from("user_profiles")
        .select("tier, credits, pro_expires_at")
        .eq("id", user.id)
        .single();

    if (profileErr || !profile) {
        return json({ error: "Profile not found" }, 500, origin);
    }

    const isPro = profile.tier === "pro" && new Date(profile.pro_expires_at) > new Date();

    // ── Groq key (server-side only in Supabase secrets) ──
    const groqKey = Deno.env.get("GROQ_KEY");
    if (!groqKey) {
        console.error("GROQ_KEY secret not set");
        return json({ error: "AI service not configured" }, 500, origin);
    }

    // ── Parse body ──
    let body: { system?: string; messages?: unknown[]; maxTokens?: number; model?: string; response_format?: unknown };
    try {
        body = await req.json();
    } catch {
        return json({ error: "Invalid JSON body" }, 400, origin);
    }

    const { system, messages, maxTokens, model, costCredit } = body as { system?: string; messages?: unknown[]; maxTokens?: number; model?: string; response_format?: unknown; costCredit?: boolean };
    if (!system || !Array.isArray(messages)) {
        return json({ error: "Missing required fields: system, messages" }, 400, origin);
    }

    // ── Credit Gate: only charge when explicitly requested (i.e., pitch generation, not detect/snapshot/chat) ──
    let creditDeducted = false;
    if (costCredit && !isPro) {
        const { data: allowed, error: deductErr } = await db.rpc('try_deduct_credit', { p_user_id: user.id });
        if (deductErr) {
            console.error("Credit RPC error:", deductErr);
            return json({ error: "Server error checking credits. Please try again." }, 500, origin);
        }
        if (!allowed) {
            return json({ error: "Out of credits" }, 403, origin);
        }
        creditDeducted = true;
    }

    // Helper to refund credit if AI synthesis fails
    const refundCreditIfDeducted = async () => {
        if (creditDeducted) {
            try {
                const { data: curr } = await db.from("user_profiles").select("credits").eq("id", user.id).single();
                if (curr) {
                    await db.from("user_profiles").update({ credits: curr.credits + 1 }).eq("id", user.id);
                }
            } catch (err) {
                console.error("Failed to refund credit:", err);
            }
        }
    };

    // ── Forward to Groq ──
    try {
        let bodyPayload = body as any;
        const groqPayload: Record<string, unknown> = {
            model: model || GROQ_MODEL,
            max_tokens: maxTokens ?? 1024,
            messages: [{ role: "system", content: system }, ...messages],
        };

        if (bodyPayload.response_format) {
            groqPayload.response_format = bodyPayload.response_format;
        }

        const groqRes = await fetch(GROQ_API, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${groqKey}`,
            },
            body: JSON.stringify(groqPayload),
        });

        if (!groqRes.ok) {
            await refundCreditIfDeducted();
            const errText = await groqRes.text();
            console.error("Groq API error:", groqRes.status, errText);
            return json({ error: `Groq error: ${groqRes.status}` }, 502, origin);
        }

        const data = await groqRes.json();
        const content = data.choices?.[0]?.message?.content ?? "";

        return json({ content }, 200, origin);

    } catch (e) {
        await refundCreditIfDeducted();
        console.error("Proxy fetch error:", e);
        return json({ error: "AI request failed" }, 500, origin);
    }
});
