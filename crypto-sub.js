/**
 * crypto-sub.js — Non-custodial payment execution for PitchProtocol
 *
 * Signs USDC transfers client-side and verifies via Edge Function.
 * Also handles admin code redemption and billing history.
 */

const BASE_RPC = 'https://mainnet.base.org';
const BASE_CHAIN_ID = 8453;
const USDC_DECIMALS = 6;

// Price map (raw USDC amounts with 6 decimals)
const PRICE_MAP = {
    subscription_pro: 5,
    credit_bundle_25: 5,
    credit_bundle_100: 12,
    niche_pack_web3_builder: 20,
    niche_pack_founder_cold_dm: 20
};

// ERC20 transfer function selector
const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

/* ── Main Payment Flow ── */

async function initiateNonCustodialPayment(type, amountUsdc) {
    if (!currentUser) return openAuthModal();

    // Check if user has a wallet
    const walletData = await loadEncryptedWallet(currentUser.id);
    if (!walletData) {
        // Store pending payment and trigger wallet setup
        window._pendingPaymentAfterWallet = { type, amount: amountUsdc };
        openWalletSetup();
        return;
    }

    // Show password prompt
    showPaymentPasswordPrompt(type, amountUsdc);
}

function showPaymentPasswordPrompt(type, amountUsdc) {
    const m = document.getElementById('pricingMsg');
    m.className = 'modal-msg';
    m.style.display = 'block';
    m.style.padding = '1.25rem';
    m.style.background = 'rgba(12, 17, 32, 0.8)';
    m.style.border = '1px solid var(--border)';
    m.style.textAlign = 'center';

    m.innerHTML = `
        <div style="font-size: 0.75rem; color: var(--muted); margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.1em;">Confirm Payment</div>
        <div style="font-size: 1.1rem; color: var(--white); font-weight: 700; margin-bottom: 1rem;">
            Send <span style="color:var(--accent)">${amountUsdc} USDC</span> on <span style="color:#0052ff; font-weight: 800;">Base</span>
        </div>
        <div style="font-size: 0.75rem; color: var(--muted); margin-bottom: 0.8rem;">Enter your wallet password to sign the transaction:</div>
        <input type="password" id="paymentPasswordInput" class="modal-input" placeholder="Wallet password" style="margin-bottom: 0.8rem; text-align: center;" onkeydown="if(event.key==='Enter')executePayment('${type}', ${amountUsdc})" />
        <div id="paymentError" style="color: #ef4444; font-size: 0.75rem; margin-bottom: 0.8rem; display: none;"></div>
        <button class="modal-submit" id="paymentExecuteBtn" onclick="executePayment('${type}', ${amountUsdc})">
            <span>Sign & Send →</span>
        </button>
        <div style="font-size: 0.6rem; color: var(--muted); margin-top: 0.75rem;">
            Your private key is decrypted only in-memory to sign this transaction.
        </div>
    `;

    // Focus the password input
    setTimeout(() => document.getElementById('paymentPasswordInput')?.focus(), 100);
}

async function executePayment(type, amountUsdc) {
    const password = document.getElementById('paymentPasswordInput').value;
    const errEl = document.getElementById('paymentError');
    const btn = document.getElementById('paymentExecuteBtn');

    if (!password) {
        errEl.textContent = 'Please enter your wallet password.';
        errEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    btn.querySelector('span').textContent = 'Decrypting key...';
    errEl.style.display = 'none';

    try {
        // 1. Load encrypted wallet
        const walletData = await loadEncryptedWallet(currentUser.id);
        if (!walletData) throw new Error('No wallet found. Please set up your wallet first.');

        // 2. Decrypt private key
        btn.querySelector('span').textContent = 'Signing transaction...';
        let privateKey;
        try {
            privateKey = await decryptPrivateKey(walletData.encrypted, walletData.salt, walletData.iv, password);
        } catch {
            throw new Error('Wrong password. Please try again.');
        }

        // 3. Build and send the transaction
        btn.querySelector('span').textContent = 'Broadcasting to Base...';
        const txHash = await sendUSDCPayment(privateKey, amountUsdc);

        // 4. Show tx hash and verify
        const m = document.getElementById('pricingMsg');
        m.innerHTML = `
            <div style="font-size: 0.75rem; color: var(--muted); margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.1em;">Transaction Sent</div>
            <div style="font-family: 'DM Mono', monospace; font-size: 0.7rem; color: var(--accent); word-break: break-all; margin-bottom: 1rem; cursor: pointer;"
                 onclick="navigator.clipboard.writeText('${txHash}'); this.style.color='#0f0'; setTimeout(()=>this.style.color='var(--accent)', 2000)">
                ${txHash}
                <br><span style="font-size: 0.55rem; color: var(--muted);">(Click to copy)</span>
            </div>
            <div style="display: flex; align-items: center; justify-content: center; gap: 0.6rem; font-size: 0.75rem; color: var(--muted);">
                <div class="spinner" style="display:block; width:12px; height:12px; border-top-color:var(--accent);"></div> Verifying on-chain...
            </div>
        `;

        // 5. Backend verification
        const result = await verifyPaymentOnBackend(txHash, type);

        m.style.background = 'rgba(96, 165, 250, 0.07)';
        m.innerHTML = `
            🎉 <b>Payment Confirmed!</b><br><br>
            Your account has been upgraded. Refreshing...
            <br><a href="https://basescan.org/tx/${txHash}" target="_blank" style="color:var(--accent); font-size: 0.7rem; margin-top: 0.5rem; display: inline-block;">View on BaseScan →</a>
        `;

        // Refresh
        await sb.auth.refreshSession();
        setTimeout(() => window.location.reload(), 3000);

    } catch (e) {
        console.error('Payment error:', e);
        errEl.textContent = e.message || 'Payment failed.';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Sign & Send →';
    }
}

/* ── USDC Transfer ── */

async function sendUSDCPayment(privateKey, amountUsdc) {
    const provider = new ethers.JsonRpcProvider(BASE_RPC, BASE_CHAIN_ID);
    const wallet = new ethers.Wallet(privateKey, provider);

    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_TRANSFER_ABI, wallet);
    const amountRaw = BigInt(amountUsdc) * BigInt(10 ** USDC_DECIMALS);

    const tx = await usdc.transfer(TREASURY_WALLET, amountRaw);
    return tx.hash;
}

/* ── Backend Verification ── */

async function verifyPaymentOnBackend(txHash, purchaseType) {
    const session = (await sb.auth.getSession()).data.session;
    if (!session?.access_token) throw new Error('Session expired. Please sign in again.');

    const res = await fetch(`${SUPABASE_URL}/functions/v1/verify-payment`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ txHash, purchaseType })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Verification failed (${res.status})`);
    return data;
}

/* ── Admin Code Redemption ── */

async function redeemAdminCode() {
    const input = document.getElementById('adminCodeInput');
    const code = input?.value?.trim();
    const msgEl = document.getElementById('adminCodeMsg');

    if (!code) {
        msgEl.textContent = 'Please enter a code.';
        msgEl.className = 'admin-code-msg error';
        msgEl.style.display = 'block';
        return;
    }

    const btn = document.getElementById('adminCodeBtn');
    btn.disabled = true;
    btn.textContent = 'Redeeming...';
    msgEl.style.display = 'none';

    try {
        const session = (await sb.auth.getSession()).data.session;
        if (!session?.access_token) throw new Error('Please sign in first.');

        const res = await fetch(`${SUPABASE_URL}/functions/v1/redeem-admin-code`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ code })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Redemption failed.');

        msgEl.textContent = `✅ Pro activated until ${new Date(data.pro_expires_at).toLocaleDateString()}!`;
        msgEl.className = 'admin-code-msg success';
        msgEl.style.display = 'block';
        input.value = '';

        // Refresh state
        isPro = true;
        userTier = 'pro';
        updateAuthUI();
        populateDashboardUI();

    } catch (e) {
        msgEl.textContent = e.message;
        msgEl.className = 'admin-code-msg error';
        msgEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Redeem';
    }
}

/* ── Billing History ── */

async function loadBillingHistory() {
    const container = document.getElementById('billingTableBody');
    if (!container) return;

    container.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--muted); padding:2rem;">Loading...</td></tr>';

    try {
        const { data, error } = await sb.from('subscription_payments')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        if (!data?.length) {
            container.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--muted); padding:2rem;">No payment history yet.</td></tr>';
            return;
        }

        container.innerHTML = data.map(p => {
            const amount = (parseInt(p.amount_raw) / 1e6).toFixed(2);
            const date = new Date(p.created_at).toLocaleDateString();
            const shortHash = p.tx_hash.slice(0, 8) + '...' + p.tx_hash.slice(-6);
            const statusClass = p.status === 'confirmed' ? 'status-confirmed' : 'status-pending';
            const statusText = p.status === 'confirmed' ? '✅ Confirmed' : '⏳ Pending';

            return `<tr>
                <td>${amount} USDC</td>
                <td class="tx-hash-cell">
                    <a href="https://basescan.org/tx/${p.tx_hash}" target="_blank" style="color:var(--accent);">${shortHash}</a>
                </td>
                <td>${date}</td>
                <td>${p.purchase_type.replace(/_/g, ' ')}</td>
                <td><span class="billing-status ${statusClass}">${statusText}</span></td>
            </tr>`;
        }).join('');

    } catch (e) {
        console.error('Failed to load billing history:', e);
        container.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#ef4444; padding:2rem;">Failed to load history.</td></tr>';
    }
}
