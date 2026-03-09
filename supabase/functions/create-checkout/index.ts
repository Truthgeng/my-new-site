import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";
import { ethers } from "https://esm.sh/ethers@6.13.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Allowed origins
const ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:55835",
    "http://127.0.0.1:3000",
    "https://www.pitchprotocolhq.xyz"
];

function corsHeaders(origin: string | null) {
    const isAllowed = origin && (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+-[a-z0-9]+-[a-z0-9]+\.vercel\.app$/.test(origin));
    const allowed = isAllowed ? origin : ALLOWED_ORIGINS[0];
    return {
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
}

serve(async (req: Request) => {
    const origin = req.headers.get("origin");

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) throw new Error("Missing Authorization header");

        // 1. Initialize Supabase Admin Client
        const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        // 2. Validate the user Session
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
        if (authError || !user) throw new Error("Invalid Authorization token");

        // 3. Parse Request Body
        const { purchaseType } = await req.json();

        let expectedAmount = 0;
        if (purchaseType === 'pro') expectedAmount = 5;
        else if (purchaseType === 'credits') expectedAmount = 3;
        else if (purchaseType === 'packs') expectedAmount = 10;
        else throw new Error("Invalid purchaseType");

        // 4. Generate new custodial Wallet
        const wallet = ethers.Wallet.createRandom();

        // Ensure private key is encrypted before storing (in production use Supabase Vault, here we use base64 for MVP simplicity)
        const encryptedPk = btoa(wallet.privateKey);

        // 5. Save to payment_sessions
        const { data: session, error: dbError } = await supabaseAdmin
            .from('payment_sessions')
            .insert({
                user_id: user.id,
                deposit_address: wallet.address,
                encrypted_private_key: encryptedPk,
                purchase_type: purchaseType,
                expected_amount: expectedAmount,
                status: 'pending'
            })
            .select('*')
            .single();

        if (dbError) throw dbError;

        // 6. Return the deposit address to the client
        return new Response(
            JSON.stringify({ deposit_address: wallet.address, expected_amount: expectedAmount, session_id: session.id }),
            { headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );

    } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 400,
            headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
        });
    }
});
