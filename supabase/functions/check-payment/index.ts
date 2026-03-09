import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";
import { ethers } from "https://esm.sh/ethers@6.13.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Base Mainnet RPC
const BASE_RPC_URL = Deno.env.get("BASE_RPC_URL") || "https://mainnet.base.org";
// Base USDC Contract
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

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

        const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
        if (authError || !user) throw new Error("Invalid token");

        const { sessionId } = await req.json();
        if (!sessionId) throw new Error("Missing sessionId");

        // 1. Fetch the pending session from Database
        const { data: session, error: sessionErr } = await supabaseAdmin
            .from('payment_sessions')
            .select('*')
            .eq('id', sessionId)
            .eq('user_id', user.id)
            .single();

        if (sessionErr || !session) throw new Error("Session not found");
        if (session.status === 'completed') {
            return new Response(JSON.stringify({ status: 'completed' }), { headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
        }

        // 2. Query the Blockchain via Ethers to check USDC balance of the deposit address
        const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
        const usdcAbi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];
        const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);

        const balanceWei = await usdcContract.balanceOf(session.deposit_address);
        const decimals = await usdcContract.decimals();
        const balance = Number(ethers.formatUnits(balanceWei, decimals));

        // 3. Did they send enough?
        if (balance >= session.expected_amount) {
            // They paid! Fulfill the order.

            // Mark session complete
            await supabaseAdmin.from('payment_sessions').update({ status: 'completed' }).eq('id', sessionId);

            // Grant items to user profile
            const { data: profile } = await supabaseAdmin.from('user_profiles').select('*').eq('id', user.id).single();
            let updates = {};

            if (session.purchase_type === 'pro') {
                updates = { is_pro: true, packs_unlocked: true };
            } else if (session.purchase_type === 'credits') {
                updates = { credits: (profile?.credits || 0) + 10 };
            } else if (session.purchase_type === 'packs') {
                updates = { packs_unlocked: true };
            }

            await supabaseAdmin.from('user_profiles').update(updates).eq('id', user.id);

            // 4. (Optional) Sweep funds here to Treasury Wallet using the decrypted private key.
            // Leaving sweeping out of this critical path to ensure the user gets their items instantly. 
            // A separate cron job can sweep all completed session wallets later.

            return new Response(JSON.stringify({ status: 'completed' }), { headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
        }

        // 5. Still waiting...
        return new Response(JSON.stringify({ status: 'pending', balance_found: balance }), { headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });

    } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 400,
            headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
        });
    }
});
