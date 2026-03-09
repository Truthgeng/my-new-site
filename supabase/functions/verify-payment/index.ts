/**
 * PitchProtocol — verify-payment Edge Function
 *
 * Called after a user submits a crypto transaction.
 * Verifies the USDC transfer on-chain, then grants the purchased item.
 *
 * POST /functions/v1/verify-payment
 * Headers: Authorization: Bearer <supabase_user_jwt>
 * Body: { txHash: string, purchaseType: string }
 *
 * Environment secrets (set in Supabase Dashboard → Edge Functions → Secrets):
 *   SUPABASE_URL              — your project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (bypasses RLS)
 *   RPC_URL                   — Base or Polygon RPC (e.g. from Alchemy)
 *   TREASURY_WALLET           — your wallet address that receives USDC
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.5";

declare const Deno: { env: { get(key: string): string | undefined } };

// ── USDC contract (Base mainnet — change to Polygon address if using Polygon)
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 amount)",
];

// ── Pricing table (USDC, 2 decimal precision)
const PRICES: Record<string, number> = {
    subscription_pro: 5,
    credit_bundle_25: 5,
    credit_bundle_100: 12,
    niche_pack_web3_builder: 20,
    niche_pack_founder_cold_dm: 20,
};

const ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://www.pitchprotocolhq.xyz", // ← replace with your real domain
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

    // ── 1. Authenticate the caller via their Supabase JWT ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
        return json({ error: "Unauthorized" }, 401, origin);
    }
    const userJwt = authHeader.replace("Bearer ", "").trim();

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Admin client — bypasses RLS so we can safely update the user record
    const adminDb = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false },
    });

    // Auth client — used only to verify the JWT and get the real user ID
    const authClient = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser(userJwt);

    if (authError || !user) {
        return json({ error: "Invalid or expired session. Please sign in again." }, 401, origin);
    }

    // ── 2. Parse request body ──
    let body: { txHash?: string; purchaseType?: string };
    try {
        body = await req.json();
    } catch {
        return json({ error: "Invalid JSON body" }, 400, origin);
    }

    const { txHash, purchaseType } = body;
    if (!txHash || !purchaseType) {
        return json({ error: "Missing txHash or purchaseType" }, 400, origin);
    }
    if (!PRICES[purchaseType]) {
        return json({ error: `Unknown purchase type: ${purchaseType}` }, 400, origin);
    }

    // ── 3. Replay-attack prevention — reject already-processed transactions ──
    const { data: existingTx } = await adminDb
        .from("crypto_transactions")
        .select("hash")
        .eq("hash", txHash)
        .single();

    if (existingTx) {
        return json({ error: "Transaction already processed." }, 409, origin);
    }

    // ── 4. Verify on-chain ──
    const rpcUrl = Deno.env.get("RPC_URL");
    const treasuryWallet = Deno.env.get("TREASURY_WALLET");

    if (!rpcUrl || !treasuryWallet) {
        console.error("Missing RPC_URL or TREASURY_WALLET env var");
        return json({ error: "Payment service not configured" }, 500, origin);
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);

    let receipt: ethers.TransactionReceipt | null;
    let tx: ethers.TransactionResponse | null;
    try {
        [receipt, tx] = await Promise.all([
            provider.getTransactionReceipt(txHash),
            provider.getTransaction(txHash),
        ]);
    } catch (e) {
        console.error("RPC error:", e);
        return json({ error: "Could not fetch transaction from the blockchain. Try again." }, 502, origin);
    }

    if (!receipt || receipt.status !== 1) {
        return json({ error: "Transaction not confirmed or failed on-chain." }, 400, origin);
    }
    if (!tx || tx.to?.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
        return json({ error: "Transaction was not sent to the USDC contract." }, 400, origin);
    }

    // ── 5. Parse USDC Transfer event to confirm funds went to our treasury ──
    const usdcInterface = new ethers.Interface(USDC_ABI);
    let transferEvent: ethers.LogDescription | null = null;
    let senderWallet = "";

    for (const log of receipt.logs) {
        try {
            const parsed = usdcInterface.parseLog(log);
            if (
                parsed?.name === "Transfer" &&
                parsed.args.to.toLowerCase() === treasuryWallet.toLowerCase()
            ) {
                transferEvent = parsed;
                senderWallet = parsed.args.from;
                break;
            }
        } catch { /* log doesn't match USDC ABI — skip */ }
    }

    if (!transferEvent) {
        return json({ error: "No USDC transfer to treasury found in this transaction." }, 400, origin);
    }

    // USDC has 6 decimals
    const amountPaid = parseFloat(ethers.formatUnits(transferEvent.args.amount, 6));
    const expectedAmount = PRICES[purchaseType];

    // Allow up to $0.01 rounding tolerance
    if (amountPaid < expectedAmount - 0.01) {
        return json({
            error: `Insufficient payment. Expected ${expectedAmount} USDC, received ${amountPaid.toFixed(6)} USDC.`,
        }, 400, origin);
    }

    // ── 6. Log the transaction ──
    const { error: logError } = await adminDb.from("crypto_transactions").insert({
        hash: txHash,
        user_id: user.id,
        wallet_from: senderWallet,
        amount_usdc: amountPaid,
        tx_type: purchaseType,
    });

    if (logError) {
        console.error("Failed to log tx:", logError);
        // Non-fatal — continue with fulfillment
    }

    // ── 7. Fulfill the purchase ──
    const fulfillError = await fulfill(adminDb, user.id, purchaseType, senderWallet, txHash);
    if (fulfillError) {
        return json({ error: `Payment verified but fulfillment failed: ${fulfillError}` }, 500, origin);
    }

    return json({ success: true, purchaseType, amountPaid }, 200, origin);
});

// ── Fulfillment logic ──
async function fulfill(
    db: ReturnType<typeof createClient>,
    userId: string,
    purchaseType: string,
    senderWallet: string,
    txHash: string,
): Promise<string | null> {
    if (purchaseType === "subscription_pro") {
        const newExpiry = new Date();
        newExpiry.setMonth(newExpiry.getMonth() + 1);

        const { error } = await db.from("user_profiles").update({
            tier: "pro",
            pro_expires_at: newExpiry.toISOString(),
            wallet_address: senderWallet,
        }).eq("id", userId);
        return error?.message ?? null;

    } else if (purchaseType === "credit_bundle_25" || purchaseType === "credit_bundle_100") {
        const creditsToAdd = purchaseType === "credit_bundle_25" ? 25 : 100;

        // Use a Postgres function to atomically increment credits (avoids race conditions)
        const { error } = await db.rpc("increment_credits", {
            p_user_id: userId,
            p_amount: creditsToAdd,
            p_wallet: senderWallet,
        });

        if (error) {
            // Fallback: fetch current credits and add manually
            const { data: profile } = await db
                .from("user_profiles")
                .select("credits")
                .eq("id", userId)
                .single();
            const currentCredits = profile?.credits ?? 0;
            const { error: updateError } = await db.from("user_profiles").update({
                credits: currentCredits + creditsToAdd,
                wallet_address: senderWallet,
            }).eq("id", userId);
            return updateError?.message ?? null;
        }
        return null;

    } else if (purchaseType.startsWith("niche_pack_")) {
        const packName = purchaseType.replace("niche_pack_", "");
        const { error } = await db.from("user_niche_packs").insert({
            user_id: userId,
            pack_name: packName,
            transaction_hash: txHash,
        });
        return error?.message ?? null;
    }

    return `Unknown purchaseType: ${purchaseType}`;
}

// ── Response helper ──
function json(body: object, status: number, origin: string | null): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
}
