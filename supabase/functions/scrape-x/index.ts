/**
 * PitchProtocol — scrape-x Edge Function
 *
 * Fetches a real X (Twitter) profile bio server-side.
 * Server-side Deno requests with proper browser headers bypass X's JS-gate
 * that blocks all browser-based scrapers.
 *
 * POST /functions/v1/scrape-x
 * Body:    { handle: string }
 * Returns: { bio: string, name: string, followersText: string } | { error: string }
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

declare const Deno: { env: { get(key: string): string | undefined } };

const ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "https://www.pitchprotocolhq.xyz",
];

function corsHeaders(origin: string | null) {
    const isAllowed =
        origin &&
        (ALLOWED_ORIGINS.includes(origin) ||
            /^https:\/\/[a-z0-9-]+-[a-z0-9]+-[a-z0-9]+\.vercel\.app$/.test(origin));
    const allowed = isAllowed ? origin : ALLOWED_ORIGINS[0];
    return {
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
}

// Real browser UA so X doesn't serve a JS-only shell
const BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

serve(async (req: Request) => {
    const origin = req.headers.get("origin");

    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
        });
    }

    // Auth check — same pattern as ai-proxy
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
        });
    }
    const token = authHeader.replace("Bearer ", "").trim();
    if (token.length < 100) {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
            status: 401,
            headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
        });
    }

    let body: { handle?: string };
    try {
        body = await req.json();
    } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
        });
    }

    const handle = body.handle?.replace(/^@/, "").trim();
    if (!handle) {
        return new Response(JSON.stringify({ error: "Missing handle" }), {
            status: 400,
            headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
        });
    }

    let bio = "";
    let name = "";
    let followersText = "";

    // ── Strategy 1: Twitter oEmbed API (public, no auth, very reliable) ──
    // Returns the display name and basic info for any public account.
    try {
        const oembedUrl = `https://publish.twitter.com/oembed?url=https://twitter.com/${handle}&omit_script=true`;
        const res = await fetch(oembedUrl, {
            headers: { "User-Agent": BROWSER_UA },
            signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
            const data = await res.json();
            // author_name from oEmbed is the display name of the account
            if (data.author_name) {
                name = data.author_name;
                console.log("[scrape-x] oEmbed name OK:", name);
            }
        }
    } catch (e) {
        console.warn("[scrape-x] oEmbed failed:", (e as Error).message);
    }

    // ── Strategy 2: Fetch X profile page server-side with full browser headers ──
    // Deno's fetch with proper headers often gets the real HTML before JS hydration.
    try {
        const profileUrl = `https://x.com/${handle}`;
        const res = await fetch(profileUrl, {
            headers: {
                "User-Agent": BROWSER_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1",
                "Upgrade-Insecure-Requests": "1",
            },
            signal: AbortSignal.timeout(8000),
        });

        if (res.ok) {
            const html = await res.text();

            // Try to extract bio from meta tags (present in static HTML before JS kicks in)
            const metaDescMatch = html.match(/<meta\s+(?:name|property)="description"\s+content="([^"]{10,500})"/i)
                || html.match(/<meta\s+content="([^"]{10,500})"\s+(?:name|property)="description"/i);

            if (metaDescMatch?.[1]) {
                const raw = metaDescMatch[1]
                    .replace(/&#39;/g, "'")
                    .replace(/&amp;/g, "&")
                    .replace(/&quot;/g, '"')
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .trim();

                // Filter out X's generic JS-block messages
                const isJunk = raw.toLowerCase().includes("javascript is not available")
                    || raw.toLowerCase().includes("sign in to x")
                    || raw.toLowerCase().includes("sign up for x")
                    || raw.toLowerCase().includes("sign in to twitter")
                    || raw.length < 20;

                if (!isJunk) {
                    bio = raw;
                    console.log("[scrape-x] Meta description bio OK:", bio.slice(0, 80));
                }
            }

            // Try to extract name from <title> tag if oEmbed didn't get it
            if (!name) {
                const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
                if (titleMatch?.[1]) {
                    // Title is usually "Name (@handle) / X" — extract the real name
                    const titleText = titleMatch[1].replace(/\s*\/\s*X\s*$/, "").replace(/\s*on X\s*$/, "").trim();
                    const nameFromTitle = titleText.replace(/\s*\(@[^)]+\)\s*$/, "").trim();
                    if (nameFromTitle && !nameFromTitle.toLowerCase().includes("javascript")) {
                        name = nameFromTitle;
                    }
                }
            }

            // Try to extract follower count
            const followersMatch = html.match(/(\d[\d,\.]+[KMB]?)\s*Followers/i);
            if (followersMatch?.[1]) {
                followersText = followersMatch[1] + " followers";
            }
        }
    } catch (e) {
        console.warn("[scrape-x] Direct fetch failed:", (e as Error).message);
    }

    // ── Strategy 3: Try mobile Twitter URL (lighter page, more parseable) ──
    if (!bio) {
        try {
            const mobileUrl = `https://mobile.twitter.com/${handle}`;
            const res = await fetch(mobileUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                },
                signal: AbortSignal.timeout(8000),
            });

            if (res.ok) {
                const html = await res.text();
                const metaMatch = html.match(/<meta\s+(?:name|property)="description"\s+content="([^"]{10,500})"/i)
                    || html.match(/<meta\s+content="([^"]{10,500})"\s+(?:name|property)="description"/i);

                if (metaMatch?.[1]) {
                    const raw = metaMatch[1]
                        .replace(/&#39;/g, "'")
                        .replace(/&amp;/g, "&")
                        .replace(/&quot;/g, '"')
                        .trim();

                    const isJunk = raw.toLowerCase().includes("javascript")
                        || raw.toLowerCase().includes("sign in")
                        || raw.length < 20;

                    if (!isJunk) {
                        bio = raw;
                        console.log("[scrape-x] Mobile bio OK:", bio.slice(0, 80));
                    }
                }
            }
        } catch (e) {
            console.warn("[scrape-x] Mobile fetch failed:", (e as Error).message);
        }
    }

    console.log(`[scrape-x] Final result for @${handle} - name: "${name}", bio: "${bio.slice(0, 60)}"`);

    return new Response(
        JSON.stringify({ bio, name, followersText }),
        {
            status: 200,
            headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
        }
    );
});
