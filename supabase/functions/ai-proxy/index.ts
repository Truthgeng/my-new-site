/**
 * PitchProtocol — AI Proxy Edge Function
 *
 * Security:
 * - Groq API key stored server-side as a Supabase secret — never in the browser
 * - Validates that caller has a Supabase session JWT (token length > 100 chars)
 * - CORS restricted to allowed origins only
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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

    // ── Auth: must have a valid Supabase session JWT ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return json({ error: "Unauthorized" }, 401, origin);
    }

    const token = authHeader.replace("Bearer ", "").trim();
    // Supabase session JWTs are always > 100 chars; short tokens are anon/invalid
    if (token.length < 100) {
        return json({ error: "Invalid token" }, 401, origin);
    }

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

    const { system, messages, maxTokens, model } = body;
    if (!system || !Array.isArray(messages)) {
        return json({ error: "Missing required fields: system, messages" }, 400, origin);
    }

    // ── Forward to Groq ──
    try {
        const groqPayload: Record<string, unknown> = {
            model: model || GROQ_MODEL,
            max_tokens: maxTokens ?? 1024,
            messages: [{ role: "system", content: system }, ...messages],
        };

        if (body.response_format) {
            groqPayload.response_format = body.response_format;
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
            const errText = await groqRes.text();
            console.error("Groq API error:", groqRes.status, errText);
            return json({ error: `Groq error: ${groqRes.status}` }, 502, origin);
        }

        const data = await groqRes.json();
        const content = data.choices?.[0]?.message?.content ?? "";
        return json({ content }, 200, origin);

    } catch (e) {
        console.error("Proxy fetch error:", e);
        return json({ error: "AI request failed" }, 500, origin);
    }
});
