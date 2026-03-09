import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION ---
// In a real app, these are in your .env file
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!; // Must use service role to bypass RLS for credit updates
const RPC_URL = process.env.POLYGON_RPC_URL!; // Example: Using Polygon/Base for lower fees
const RECEIVER_WALLET = process.env.OUR_TREASURY_WALLET!;

// Standard ERC20 ABI for Transfer events (USDC)
const USDC_ABI = [
    "event Transfer(address indexed from, address indexed to, uint amount)",
    "function transfer(address to, uint amount) returns (bool)"
];
const USDC_ADDRESS = "0x...USDC_CONTRACT_ADDRESS..."; // e.g., Base USDC address

// Initialize Supabase Admin Client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Initialize Ethers Provider
const provider = new ethers.JsonRpcProvider(RPC_URL);

/**
 * 1. PAYWALL GATING & CREDIT USAGE
 * Called right before generating a pitch to verify access.
 */
export async function consumePitchCredit(userId: string): Promise<{ allowed: boolean; reason?: string; isPro: boolean }> {
    const { data: user, error } = await supabase
        .from('user_profiles')
        .select('tier, pro_expires_at, credits')
        .eq('id', userId)
        .single();

    if (error || !user) throw new Error("User not found");

    const now = new Date();
    const isPro = user.tier === 'pro' && user.pro_expires_at && new Date(user.pro_expires_at) > now;

    // Pro Subscription: Unlimited generations
    if (isPro) {
        return { allowed: true, isPro: true };
    }

    // Free / Credit Tier: Deduct a credit
    if (user.credits > 0) {
        // Deduct 1 credit
        await supabase
            .from('user_profiles')
            .update({ credits: user.credits - 1, total_pitches_generated: user.total_pitches_generated + 1 })
            .eq('id', userId);

        return { allowed: true, isPro: false };
    }

    return { allowed: false, reason: "Insufficient credits. Please upgrade to Pro or purchase credits.", isPro: false };
}

/**
 * 2. CRYPTO PAYMENT VERIFICATION
 * Typically called via an API endpoint after the client submits a transaction hash.
 */
export async function verifyCryptoPayment(
    userId: string,
    txHash: string,
    purchaseType: 'subscription_pro' | 'credit_bundle_25' | 'credit_bundle_100' | 'niche_pack_web3'
) {
    // Check if tx is already processed to prevent replay attacks
    const { data: existingTx } = await supabase
        .from('crypto_transactions')
        .select('hash')
        .eq('hash', txHash)
        .single();

    if (existingTx) throw new Error("Transaction already processed");

    // Fetch transaction and receipt from the blockchain
    const receipt = await provider.getTransactionReceipt(txHash);
    const tx = await provider.getTransaction(txHash);

    if (!receipt || receipt.status !== 1) throw new Error("Transaction failed or pending");
    if (!tx || tx.to?.toLowerCase() !== USDC_ADDRESS.toLowerCase()) throw new Error("Invalid contract destination");

    // Parse USDC Transfer Event
    const contract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    let transferEvent;

    for (const log of receipt.logs) {
        try {
            const parsedLog = contract.interface.parseLog(log);
            if (parsedLog?.name === 'Transfer' && parsedLog.args.to.toLowerCase() === RECEIVER_WALLET.toLowerCase()) {
                transferEvent = parsedLog;
                break;
            }
        } catch (e) { /* ignore non-matching logs */ }
    }

    if (!transferEvent) throw new Error("No valid USDC transfer to treasury found");

    // Convert amount from 6 decimals (USDC standard)
    const amountPaid = ethers.formatUnits(transferEvent.args.amount, 6);
    const senderWallet = transferEvent.args.from;

    // Validate amount based on product pricing
    await validatePricingAndFulfill(userId, txHash, senderWallet, Number(amountPaid), purchaseType);
}

/**
 * 3. TIER MANAGEMENT & FULFILLMENT
 * Grants the respective items based on the verified payment.
 */
async function validatePricingAndFulfill(userId: string, txHash: string, senderWallet: string, amountPaid: number, purchaseType: string) {
    let expectedAmount = 0;

    // Retrieve user to check if they have Pro discount for packs
    const { data: user } = await supabase.from('user_profiles').select('tier, credits').eq('id', userId).single();
    const isPro = user?.tier === 'pro';

    // Define pricing logic
    if (purchaseType === 'subscription_pro') {
        expectedAmount = 15; // e.g., 15 USDC / month
    } else if (purchaseType === 'credit_bundle_25') {
        expectedAmount = 5; // 5 USDC
    } else if (purchaseType === 'credit_bundle_100') {
        expectedAmount = 12; // 12 USDC
    } else if (purchaseType.startsWith('niche_pack_')) {
        const basePrice = 20; // 20 USDC
        expectedAmount = isPro ? basePrice * 0.8 : basePrice; // 20% discount for Pro
    }

    if (amountPaid < expectedAmount) {
        throw new Error(`Insufficient payment. Expected ${expectedAmount}, received ${amountPaid}`);
    }

    // --- FULFILLMENT ---

    // A. Log Transaction
    await supabase.from('crypto_transactions').insert({
        hash: txHash,
        user_id: userId,
        wallet_from: senderWallet,
        amount_usdc: amountPaid,
        tx_type: purchaseType
    });

    // B. Grant Items
    if (purchaseType === 'subscription_pro') {
        // Add 30 days to expiry (or set from now if expired)
        const newExpiry = new Date();
        newExpiry.setMonth(newExpiry.getMonth() + 1);

        await supabase.from('user_profiles').update({
            tier: 'pro',
            pro_expires_at: newExpiry.toISOString(),
            wallet_address: senderWallet // Associate wallet
        }).eq('id', userId);

    } else if (purchaseType.startsWith('credit_bundle_')) {
        const creditsToAdd = purchaseType === 'credit_bundle_25' ? 25 : 100;
        await supabase.from('user_profiles').update({
            credits: (user?.credits || 0) + creditsToAdd,
            wallet_address: senderWallet
        }).eq('id', userId);

    } else if (purchaseType.startsWith('niche_pack_')) {
        const packName = purchaseType.replace('niche_pack_', '');
        await supabase.from('user_niche_packs').insert({
            user_id: userId,
            pack_name: packName,
            transaction_hash: txHash
        });
    }
}

/**
 * 4. PITCH HISTORY & ADVANCED ACCESS CONTROL
 * Saves history only if the user is allowed to.
 */
export async function savePitchHistory(userId: string, targetProject: string, pitchText: string, usedTemplate: string) {
    // Check tier
    const { data: user } = await supabase.from('user_profiles').select('tier').eq('id', userId).single();

    if (user?.tier !== 'pro') {
        throw new Error("History saving requires a Pro subscription.");
    }

    await supabase.from('pitch_history').insert({
        user_id: userId,
        target_project: targetProject,
        pitch_text: pitchText,
        used_template: usedTemplate
    });
}

/**
 * Helper: Get User Permitted Templates
 * Determines which templates the user can access based on base tier and purchased niche packs.
 */
export async function getAvailableTemplates(userId: string) {
    const templates = ['basic_intro', 'basic_followup'];

    const { data: user } = await supabase.from('user_profiles').select('tier').eq('id', userId).single();

    if (user?.tier === 'pro') {
        templates.push('pro_networking', 'pro_investor_pitch', 'advanced_bd');
    }

    // Check custom niche packs
    const { data: packs } = await supabase.from('user_niche_packs').select('pack_name').eq('user_id', userId);
    packs?.forEach(p => {
        if (p.pack_name === 'web3_builder') templates.push('defi_partnership', 'tokenomics_advisor');
        if (p.pack_name === 'founder_cold_dm') templates.push('founder_to_founder', 'raise_announcement');
    });

    return templates;
}
