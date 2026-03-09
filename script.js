/* ── Supabase ── */


const sb = supabase.createClient(
    'https://bqjvgsivwhnyjnzpglrd.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxanZnc2l2d2hueWpuenBnbHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MTc3NTksImV4cCI6MjA4NzA5Mzc1OX0.NvRRo-vHoTpaeCWc53TgWFQmBKZq2qbrTdzIm_lDipA',
    {
        auth: {
            detectSessionInUrl: true,
            persistSession: true,
            autoRefreshToken: true,
            // Wallet extensions (SES lockdown) remove navigator.locks.
            // This custom lock function bypasses it to prevent 10s timeouts.
            lock: async (_name, _acquireTimeout, fn) => await fn()
        }
    }
);


/* ── AI Config ── */
// All AI calls go through the Supabase Edge Function (ai-proxy).
// The Groq API key is stored server-side only as a Supabase secret — never in the browser.
const SUPABASE_URL = 'https://bqjvgsivwhnyjnzpglrd.supabase.co';
const AI_PROXY_URL = `${SUPABASE_URL}/functions/v1/ai-proxy`;

/**
 * callAI — routes requests securely through the Supabase Edge Function API proxy.
 * If the proxy fails (e.g., rate limits or function downtime), it falls back to
 * a direct API call using the local dev key to keep the app functional.
 */
async function callAI(system, messages, maxTokens, modelOverride = null, isJson = false) {
    if (!currentUser) throw new Error("Must be logged in to use AI features.");

    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error("No active session found.");

    const aiPayload = {
        system,
        messages,
        maxTokens: maxTokens || 1024,
        model: modelOverride
    };

    if (isJson) {
        aiPayload.response_format = { type: "json_object" };
    }

    try {
        let res = await fetch(AI_PROXY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify(aiPayload)
        });

        // If the token expired right before the call, refresh it instantly and retry once
        if (res.status === 401) {
            const { data: { session: newSession }, error: refreshErr } = await sb.auth.refreshSession();
            if (refreshErr || !newSession?.access_token) throw new Error("Session expired. Please sign in again.");

            res = await fetch(AI_PROXY_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${newSession.access_token}`
                },
                body: JSON.stringify(aiPayload)
            });
        }

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            if (res.status === 429) throw new Error('Daily pitch limit reached. Upgrade to Pro for unlimited pitches.');
            throw new Error(errData.error || `AI service error (${res.status}). Please try again.`);
        }

        const data = await res.json();
        return data.content || '';
    } catch (e) {
        throw e;
    }
}


/* ── State ── */
let currentUser = null;
let currentSessionId = null;
let chatHistory = [];
let pitchContext = '';
let currentMode = 'hire';
let userTier = 'free';
let userCredits = 3;
let isPro = false;
let proExpiresAt = null;
let userFullName = '';
let userAvatarUrl = null;
let userNameLastUpdated = null;


/* ── Mode Toggle ── */
function setMode(mode) {
    currentMode = mode;
    const isBD = mode === 'bd';
    document.getElementById('modeToggle').classList.toggle('bd', isBD);
    document.getElementById('btnHire').classList.toggle('active', !isBD);
    document.getElementById('btnBD').classList.toggle('active', isBD);
    document.getElementById('hiredFields').classList.toggle('hidden', isBD);
    document.getElementById('bdFields').classList.toggle('active', isBD);
    document.getElementById('mainHeadline').innerHTML = isBD
        ? 'Make them<br><em>say yes.</em>'
        : 'Make them<br><em>need you.</em>';
    document.getElementById('mainSub').textContent = isBD
        ? "Describe your project, drop the target project's link and tell us what you know about them. Get a BD pitch that highlights exactly what you bring to the table — and leaves the door open."
        : "Paste any Web3 project's X account. Tell us your niche. Get a pitch that makes them want to bring you on — not just another DM they ignore.";
    document.getElementById('btnText').textContent = isBD ? 'Generate BD Pitch →' : 'Generate Pitch →';
    clearOutputs();
}

function clearOutputs(hideRoadmap = true) {
    document.getElementById('outputWrap').style.display = 'none';
    if (hideRoadmap) document.getElementById('followupWrap').style.display = 'none';
    document.getElementById('snapshotWrap').style.display = 'none';
    const od = document.getElementById('outputDivider');
    if (od) od.style.display = 'none';
    document.getElementById('pitchContent').innerHTML = '';
    // Only reset the roadmap spinner if it was actively shown during a generation
    if (hideRoadmap) {
        document.getElementById('stepsContainer').innerHTML = '<div class="steps-loading"><div class="steps-spinner"></div>Building your roadmap...</div>';
    }
    document.getElementById('chatContextBadge').classList.remove('active');
    pitchContext = '';
    hideError();
}

/* ── Auth & Profile ── */
// Supabase handles the OAuth callback automatically via detectSessionInUrl: true.
// We just listen for auth state changes and update the UI accordingly.

let profileLoadPromise = null;
let lastLoadedUserId = null;

sb.auth.onAuthStateChange(async (event, session) => {
    console.log("Auth State Changed:", event, session?.user?.email);

    // On successful OAuth sign-in, clean the URL and close the modal
    if (event === 'SIGNED_IN') {
        if (window.location.search.includes('code') || window.location.hash.includes('access_token')) {
            // Delay URL cleanup slightly so Supabase has time to finish parsing and saving
            setTimeout(() => {
                window.history.replaceState({}, document.title, window.location.pathname);
            }, 500);
        }
        closeAuthModal();
    }

    currentUser = session?.user || null;

    try {
        if (currentUser) {
            // Check if we are already loading or just loaded this user to debounce rapid events
            if (lastLoadedUserId === currentUser.id && profileLoadPromise) {
                console.log("[Auth] Debouncing duplicate profile load for:", currentUser.id);
            } else {
                console.log("Loading profile for:", currentUser.id, "event:", event);
                lastLoadedUserId = currentUser.id;

                profileLoadPromise = (async () => {
                    // 1. First simply try to fetch the profile
                    let { data: finalProfile, error: fetchError } = await sb
                        .from('user_profiles')
                        .select('*')
                        .eq('id', currentUser.id)
                        .single();

                    // 2. If it doesn't exist (PGRST116), create it cleanly
                    if (fetchError && fetchError.code === 'PGRST116') {
                        console.log("[Auth] Profile not found, creating new profile...");
                        const { data: newProfile, error: insertError } = await sb
                            .from('user_profiles')
                            .insert([{ id: currentUser.id }])
                            .select()
                            .single();

                        if (insertError) {
                            console.error("[Auth] Failed to create profile:", insertError);
                        } else {
                            finalProfile = newProfile;
                        }
                    } else if (fetchError) {
                        console.error("[Auth] Error fetching profile:", fetchError);
                    }

                    if (finalProfile) {
                        userTier = finalProfile.tier || 'free';
                        userCredits = finalProfile.credits ?? 3;
                        proExpiresAt = finalProfile.pro_expires_at || null;
                        isPro = userTier === 'pro' && proExpiresAt && new Date(proExpiresAt) > new Date();
                        userFullName = finalProfile.full_name || '';
                        userAvatarUrl = finalProfile.avatar_url || null;
                        userNameLastUpdated = finalProfile.last_name_update || null;
                    } else {
                        userTier = 'free';
                        userCredits = 3;
                        isPro = false;
                        userFullName = '';
                        userAvatarUrl = null;
                        userNameLastUpdated = null;
                    }

                    // Admin override (always applied regardless of DB profile)
                    if (currentUser.email === 'truth7824@gmail.com') {
                        userTier = 'pro';
                        isPro = true;
                        userCredits = 999999;
                    }

                    try { await loadHistory(); } catch (e) { console.warn("loadHistory failed", e); }

                    // Profile data loaded asynchronously: Update the UI!
                    updateAuthUI();
                })();
            }
        } else {
            lastLoadedUserId = null;
            userTier = 'free'; userCredits = 0; isPro = false; proExpiresAt = null;
            userFullName = ''; userAvatarUrl = null; userNameLastUpdated = null;
            const chatIndicator = document.getElementById('chatSaveIndicator');
            if (chatIndicator) chatIndicator.classList.remove('visible');
            if (typeof renderHistoryEmpty === 'function') renderHistoryEmpty();
        }

        updateAuthUI();
    } catch (e) {
        console.error("Critical error in auth handler:", e);
        updateAuthUI(); // Still update UI even if profile load failed
    }
}); function updateAuthUI() {
    const area = document.getElementById('authArea');
    const walletArea = document.getElementById('walletArea');
    const creditBadge = document.getElementById('creditBadge');

    if (currentUser) {
        walletArea.style.display = 'flex';
        creditBadge.textContent = isPro ? 'PRO ACTIVE' : `${userCredits} Credits`;
        creditBadge.style.color = isPro ? 'var(--acid)' : 'var(--muted)';
        creditBadge.style.borderColor = isPro ? 'var(--acid)' : 'var(--border)';

        // Hide the Upgrade button in the header for Pro users
        const headerUpgradeBtn = walletArea.querySelector('.auth-btn');
        if (headerUpgradeBtn) headerUpgradeBtn.style.display = isPro ? 'none' : '';
        let avatarHtml;
        if (userAvatarUrl) {
            avatarHtml = `<img src="${userAvatarUrl}" class="user-avatar-img" />`;
        } else {
            const initials = (userFullName || currentUser.email || 'U').substring(0, 2).toUpperCase();
            avatarHtml = `<button class="user-avatar" onclick="toggleDropdown()">${initials}</button>`;
        }

        const wrapClass = userAvatarUrl ? 'user-avatar-trigger' : 'user-avatar';
        const displayEmail = userFullName || currentUser.email || '';

        area.innerHTML = `
      <div class="user-menu">
        <button class="${userAvatarUrl ? 'user-avatar-img-btn' : 'user-avatar'}" onclick="toggleDropdown()">
            ${userAvatarUrl ? `<img src="${userAvatarUrl}" class="user-avatar-img" />` : (userFullName || currentUser.email || 'U').substring(0, 2).toUpperCase()}
        </button>
        <div class="user-dropdown" id="userDropdown">
          <div class="user-dropdown-header"><div class="user-email">${escHtml(displayEmail)}</div></div>
          <button class="dropdown-item" onclick="openDashboard(); switchDashboardTab('profile'); closeDropdown()">⚙️ Dashboard Overview</button>
          <button class="dropdown-item" onclick="startNewSession();closeDropdown()">✦ New Pitch Session</button>
          <button class="dropdown-item danger" onclick="handleSignOut()">↩ Sign Out</button>
        </div>
      </div>`;

        // Admin / Pro Niche Pack Override
        if (currentUser.email === 'truth7824@gmail.com' || isPro) {
            const btnWeb3 = document.getElementById('btnNicheWeb3');
            const btnFounder = document.getElementById('btnNicheFounder');
            const statusText = isPro ? 'Activated (Pro Included)' : 'Activated (Admin)';
            if (btnWeb3 && btnFounder) {
                btnWeb3.innerHTML = `<span>${statusText}</span>`;
                btnWeb3.onclick = () => { showPricingMsg('success', btnWeb3.innerText); setTimeout(closePricingModal, 1500) };
                btnFounder.innerHTML = `<span>${statusText}</span>`;
                btnFounder.onclick = () => { showPricingMsg('success', btnFounder.innerText); setTimeout(closePricingModal, 1500) };
            }
        }
    } else {
        walletArea.style.display = 'none';
        area.innerHTML = `<button class="auth-btn" onclick="openAuthModal()">Sign In</button>`;
    }
}

function toggleDropdown() { document.getElementById('userDropdown')?.classList.toggle('open'); }
function closeDropdown() { document.getElementById('userDropdown')?.classList.remove('open'); }
document.addEventListener('click', e => { if (!e.target.closest('.user-menu')) closeDropdown(); });

function openAuthModal() { document.getElementById('authModal').classList.add('open'); }
function openAuthModalToSignUp() {
    document.getElementById('authModal').classList.add('open');
    switchTab('signup');
    showModalMsg('signupMsg', 'info', 'Create a free account to generate your pitch.');
}
function closeAuthModal() { document.getElementById('authModal').classList.remove('open'); clearMsgs(); }

function switchTab(tab) {
    document.getElementById('tabSignIn').classList.toggle('active', tab === 'signin');
    document.getElementById('tabSignUp').classList.toggle('active', tab === 'signup');
    document.getElementById('formSignIn').classList.toggle('hidden', tab !== 'signin');
    document.getElementById('formSignUp').classList.toggle('hidden', tab !== 'signup');
    clearMsgs();
}

function clearMsgs() {
    ['signinMsg', 'signupMsg'].forEach(id => {
        const e = document.getElementById(id); e.style.display = 'none'; e.className = 'modal-msg';
    });
}

function showModalMsg(id, type, text) {
    const e = document.getElementById(id); e.textContent = text; e.className = `modal-msg ${type}`; e.style.display = 'block';
}

async function handleSignIn() {
    const email = document.getElementById('signinEmail').value.trim();
    const pw = document.getElementById('signinPassword').value;
    console.log("[Auth] Attempting Sign In for:", email);
    if (!email || !pw) return showModalMsg('signinMsg', 'error', 'Please fill in all fields.');
    const btn = document.getElementById('signinBtn');
    btn.disabled = true; btn.querySelector('span').textContent = 'Signing in...';
    try {
        console.log("[Auth] Calling sb.auth.signInWithPassword...");
        const result = await sb.auth.signInWithPassword({ email, password: pw });
        console.log("[Auth] signInWithPassword response:", result);
        const { error, data } = result;
        if (error) {
            console.error("[Auth] Sign In API Error:", error);
            throw error;
        }
        console.log("[Auth] Sign In Successful, session data:", data);
        closeAuthModal();
    } catch (e) {
        showModalMsg('signinMsg', 'error', e.message || 'Error signing in.');
    } finally {
        btn.disabled = false; btn.querySelector('span').textContent = 'Sign In →';
    }
}

async function handleSignUp() {
    const email = document.getElementById('signupEmail').value.trim();
    const pw = document.getElementById('signupPassword').value;
    console.log("[Auth] Attempting Sign Up for:", email);
    if (!email || !pw) return showModalMsg('signupMsg', 'error', 'Please fill in all fields.');
    if (pw.length < 6) return showModalMsg('signupMsg', 'error', 'Password must be at least 6 characters.');
    const btn = document.getElementById('signupBtn');
    btn.disabled = true; btn.querySelector('span').textContent = 'Creating...';
    try {
        const redirectTo = window.location.origin + (window.location.pathname === '/' ? '' : window.location.pathname);
        const { error } = await sb.auth.signUp({
            email,
            password: pw,
            options: { emailRedirectTo: redirectTo }
        });
        if (error) {
            console.error("[Auth] Sign Up Error:", error);
            throw error;
        }
        console.log("[Auth] Sign Up Request Sent - confirmation email dispatched");
        showModalMsg('signupMsg', 'success', 'Almost there! Check your inbox and click the confirmation link to activate your account.');
    } catch (e) {
        console.error("[Auth] Catch block Sign Up Error:", e);
        let msg = e.message || 'Error creating account.';
        if (e.status === 429) msg = 'Too many signup attempts. Please try again later or use Google Sign-in.';
        showModalMsg('signupMsg', 'error', msg);
    } finally {
        btn.disabled = false; btn.querySelector('span').textContent = 'Create Account ->';
    }
}

async function handleGoogleAuth(btn) {
    console.log("[Auth] Starting Google OAuth flow...");
    // Use the exact current page URL (no query params / hash) as the redirect destination
    // This must match one of the URLs registered in Supabase Dashboard → Auth → URL Configuration
    const redirectTo = window.location.origin + (window.location.pathname === '/' ? '' : window.location.pathname);
    console.log("[Auth] Redirect URL:", redirectTo);
    if (btn) { btn.textContent = 'Redirecting...'; btn.disabled = true; }
    try {
        console.log("[Auth] Calling sb.auth.signInWithOAuth for Google...");
        const result = await sb.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: redirectTo,
                queryParams: { prompt: 'select_account' }
            }
        });
        console.log("[Auth] signInWithOAuth call returned:", result);
        const { error, data } = result;
        if (error) {
            console.error("[Auth] Google OAuth Error:", error);
            throw error;
        }
        if (data && data.url) {
            console.log("[Auth] Redirecting to Google:", data.url);
            window.location.href = data.url;
        } else {
            console.warn("[Auth] No redirect URL returned from Supabase.");
        }
    } catch (e) {
        console.error("[Auth] Catch block Google Error:", e);
        // Restore the Google button with its SVG icon
        if (btn) {
            btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-google" /></svg> Continue with Google`;
            btn.disabled = false;
        }
        showModalMsg('signinMsg', 'error', e.message || 'Google Auth Error. Check your Supabase Redirect URL settings.');
        showModalMsg('signupMsg', 'error', e.message || 'Google Auth Error. Check your Supabase Redirect URL settings.');
    }
}

function copyTemplate(textareaId, btn) {
    const text = document.getElementById(textareaId).value;
    navigator.clipboard.writeText(text).then(() => {
        const original = btn.textContent.trim();
        btn.textContent = '✓ Copied!';
        btn.style.color = 'var(--acid)';
        btn.style.borderColor = 'var(--acid)';
        setTimeout(() => {
            btn.textContent = original;
            btn.style.color = '';
            btn.style.borderColor = '';
        }, 2000);
    });
}

async function handleSignOut() {
    await sb.auth.signOut();
    // Close everything and go back to homepage
    document.getElementById('dashboardModal').classList.remove('open');
    window.location.href = window.location.origin + window.location.pathname;
}

/* ── Pricing ── */
function openPricingModal() {
    if (!currentUser) return openAuthModal();
    document.getElementById('pricingModal').classList.add('open');
}
function closePricingModal() { document.getElementById('pricingModal').classList.remove('open'); }
function showPricingMsg(type, text) {
    const m = document.getElementById('pricingMsg');
    m.textContent = text; m.className = `modal-msg ${type}`; m.style.display = 'block';
}

/* ── Invite Code Redemption ── */
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
        const { data: { session }, error: sessionError } = await sb.auth.getSession();
        if (sessionError || !session) throw new Error('Please sign in first.');

        let res = await fetch(`${SUPABASE_URL}/functions/v1/redeem-admin-code`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ code })
        });

        if (res.status === 401) {
            const { data: { session: newSession }, error: refreshErr } = await sb.auth.refreshSession();
            if (refreshErr || !newSession?.access_token) throw new Error("Session expired. Please sign in again.");

            res = await fetch(`${SUPABASE_URL}/functions/v1/redeem-admin-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${newSession.access_token}`
                },
                body: JSON.stringify({ code })
            });
        }

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Redemption failed.');

        const until = new Date(data.pro_expires_at).toLocaleDateString();
        msgEl.textContent = `✅ Pro activated until ${until}!`;
        msgEl.className = 'admin-code-msg success';
        msgEl.style.display = 'block';
        input.value = '';

        // Update local state immediately
        isPro = true;
        userTier = 'pro';
        proExpiresAt = data.pro_expires_at;
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

async function generateInviteCode() {
    const btn = document.getElementById('genCodeBtn');
    const result = document.getElementById('genCodeResult');
    const msgEl = document.getElementById('genCodeMsg');
    const duration = parseInt(document.getElementById('genDuration').value) || 30;

    btn.disabled = true;
    btn.textContent = 'Generating...';
    result.style.display = 'none';
    msgEl.style.display = 'none';

    try {
        const { data: { session }, error: sessionError } = await sb.auth.getSession();
        if (sessionError || !session) throw new Error('Please sign in first.');

        console.log('[GenCode] Calling generate-admin-code with user:', session.user?.email);

        let res = await fetch(`${SUPABASE_URL}/functions/v1/generate-admin-code`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ durationDays: duration })
        });

        if (res.status === 401) {
            const { data: { session: newSession }, error: refreshErr } = await sb.auth.refreshSession();
            if (refreshErr || !newSession?.access_token) throw new Error("Session expired. Please sign in again.");

            res = await fetch(`${SUPABASE_URL}/functions/v1/generate-admin-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${newSession.access_token}`
                },
                body: JSON.stringify({ durationDays: duration })
            });
        }

        console.log('[GenCode] Response status:', res.status);
        const data = await res.json();
        console.log('[GenCode] Response body:', JSON.stringify(data));

        if (!res.ok) throw new Error(`[${res.status}] ${data.error || JSON.stringify(data)}`);

        const expiryText = `Expires ${new Date(data.expires_at).toLocaleString()} · ${data.duration_days} days Pro`;
        document.getElementById('genCodeText').textContent = data.code;
        const expiryEl = document.getElementById('genCodeExpiry');
        expiryEl.textContent = expiryText;
        expiryEl.dataset.expiry = expiryText;
        result.style.display = 'block';

    } catch (e) {
        console.error('[GenCode] Error:', e.message);
        msgEl.textContent = e.message;
        msgEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Code';
    }
}

function copyGenCode(el) {
    const code = document.getElementById('genCodeText').textContent;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
        el.style.background = 'rgba(96,165,250,0.12)';
        const expiryEl = document.getElementById('genCodeExpiry');
        expiryEl.textContent = '✅ Copied to clipboard!';
        setTimeout(() => {
            el.style.background = '';
            expiryEl.textContent = expiryEl.dataset.expiry || '';
        }, 2000);
    });
}


let pendingAvatarFile = null;

function handleAvatarSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Check file size (1MB max limit)
    if (file.size > 1024 * 1024) {
        alert("File must be under 1MB.");
        return;
    }

    pendingAvatarFile = file;
    // Show local preview
    const reader = new FileReader();
    reader.onload = function (e) {
        document.getElementById('avatarPreview').innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"/>`;
        document.getElementById('avatarPreview').style.background = 'transparent';
        document.getElementById('avatarPreview').style.border = '1px solid var(--border)';
    };
    reader.readAsDataURL(file);
}

async function saveProfile() {
    if (!currentUser) return;

    document.getElementById('dashLoading').classList.add('active');
    document.getElementById('saveProfileBtn').disabled = true;

    try {
        let newAvatarUrl = userAvatarUrl;

        // 1. Handle Avatar Upload if a new file was selected
        if (pendingAvatarFile) {
            const fileExt = pendingAvatarFile.name.split('.').pop();
            const fileName = `${currentUser.id}-${Math.random()}.${fileExt}`;
            const filePath = `${currentUser.id}/${fileName}`;

            const { error: uploadError } = await sb.storage.from('avatars').upload(filePath, pendingAvatarFile);

            if (uploadError) {
                if (uploadError.message && uploadError.message.includes('row-level security') && currentUser.email === 'truth7824@gmail.com') {
                    console.warn("Ignored avatar upload RLS error for admin. Using local preview.");
                    newAvatarUrl = document.querySelector('#avatarPreview img').src;
                } else if (uploadError.message && uploadError.message.includes('row-level security')) {
                    throw new Error("Storage policy prevented upload. Please run the Storage policies in your Supabase SQL editor.");
                } else {
                    throw uploadError;
                }
            } else {
                const { data: publicURLData } = sb.storage.from('avatars').getPublicUrl(filePath);
                newAvatarUrl = publicURLData.publicUrl;
            }
        }

        // 2. Handle Name Change
        const newName = document.getElementById('profileNameInput').value.trim();
        let updatePayload = {};

        if (newName !== userFullName) {
            // Re-verify Cooldown just in case
            if (userNameLastUpdated) {
                const lastUpdate = new Date(userNameLastUpdated);
                const nextAllowed = new Date(lastUpdate.getTime() + 30 * 24 * 60 * 60 * 1000);
                if (new Date() < nextAllowed) {
                    throw new Error("You cannot change your name yet.");
                }
            }
            updatePayload.full_name = newName;
            updatePayload.last_name_update = new Date().toISOString();
        }

        // 3. Update Database
        if (newAvatarUrl !== userAvatarUrl) updatePayload.avatar_url = newAvatarUrl;

        if (Object.keys(updatePayload).length > 0) {
            const { error: dbError } = await sb.from('user_profiles').update(updatePayload).eq('id', currentUser.id);
            if (dbError) {
                if (dbError.message && dbError.message.includes('row-level security') && currentUser.email === 'truth7824@gmail.com') {
                    console.warn("Ignored RLS error for admin user.");
                } else if (dbError.message && dbError.message.includes('row-level security')) {
                    throw new Error("Database policy prevented update. Please run the UPDATE policy in your Supabase SQL editor.");
                } else {
                    throw dbError;
                }
            }

            // Update local state
            if (updatePayload.full_name) {
                userFullName = updatePayload.full_name;
                userNameLastUpdated = updatePayload.last_name_update;
            }
            if (updatePayload.avatar_url) {
                userAvatarUrl = updatePayload.avatar_url;
            }

            pendingAvatarFile = null;
            updateAuthUI();
            populateDashboardUI(); // Refresh cooldown UI
        }
    } catch (error) {
        console.error("Error saving profile:", error);
        alert(error.message || "Failed to update profile.");
    } finally {
        document.getElementById('dashLoading').classList.remove('active');
        document.getElementById('saveProfileBtn').disabled = false;
    }
}

/* ── User Dashboard Logic ── */
function openDashboard() {
    if (!currentUser) return openAuthModal();
    document.getElementById('dashboardModal').classList.add('open');
    populateDashboardUI();
}

function closeDashboard() {
    document.getElementById('dashboardModal').classList.remove('open');
}

function switchDashboardTab(tab) {
    ['tabDashProfile', 'tabDashHistory', 'tabDashBilling', 'tabDashPacks', 'tabDashSettings'].forEach(id => document.getElementById(id).classList.remove('active'));
    ['dashContentProfile', 'dashContentHistory', 'dashContentBilling', 'dashContentPacks', 'dashContentSettings'].forEach(id => document.getElementById(id).classList.add('hidden'));

    document.getElementById(`tabDash${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.add('active');
    document.getElementById(`dashContent${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.remove('hidden');

    // Auto-load billing data when tab is opened
    if (tab === 'billing') loadBillingHistory();
}

function populateDashboardUI() {
    // Profile Tab
    document.getElementById('profileNameInput').value = userFullName || '';
    if (userAvatarUrl) {
        document.getElementById('avatarPreview').innerHTML = `<img src="${userAvatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"/>`;
        document.getElementById('avatarPreview').style.background = 'var(--bg2)';
        document.getElementById('avatarPreview').style.border = '1px solid var(--border)';
    } else {
        document.getElementById('avatarPreview').innerHTML = (userFullName || currentUser?.email || 'U').substring(0, 2).toUpperCase();
        document.getElementById('avatarPreview').style.background = 'var(--bg2)';
        document.getElementById('avatarPreview').style.border = '1px solid var(--border)';
    }

    // Cooldown check for name
    if (userNameLastUpdated) {
        const lastUpdate = new Date(userNameLastUpdated);
        const nextAllowed = new Date(lastUpdate.getTime() + 30 * 24 * 60 * 60 * 1000);
        const now = new Date();
        if (now < nextAllowed) {
            const daysRemaining = Math.ceil((nextAllowed - now) / (1000 * 60 * 60 * 24));
            document.getElementById('nameCooldownInfo').innerHTML = `<span style="color:#ff9500">You can change your name again in ${daysRemaining} days.</span>`;
            document.getElementById('saveProfileBtn').disabled = true;
        } else {
            document.getElementById('nameCooldownInfo').innerHTML = `You can change your name.`;
            document.getElementById('saveProfileBtn').disabled = false;
        }
    } else {
        document.getElementById('nameCooldownInfo').innerHTML = `You can only change your name once every 30 days.`;
        document.getElementById('saveProfileBtn').disabled = false;
    }

    // Settings Tab
    document.getElementById('settingsTierVal').textContent = userTier.toUpperCase();
    document.getElementById('settingsTierVal').style.color = isPro ? 'var(--accent)' : 'var(--muted)';
    document.getElementById('settingsCreditsVal').textContent = userCredits;

    // Wallet / billing display
    const billingStatus = document.getElementById('billingStatusVal');
    const billingExpiry = document.getElementById('billingExpiryVal');
    if (billingStatus && billingExpiry) {
        if (isPro) {
            billingStatus.textContent = 'PRO ACTIVE';
            billingStatus.style.color = 'var(--acid)';
            billingExpiry.textContent = proExpiresAt
                ? new Date(proExpiresAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
                : 'Never';
            billingExpiry.style.color = 'var(--white)';
        } else {
            billingStatus.textContent = 'Free';
            billingStatus.style.color = 'var(--muted)';
            billingExpiry.textContent = '—';
            billingExpiry.style.color = 'var(--muted)';
        }
    }

    // Show admin code generator panel only for admin
    const adminPanel = document.getElementById('adminGenPanel');
    if (adminPanel) {
        adminPanel.style.display = currentUser?.email === 'truth7824@gmail.com' ? 'block' : 'none';
    }

    // Hide upgrade/Get Pro buttons for Pro users
    const billingGetProBtn = document.querySelector('#dashContentBilling .auth-btn');
    if (billingGetProBtn) billingGetProBtn.style.display = isPro ? 'none' : '';
    const settingsUpgradeBtn = document.querySelector('#dashContentSettings .setting-row .auth-btn');
    if (settingsUpgradeBtn) settingsUpgradeBtn.style.display = isPro ? 'none' : '';

    // Packs Tab
    if (currentUser?.email === 'truth7824@gmail.com' || isPro) {
        document.getElementById('emptyPacksMsg').style.display = 'none';
        document.getElementById('contentPackWeb3').classList.remove('hidden');
        document.getElementById('contentPackFounder').classList.remove('hidden');

        document.getElementById('templateWeb3').value =
            `Hey [Name],

Been using [Protocol] since the v2 launch. Really clean setup on the [Specific Feature] side.

I do [Your Skill] mostly for [Your Niche]. I noticed you're pushing hard on [Area You Can Help With], but it looks like you might need more hands there to keep up with the volume.

I've got some free time next week and would love to help speed that up. I jotted down a quick 3-point list of things I'd fix right away.

Want me to send it over so you can take a look?`;

        document.getElementById('templateFounder').value =
            `Hey [Name],

Love what you're doing with [Project]. That new update on [Specific Feature] was a smart move.

I know founders usually hate dealing with [Specific Pain Point, e.g. writing docs / filtering discord noise]. I actually build systems that handle that on autopilot.

I just did this for [Past Client] and saved them about [Concrete Result, e.g. 10 hours a week].

Are you guys looking to hand that stuff off so you can stay focused on the product? I can drop a quick link showing how I'd set it up for you.`;
    } else {
        // In a real app we'd query sb.from('user_niche_packs') here
        document.getElementById('emptyPacksMsg').style.display = 'block';
        document.getElementById('contentPackWeb3').classList.add('hidden');
        document.getElementById('contentPackFounder').classList.add('hidden');
    }
}

/* ── History Sidebar (Deprecated -> Moved to Dashboard) ── */
async function loadHistory() {
    if (!currentUser) return;
    const { data } = await sb.from('chat_sessions').select('*').order('created_at', { ascending: false }).limit(50);
    if (!data?.length) return renderHistoryEmpty();

    document.getElementById('dashboardHistoryList').innerHTML = data.map(s => `
    <div class="history-item ${s.id === currentSessionId ? 'active' : ''}" onclick="loadSession('${s.id}')">
      <div class="history-item-title">${escHtml(s.title || 'Untitled Session')}</div>
      <div class="history-item-meta">${formatDate(s.created_at)}</div>
      <button class="history-delete" onclick="deleteSession(event,'${s.id}')">✕</button>
    </div>`).join('');
}

function renderHistoryEmpty() {
    const el = document.getElementById('dashboardHistoryList');
    if (el) el.innerHTML = `<div class="history-empty">${currentUser ? 'No sessions yet. Generate a pitch to start saving.' : 'Sign in to save and view your past sessions.'}</div>`;
}

async function loadSession(sessionId) {
    if (!currentUser) return;
    currentSessionId = sessionId;
    const { data: session } = await sb.from('chat_sessions').select('*').eq('id', sessionId).single();
    const { data: messages } = await sb.from('chat_messages').select('*').eq('session_id', sessionId).order('created_at');
    if (!session) return;
    pitchContext = session.pitch_context || '';
    if (pitchContext) document.getElementById('chatContextBadge').classList.add('active');
    chatHistory = (messages || []).map(m => ({ role: m.role, content: m.content }));
    const msgs = document.getElementById('chatMessages');
    msgs.innerHTML = '';
    (messages || []).forEach(m => addChatMsg(m.role === 'user' ? 'user' : 'ai', m.content, false));
    document.getElementById('chatSaveIndicator').classList.add('visible');
    document.getElementById('chatFab').classList.add('open');
    document.getElementById('chatPanel').classList.add('open');
    closeDashboard();
    scrollBottom();
}

async function deleteSession(e, id) {
    e.stopPropagation();
    await sb.from('chat_sessions').delete().eq('id', id);
    if (currentSessionId === id) {
        currentSessionId = null; chatHistory = []; pitchContext = '';
        document.getElementById('chatSaveIndicator').classList.remove('visible');
    }
    loadHistory();
}

function startNewSession() {
    currentSessionId = null; chatHistory = []; pitchContext = '';
    document.getElementById('chatContextBadge').classList.remove('active');
    document.getElementById('chatSaveIndicator').classList.remove('visible');
    document.getElementById('chatMessages').innerHTML = `<div class="chat-msg ai"><div class="chat-msg-role">Advisor</div><div class="chat-bubble">New session started. Generate a pitch and I'll be ready to help.</div></div>`;
    clearOutputs();
    closeDashboard();
    loadHistory();
}

async function ensureSession(title, mode) {
    if (!currentUser || currentSessionId) return;
    const { data } = await sb.from('chat_sessions').insert({
        user_id: currentUser.id, title, mode: mode || 'web3', pitch_context: pitchContext
    }).select().single();
    if (data) { currentSessionId = data.id; document.getElementById('chatSaveIndicator').classList.add('visible'); loadHistory(); }
}

async function saveMsg(role, content) {
    if (!currentUser || !currentSessionId) return;
    await sb.from('chat_messages').insert({ session_id: currentSessionId, role, content });
}

function formatDate(d) {
    const date = new Date(d), now = new Date(), diff = now - date;
    if (diff < 86400000) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diff < 604800000) return date.toLocaleDateString([], { weekday: 'short' });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* ── Account Type Detection ── */
async function detectAccountType(link) {
    const handle = extractHandle(link).toLowerCase();

    // Quick heuristic checks first (no API call needed)
    const projectSignals = ['protocol', 'network', 'chain', 'swap', 'finance', 'fi', 'dao', 'labs', 'xyz', 'defi', 'nft', 'bridge', 'vault', 'stake', 'lend', 'dex', 'token', 'coin', 'pay', 'wallet', 'layer', 'io', 'app', 'hq', 'official'];
    const personalSignals = ['cz_', 'vitalik', 'elonmusk', '_eth', '.eth', 'punk', 'degen'];

    // If handle ends with or contains project keywords, likely a project
    if (projectSignals.some(s => handle.includes(s))) return 'project';
    // Common personal patterns
    if (personalSignals.some(s => handle.includes(s))) return 'personal';

    // Fall back to AI for ambiguous handles
    const system = `You classify X (Twitter) handles as belonging to a Web3 PROJECT or a PERSONAL account.

PROJECT signals (respond "project"):
- Name sounds like a brand, protocol, or product (e.g. Uniswap, Aave, LayerZero)
- Handle uses words like: protocol, labs, network, finance, dao, official, hq, app
- Handle is a made-up word or brand name (e.g. Arbitrum, Optimism, Jupiter)
- No first/last name pattern

PERSONAL signals (respond "personal"):
- Handle looks like a real person's name (e.g. @john_crypto, @SarahDeFi)
- Contains first names, nicknames, or personal identifiers
- Uses patterns like: firstname_lastname, name + numbers, name + "eth"/"sol"/"web3"
- Handle of a known individual (founder, KOL, influencer, dev)

Respond with ONLY one word: "project" or "personal". Nothing else.`;

    try {
        const result = await callAI(system, [{ role: 'user', content: `X handle: @${handle}\nURL: ${link}` }], 10);
        return result.trim().toLowerCase().includes('personal') ? 'personal' : 'project';
    } catch { return 'project'; }
}

/* ── Main Generate (routes to correct mode) ── */
async function generatePitch() {
    if (!currentUser) {
        openAuthModalToSignUp();
        return;
    }

    // Check Limits
    if (!isPro && userCredits <= 0) {
        openPricingModal();
        return showPricingMsg('error', 'You are out of credits! Please purchase a credit bundle or upgrade to Pro to continue.');
    }

    // Enforce 5-pitch limit for free users
    if (!isPro && totalPitchesGenerated >= 5) {
        openPricingModal();
        return showPricingMsg('error', 'You have reached the free limit of 5 pitches. Upgrade to Pro to unlock unlimited generation.');
    }

    if (currentMode === 'bd') return generateBDPitch();

    const link = document.getElementById('xLink').value.trim();
    const niche = document.getElementById('niche').value.trim();
    const targetDesc = document.getElementById('targetDesc').value.trim();
    if (!link || !niche || !targetDesc) return showError('Please fill in all fields, including what they do.');
    if (!link.startsWith('http')) return showError('Please enter a valid URL starting with https://');
    if (!link.includes('x.com') && !link.includes('twitter.com')) return showError('Please enter a valid X (Twitter) link.');

    setLoading(true); hideError(); clearOutputs();
    const od = document.getElementById('outputDivider');
    if (od) od.style.display = 'block';

    // UI Setup
    document.getElementById('snapshotWrap').style.display = 'block';
    document.getElementById('snapshotLabel').textContent = 'Project Snapshot';
    document.getElementById('snapshotContainer').innerHTML = `<div class="snapshot-loading"><div class="snapshot-spinner"></div>Analyzing data...</div>`;

    // Run account type detector and snapshot generation in parallel
    const [accountType, snapshotData] = await Promise.all([
        detectAccountType(link),
        generateSnapshot(link, targetDesc)
    ]);

    if (accountType === 'personal') {
        document.getElementById('snapshotContainer').innerHTML = `
      <div class="snapshot-card" style="border-left-color:#ff9500;grid-template-columns:1fr;gap:1rem;">
        <div class="snap-field full"><div class="snap-key" style="color:#ff9500;">⚠ Personal Account Detected</div>
          <div class="snap-val" style="margin-top:0.4rem;">This looks like a <strong style="color:var(--white)">personal X account</strong>. PitchProtocol needs the project's official X account.</div></div>
        <div class="snap-field full"><div class="snap-key" style="color:#ff9500;">What To Do</div>
          <div class="snap-val">Find the project's X handle and paste that instead. It typically looks like <span style="color:var(--acid)">x.com/ProjectName</span>.</div></div>
        <div class="snap-field full" style="margin-top:0.5rem;">
          <button onclick="clearAll()" style="background:transparent;border:1px solid var(--border);color:var(--muted);font-family:'Inter',sans-serif;font-size:0.65rem;letter-spacing:0.12em;text-transform:uppercase;padding:6px 16px;cursor:pointer;transition:all 0.2s;border-radius:6px;">✕ Start Over</button>
        </div>
      </div>`;
        setLoading(false); return;
    }

    const handle = extractHandle(link);
    const system = `You write outreach pitches for people trying to join or collaborate with Web3 projects.

Follow this exact 5-Stage framework to generate the pitch. You must output the entire thought process so the user can see *why* the pitch works, ending with the final DM.

CRITICAL TONE RULES FOR STAGE 4 AND 5:
- Write exactly like a human builder DMing another human. Warm, natural, grounded.
- No corporate stiffness. No AI-sounding phrases. No filler or ambiguous words.
- Tone should be hands-on and high-agency: proactive, energetic, and problem-solving.
- Express interest with quiet confidence and authentic detail. Do not oversell. Do not beg.
- Mix short and long paragraphs. Let it breathe. Conversational, authentic, and direct.

EXTREME BANNED WORD LIST - Do not use these under any circumstance:
Innovative, cutting-edge, revolutionary, disruptive, disrupting, disruption, next-generation, state-of-the-art, game-changing, changing the game, groundbreaking, transformative, industry-leading,
Strategic, synergy, partnership, value proposition, optimize, streamline, leverage, facilitate, ecosystem, solutions-oriented, scalability, paramount,
Impressed by your work, excited to contribute, passionate about your mission, deeply resonate, inspired by your vision, committed to driving impact, dedication to excellence, pioneering, leading the way,
As an AI, as a language model, I was trained, my training data, based on my knowledge, I should note that, it's worth mentioning that, I'd like to highlight, allow me to,
Furthermore, moreover, additionally, consequently, therefore, in conclusion, it is important to note, as a result, notably, to summarize,
I would like to take this opportunity, I would be honored, I possess a diverse skill set,
could, might, potential, possibly, somewhat, generally, typically, robust, delve, foster, seamless, elevate, tapestry, reach out, touch base, embark, journey.

--- GOLD STANDARD PITCH EXAMPLE ---
Study this exact tone, authentic storytelling, and structure. This is the ONLY acceptable format and tone for the final DM:

"I’m writing to express my interest in the [Target Role] position at [Target Project Name].

Over the past [Timeframe] in Web3, I’ve had the privilege of [Specific high-level action, e.g., building, growing, and managing communities] for [Type of projects], both in early-stage environments and with established teams.

My approach has always been hands-on and high-agency: I don’t wait for tasks to come to me, I proactively source opportunities to [Direct outcome 1], [Direct outcome 2] and [Direct outcome 3].

In my current role as a [Current/Past Role] at [Company], I [Concrete achievement/responsibility].

I also [Side-initiative/Second concrete achievement], an initiative to [Goal of initiative], creating [Metric/Action], and running [Metric/Action] as well.

This approach has helped us [Major outcome] without relying on [Common crutch/cliché approach]. This is a testament to the power of authentic, value-driven execution.

I’m confident I can bring same mix of strategic thinking, creative execution, and genuine connection to [Target Project Name]. Your mission to [Project's core mechanic/goal from snapshot] aligns with me, and I’d love to help shape a vibrant, informed ecosystem around it.

I would be excited to discuss how my experience and energy could contribute to [Target Project Name]'s growth overall.

Let’s cook!!!

Thanks for your time and consideration,
[Sign-off Name]"
--------------------------------

Stage 1. Clarify Your Ask
Am I asking for a collab, a role, a call, or feedback? What's the exact outcome I want from this DM?
Output: One-line statement of the ask.

Stage 2. Define Your Value
What can I offer them that they can't ignore? Focus on tangible value, unique angle, or timing advantage.
Output: 2–3 bullet points of "why me / why now".

Stage 3. Connect the Ask to Value
Show that by doing what I ask, they benefit immediately.
Output: A mini "value + ask" combo.

Stage 4. Write the DM Draft
Draft a highly human, natural message combining the context, value, and ask.

Stage 5. Polish to DM Ready
Final check: Read it aloud. Does it sound like a robot wrote it? If yes, rewrite it.
CRITICAL: Use the GOLD STANDARD EXAMPLE as your blueprint. Adapt its pacing and structure to fit the user's niche and the target project. DO NOT copy the example verbatim - change the timelines, actions, companies, and goals to match the actual inputs. Smooth, natural flow without ambiguous words.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

[STAGE 1]: [Clarified Ask]
[STAGE 2]:
• [Value point 1]
• [Value point 2]
[STAGE 3]: [Connected Value + Ask]
[DM READY]:
[The polished, highly human DM, ready to copy/paste. No quotes around it. Must closely mirror the pacing and tone of the GOLD STANDARD EXAMPLE.]`;

    const prompt = `Project X handle: @${handle}\nFull link: ${link}\nMy niche/skills: ${niche}\n${targetDesc ? `User Notes: ${targetDesc}\n` : ''}
    
--- PROJECT SNAPSHOT (GROUND TRUTH) ---
What they build: ${snapshotData ? snapshotData.summary : 'Unknown'}
Project Stage: ${snapshotData ? snapshotData.stage : 'Unknown'} 
(CRITICAL: If the stage is "Mainnet" or "Growth", they have already launched. Do NOT reference an "upcoming launch" or act like they are brand new.)
Key Opportunity: ${snapshotData ? snapshotData.opportunity : 'Unknown'}
---------------------------------------

--- WEB3 JOB NICHES REFERENCE ---
If the user's niche matches or relates to one of these roles, tailor your pitch to highlight the specific value that role brings to the project's stage:

Technical & Product:
Blockchain Developer, Frontend/Backend Engineer, Smart Contract Auditor, Product Manager, UI/UX Designer, Data/Onchain Analyst, Tokenomics Specialist, Security Researcher.

Growth & Expansion:
Business Development, Marketing Strategist, Social Media Manager, Community Strategist, Community Manager, Ambassador Lead, KOL Manager.

Media & Visibility:
Content Writer, Copywriter, Video Content Creator, Animator, Motion Designer, Graphics Designer, Space Host, Podcast Host.

Attention & Distribution:
Shiller, Raider, Meme Creator.

Governance & Structure:
DAO Operations Lead, Legal & Compliance Advisor, Treasury Manager, Grant Manager.

Sector Specific:
DeFi Strategist, NFT Strategist, Game Economy Designer, AI x Web3 Specialist.
---------------------------------

Analyze this project and generate the pitch using the 5-Stage framework.`;

    try {
        const text = await callAI(system, [{ role: 'user', content: prompt }], 1400);

        // Deduct Credit (simulated backend call)
        if (!isPro) {
            userCredits -= 1;
            // Fix: update credits correctly; total_pitches_generated is incremented
            // server-side via the Edge Function in production (avoids race conditions).
            await sb.from('user_profiles').update({ credits: userCredits }).eq('id', currentUser.id);
            updateAuthUI();
        }

        renderPitch(text, handle, niche, 'hire');
        pitchContext = `Mode: Get Hired\nTarget: @${handle}\nBackground: ${niche}\nPitch:\n${text.substring(0, 700)}`;
        document.getElementById('chatContextBadge').classList.add('active');

        // Save Pitch History if Pro
        if (currentUser && !currentSessionId) {
            if (isPro) {
                const title = `⚡ ${handle}`;
                await ensureSession(title, 'hire');
                if (currentSessionId) await sb.from('chat_sessions').update({ pitch_context: pitchContext }).eq('id', currentSessionId);
            } else {
                addChatMsg('ai', "Note: Pitch history saving is a Pro feature. This session won't be saved to the sidebar.");
            }
        }
        generateRoadmap(link, niche, text, 'hire');
    } catch { showError('Something went wrong. Please try again.'); }
    setLoading(false);
}

/* ── BD Pitch ── */
async function generateBDPitch() {
    const myLink = document.getElementById('myProjectLink').value.trim();
    const myDesc = document.getElementById('myProjectDesc').value.trim();
    const theirLink = document.getElementById('theirProjectLink').value.trim();
    const theirDesc = document.getElementById('theirProjectDesc').value.trim();

    if (!myLink || !myDesc || !theirLink || !theirDesc) return showError('Please fill in all four fields.');
    if (!theirLink.includes('x.com') && !theirLink.includes('twitter.com')) return showError('Target project link must be an X (Twitter) link.');

    setLoading(true); hideError(); clearOutputs();
    const od2 = document.getElementById('outputDivider');
    if (od2) od2.style.display = 'block';
    document.getElementById('snapshotWrap').style.display = 'block';
    document.getElementById('snapshotLabel').textContent = 'Target Project Snapshot';
    document.getElementById('snapshotContainer').innerHTML = `<div class="snapshot-loading"><div class="snapshot-spinner"></div>Researching their project...</div>`;
    const snapshotData = await generateSnapshot(theirLink, theirDesc);

    const myHandle = extractHandle(myLink);
    const theirHandle = extractHandle(theirLink);

    const system = `You write BD (business development) pitches between Web3 projects.

Follow this exact 5-Stage framework to generate the pitch. You must output the entire thought process so the user can see *why* the pitch works, ending with the final DM.

CRITICAL TONE RULES FOR STAGE 4 AND 5:
- This is high-signal B2B communication. Write like a sharp Head of BD or founder — direct, credible, no fluff.
- OPENER RULE (non-negotiable): Always start the DM with "Hey [Project Name] Team," — use the actual project name, NEVER the Twitter @handle. This is the ONLY acceptable opener.
- Lead with a business-relevant observation about THEM. Never talk about yourself first.
- NEVER use "been watching", "been following", "been tracking", or any variation.
- Replace ALL weak phrasing: NEVER say "we think", "we believe", "we could", "we might". Use "We can", "We will", "We have built", "We drive".
- Every sentence must carry weight. Cut anything that doesn't add hard information.
- No vague promises. No exaggerated claims. Mechanics, numbers, outcomes only.

FULL BANNED WORD LIST - never use any of these, not even variants:
Innovative, cutting-edge, revolutionary, disruptive, disrupting, disruption, next-generation, state-of-the-art, game-changing, changing the game, groundbreaking, transformative, industry-leading,
Strategic, synergy, partnership, value proposition, optimize, streamline, leverage, facilitate, ecosystem, solutions-oriented, scalability,
Impressed by your work, excited to contribute, passionate about your mission, deeply resonate, inspired by your vision, committed to driving impact, dedication to excellence, pioneering, leading the way, you're changing the game, you are changing the game,
As an AI, as a language model, I was trained, my training data, based on my knowledge, I should note that, it's worth mentioning that, I'd like to highlight, allow me to,
Furthermore, moreover, additionally, consequently, therefore, in conclusion, it is important to note, as a result, notably, to summarize,
I am writing to express, I would like to take this opportunity, thank you for your time and consideration, I would be honored, I possess a diverse skill set, I am confident that I can contribute, I believe my experience aligns,
It's not just about X it's about Y, from X to Y, at the end of the day, this highlights the importance of, as you may know, with that being said,
could, might, potential, possibly, somewhat, generally, typically, robust, delve, foster, seamless, elevate, tapestry, testament, aligns, reach out, touch base.

--- GOLD STANDARD BD EXAMPLE ---
This is the ONLY format acceptable for the final DM:

"Hey [Project Name] Team,

Noticed [Specific, plain-language observation about their product mechanic, liquidity position, or growth move].

We [What my project does], currently driving [Specific metric or capability]. We can integrate [Specific mechanic] to help you [Specific tangible outcome — e.g., route more volume / reduce slippage / acquire users].

Open to exploring what this looks like?"
--------------------------------

Stage 1. Clarify Your Ask
Am I asking for a feature integration, liquidity, distribution, or co-marketing? What's the exact outcome I want?
Output: One-line statement of the ask.

Stage 2. Define Your Value
What can we offer them that they can't ignore? Focus on tangible value: user overlap, TVL, volume routing, distribution.
Output: 2–3 bullet points of "why us / why now".

Stage 3. Connect the Ask to Value
Show the explicit transactional benefit of working together.
Output: A mini "value + ask" combo.

Stage 4. Write the DM Draft
Draft a sharp, professional B2B message combining the context, value, and ask.

Stage 5. Polish to DM Ready
Final check: Is every sentence earning its place? If not, cut it.
CRITICAL: Use the GOLD STANDARD EXAMPLE as your blueprint. Adapt it to the two specific projects. DO NOT copy verbatim. Keep it extremely crisp.
DO NOT use em dashes anywhere in the DM. Use plain hyphens or commas instead.
The CTA must be low friction. NEVER ask "let's hop on a call".

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

[STAGE 1]: [Clarified Ask]
[STAGE 2]:
• [Value point 1]
• [Value point 2]
[STAGE 3]: [Connected Value + Ask]
[DM READY]:
[The polished, professional DM, ready to copy/paste. No quotes around it. Must closely mirror the pacing and tone of the GOLD STANDARD EXAMPLE.]`;

    const prompt = `My project X: @${myHandle} (${myLink})
What my project does: ${myDesc}

Their project X: @${theirHandle} (${theirLink})

--- THEIR PROJECT SNAPSHOT (GROUND TRUTH) ---
What they build: ${snapshotData ? snapshotData.summary : 'Unknown'}
Project Stage: ${snapshotData ? snapshotData.stage : 'Unknown'} 
(CRITICAL: If the stage is "Mainnet" or "Growth", they have already launched. Do NOT reference an "upcoming launch" or act like they are brand new.)
Key Opportunity: ${snapshotData ? snapshotData.opportunity : 'Unknown'}
---------------------------------------------

Analyze both projects and generate the BD pitch using the 5-Stage framework.`;

    try {
        const text = await callAI(system, [{ role: 'user', content: prompt }], 1600);

        // Deduct Credit
        if (!isPro) {
            userCredits -= 1;
            await sb.from('user_profiles').update({ credits: userCredits }).eq('id', currentUser.id);
            updateAuthUI();
        }

        renderPitch(text, theirHandle, myDesc, 'bd', myHandle);
        pitchContext = `Mode: BD Partnership\nOur project: @${myHandle} \nTarget: @${theirHandle} \nPitch: \n${text.substring(0, 700)} `;
        document.getElementById('chatContextBadge').classList.add('active');

        if (currentUser && !currentSessionId) {
            if (isPro) {
                const title = `🤝 ${myHandle} → ${theirHandle} `;
                await ensureSession(title, 'bd');
                if (currentSessionId) await sb.from('chat_sessions').update({ pitch_context: pitchContext }).eq('id', currentSessionId);
            } else {
                addChatMsg('ai', "Note: Pitch history saving is a Pro feature. Upgrade to keep these sessions accessible.");
            }
        }
        generateRoadmap(theirLink, myDesc, text, 'bd');
    } catch { showError('Something went wrong. Please try again.'); }
    setLoading(false);
}

/* ── Project Snapshot ── */

// URL of the deployed scrape-x Edge Function
const SCRAPE_X_URL = `${SUPABASE_URL}/functions/v1/scrape-x`;

async function generateSnapshot(link, targetDesc) {
    const handle = extractHandle(link);
    let scrapedContext = '';
    let verifiedBio = ''; // Ground-truth bio from server-side scrape
    const layers = [];

    // Layer 0 (highest priority): Server-side scrape via scrape-x Edge Function.
    // Deno's fetch with real browser headers bypasses X's JS-gate that blocks browser requests.
    try {
        const { data: { session } } = await sb.auth.getSession();
        if (session?.access_token) {
            const res = await fetch(SCRAPE_X_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ handle }),
                signal: AbortSignal.timeout(10000)
            });
            if (res.ok) {
                const data = await res.json();
                if (data.bio && data.bio.length > 20) {
                    verifiedBio = data.bio;
                    const namePart = data.name ? `${data.name} (@${handle})` : `@${handle}`;
                    layers.push(`Verified X bio for ${namePart}: "${data.bio}"`);
                    if (data.followersText) layers.push(`Followers: ${data.followersText}`);
                    console.log('[Snapshot] Layer 0 scrape-x OK:', data.bio.slice(0, 80));
                } else {
                    console.log('[Snapshot] Layer 0 scrape-x returned empty bio, trying fallbacks...');
                }
            }
        }
    } catch (e) { console.warn('[Snapshot] Layer 0 scrape-x failed:', e.message); }

    // Layer 1: Microlink — fetch description AND full page meta (fallback if Layer 0 got no bio)
    if (!verifiedBio) {
        try {
            const metaUrl = `https://api.microlink.io?url=https://x.com/${handle}&filter=description,title,image`;
            const res = await fetch(metaUrl, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'success') {
                    const bio = data.data?.description || '';
                    const title = data.data?.title || '';
                    const isJsBlock = bio.toLowerCase().includes('javascript is not available') ||
                        bio.toLowerCase().includes('sign in to x') ||
                        bio.length < 15;
                    if (!isJsBlock && bio) {
                        layers.push(`X profile bio (@${handle}): "${bio}"`);
                        console.log('[Snapshot] Microlink bio OK');
                    }
                    if (title && !title.toLowerCase().includes('javascript')) {
                        layers.push(`X page title: "${title}"`);
                    }
                }
            }
        } catch (e) { console.warn('[Snapshot] Microlink failed:', e.message); }
    }

    scrapedContext = layers.join('\n');

    // Layer 2 (always): AI knowledge — use the strongest available model for snapshot accuracy
    const system = `You are a Web3 research analyst. Your job is to generate a precise, factual project snapshot.

SOURCES OF TRUTH (in priority order):
1. User-supplied description (if provided) — treat as ground truth
2. VERIFIED SCRAPED BIO (if present) — this is the real, live text from their X profile. Use it verbatim.
3. Other scraped X data (if present below) — use specifics verbatim
4. Your training knowledge — use it confidently for known projects

RULES:
- Be specific. Never say "they are building the future of finance". Name real products, chains, TVL, users.
- If the project is well-known (Jupiter, Aave, Uniswap, Arbitrum, etc.) you already know it — use that knowledge.
- For less known projects, the scraped bio is the most accurate source — incorporate it directly.
- stage must be one of: Mainnet / Growth / Beta / Early / Stealth
- Never say "I don't know" or leave fields generic.

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "name": "Official project name",
  "type": "Specific type e.g. DEX aggregator / EVM L2 / NFT launchpad / Yield protocol / AI x DeFi",
  "summary": "3-4 factual sentences. What they build, who uses it, key metrics if known, what makes it distinct.",
  "stage": "Mainnet | Growth | Beta | Early | Stealth",
  "chain": "e.g. Solana, Base, Ethereum, Multi-chain — be specific",
  "tags": ["tag1", "tag2", "tag3"],
  "opportunity": "2 sentences. A real gap or hiring/partnership need visible from their activity or market position."
}`;

    try {
        const prompt = `X handle: @${handle}
Full link: ${link}${targetDesc ? `\nUser-supplied description (highest priority): ${targetDesc}` : ''}
${verifiedBio ? `\n⭐ VERIFIED BIO FROM LIVE X PROFILE (treat as ground truth): "${verifiedBio}"` : ''}

${scrapedContext
                ? `--- SCRAPED DATA ---\n${scrapedContext}\n--- END SCRAPED DATA ---`
                : '(No live scrape data — rely on training knowledge and the handle itself)'}

Generate the JSON snapshot now.`;

        // Use the stronger model for snapshots specifically
        let aiDataRaw;
        try {
            aiDataRaw = await callAI(system, [{ role: 'user', content: prompt }], 900, 'llama-3.3-70b-versatile', true);
        } catch (firstErr) {
            console.warn('[Snapshot] 70B model failed, falling back to 8b-instant:', firstErr.message);
            aiDataRaw = await callAI(system, [{ role: 'user', content: prompt }], 900, 'llama-3.1-8b-instant', true);
        }

        const raw = aiDataRaw || '';

        // Extract JSON from the AI response
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error('[Snapshot] Raw AI Output without JSON:', raw);
            throw new Error('No JSON found in AI response');
        }

        const parsedSnap = JSON.parse(jsonMatch[0]);
        renderSnapshot(parsedSnap);
        return parsedSnap;
    } catch (e) {
        console.error('[Snapshot] AI failed:', e);
        if (targetDesc) {
            const fallbackSnap = {
                name: handle,
                type: 'Web3 Project',
                summary: targetDesc,
                stage: 'Unknown',
                chain: 'Unknown',
                tags: ['Web3'],
                opportunity: 'Add more detail in "What They Do" to improve this snapshot.'
            };
            renderSnapshot(fallbackSnap);
            return fallbackSnap;
        } else {
            document.getElementById('snapshotContainer').innerHTML =
                `<div class="snapshot-loading" style="color:#ff8888;border-left-color:#ff4444;">Snapshot lookup failed. Fill in the "What They Do" field for a better result.</div>`;
            return null;
        }
    }
}

function renderSnapshot(snap) {
    const tags = (snap.tags || []).map(t => `<span class="snap-tag">${escHtml(t)}</span>`).join('');
    document.getElementById('snapshotContainer').innerHTML = `
    <div class="snapshot-card">
      <div class="snap-field full"><div class="snap-key">What They're Building</div><div class="snap-val">${escHtml(toSentenceCase(snap.summary))}</div></div>
      <div class="snap-field"><div class="snap-key">Type</div><div class="snap-val">${escHtml(toSentenceCase(snap.type))}</div></div>
      <div class="snap-field"><div class="snap-key">Stage</div><div class="snap-val">${escHtml(toSentenceCase(snap.stage))}</div></div>
      <div class="snap-field"><div class="snap-key">Chain</div><div class="snap-val">${escHtml(snap.chain)}</div></div>
      <div class="snap-field"><div class="snap-key">Tags</div><div class="snap-val">${tags || '—'}</div></div>
      <div class="snap-field full"><div class="snap-key">Key Opportunity</div><div class="snap-val">${escHtml(toSentenceCase(snap.opportunity))}</div></div>
    </div>`;
}

/* ── Roadmap ── */
async function generateRoadmap(link, context, pitch, mode) {
    document.getElementById('followupWrap').style.display = 'block';
    const isBD = mode === 'bd';
    const system = `You write Web3 ${isBD ? 'BD partnership' : 'outreach'} execution plans for X (Twitter) DM campaigns. Sound like a knowledgeable builder walking someone through what to actually do.
CRITICAL: This is an X DM strategy, NOT an email campaign. The advice must be highly relatable to current Crypto/Web3 events and X culture (e.g., engaging with their timeline, QRTs, casual follow-ups, avoiding corporate spam).

Respond ONLY with a valid JSON array (no markdown, no backticks).
Format: [{"phase":"Phase Name","title":"Step title","description":"2-3 sentences of clear, specific, and X-native advice.","timing":"Day X"}]
${isBD
            ? 'Phases: Before You Reach Out (2 steps), Making First Contact (2 steps), Keeping the Conversation Going (2 steps), Closing the Deal (1 step).'
            : 'Phases: Before You Send (2 steps), Sending & First Contact (2 steps), Follow-Up & Persistence (2 steps), Closing & Delivering Value (1 step).'}
No corporate speak. Make it real, casual, and actionable.`;

    try {
        const raw = await callAI(system, [{ role: 'user', content: `Target: ${link}\nContext: ${context}\nPitch preview: ${pitch.substring(0, 400)}\n\nGenerate the 7-step execution plan as JSON.` }], 1200);
        const text = raw.replace(/```json|```/g, '').trim();
        renderSteps(JSON.parse(text), isBD);
    } catch {
        document.getElementById('stepsContainer').innerHTML = `<div class="steps-loading" style="color:#ff8888;border-color:#5a1a1a;">Couldn't generate roadmap. Try refreshing.</div>`;
    }
}

function renderSteps(steps, isBD) {
    const colors = {
        'Before You Send': '#c8ff00', 'Sending & First Contact': '#00d4ff',
        'Follow-Up & Persistence': '#ff9500', 'Closing & Delivering Value': '#ff4dff',
        'Before You Reach Out': '#c8ff00', 'Making First Contact': '#00d4ff',
        'Keeping the Conversation Going': '#ff9500', 'Closing the Deal': '#ff4dff'
    };
    document.getElementById('stepsContainer').innerHTML = '<div class="steps-grid">' + steps.map((s, i) => {
        const c = colors[s.phase] || 'var(--acid)';
        return `<div class="step-item">
      <div class="step-num">${String(i + 1).padStart(2, '0')}</div>
      <div class="step-body">
        <div class="step-phase" style="color:${c}">${escHtml(s.phase)}</div>
        <div class="step-title">${escHtml(toSentenceCase(s.title))}</div>
        <div class="step-desc">${escHtml(toSentenceCase(s.description))}</div>
        <span class="step-timing" style="background:${c}">${escHtml(s.timing)}</span>
      </div>
    </div>`;
    }).join('') + '</div>';
    document.getElementById('followupWrap').style.opacity = '1';
    document.getElementById('followupWrap').style.animation = 'none';
}

/* ── Render Pitch ── */

// If the AI returned text that is mostly uppercase, convert to sentence case
function toSentenceCase(str) {
    if (!str) return str;
    // Detect: if >65% of alpha chars are uppercase, the AI wrote in ALL CAPS
    const alpha = str.replace(/[^a-zA-Z]/g, '');
    const upperCount = (str.match(/[A-Z]/g) || []).length;
    if (alpha.length > 10 && (upperCount / alpha.length) > 0.65) {
        // Convert: lowercase everything, then capitalize first letter of each sentence
        return str.toLowerCase().replace(/(^\s*|[.!?]\s+)([a-z])/g, (match, sep, char) => sep + char.toUpperCase());
    }
    return str;
}

const SECTIONS = ['[STAGE 1]', '[STAGE 2]', '[STAGE 3]', '[STAGE 4]', '[STAGE 5]', '[DM READY]'];
const LABELS = {
    '[STAGE 1]': '🎯 Clarified Ask',
    '[STAGE 2]': '💡 Defined Value',
    '[STAGE 3]': '🔗 Value + Ask Connection',
    '[STAGE 4]': '📝 DM Draft Structure',
    '[STAGE 5]': '✨ Polish',
    '[DM READY]': '📩 Final DM (Ready to Send)'
};

function renderPitch(text, targetHandle, context, mode, myHandle) {
    const isBD = mode === 'bd';
    const sections = SECTIONS;
    const labels = LABELS;

    let meta = isBD
        ? `<div class="project-meta">
        <div class="meta-chip">From: <span>@${escHtml(myHandle)}</span></div>
        <div class="meta-chip">To: <span>@${escHtml(targetHandle)}</span></div>
       </div>`
        : `<div class="project-meta">
        <div class="meta-chip">Target: <span>@${escHtml(targetHandle)}</span></div>
        <div class="meta-chip">Background: <span>${escHtml(context.substring(0, 45))}${context.length > 45 ? '...' : ''}</span></div>
       </div>`;

    let html = meta + '<div class="divider"></div>';

    // 1. Find all requested section tags that actually exist in the AI output
    const foundTags = [];
    for (const tag of sections) {
        // Look for the tag text, optionally surrounded by brackets, stars, spaces
        const base = tag.replace(/\[|\]/g, '');
        // Allow optional brackets, colons, or markdown bold
        const regex = new RegExp(`(\\[|\\*\\*)?${base}(\\]|\\*\\*|:)?`, 'i');
        const match = text.match(regex);
        if (match) {
            foundTags.push({ tag, index: match.index, matchText: match[0] });
        }
    }

    // 2. Sort tags by their actual position in the text
    foundTags.sort((a, b) => a.index - b.index);

    // 3. Extract content between tags
    if (foundTags.length > 0) {
        for (let i = 0; i < foundTags.length; i++) {
            const current = foundTags[i];
            const next = foundTags[i + 1];

            const startStr = current.index + current.matchText.length;
            const endStr = next ? next.index : text.length;

            let content = text.substring(startStr, endStr);
            // Clean up leading colons, dashes, asterisks, spaces
            content = content.replace(/^[\s:\-\*]+/, '').trim();
            // Auto-fix all-caps AI output
            content = toSentenceCase(content);

            const contentText = escHtml(content);

            if (current.tag === '[DM READY]') {
                const dmLabel = `<span class="dm-copy-btn" onclick="copyDmReady()" title="Copy DM to clipboard">📋 Copy DM</span>`;
                html += `<div class="pitch-section-label" style="display:flex;align-items:center;justify-content:space-between;color:var(--acid);">${labels[current.tag]}${dmLabel}</div><div class="pitch-text dm-ready-text" id="dmReadyText" style="background:rgba(200,255,0,0.04);border-left:2px solid var(--acid);padding:1rem 1.2rem;border-radius:8px;">${contentText.replace(/\n/g, '<br>')}</div>`;
            } else {
                html += `<div class="pitch-section-label">${labels[current.tag]}</div><div class="pitch-text">${contentText.replace(/\n/g, '<br>')}</div>`;
            }
            if (i < foundTags.length - 1) html += '<div class="divider"></div>';
        }
    } else {
        // Fallback if AI entirely ignored all formatting
        if (text && text.trim().length > 0) {
            html += `<div class="pitch-text">${escHtml(toSentenceCase(text))}</div>`;
        }
    }

    document.getElementById('pitchContent').innerHTML = html;
    const wrap = document.getElementById('outputWrap');
    wrap.style.display = 'block';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ── Helpers ── */
function extractHandle(link) {
    return link.replace(/https?:\/\/(www\.)?(x\.com|twitter\.com)\//, '').split('/')[0].split('?')[0];
}
function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function copyPitch() {
    // Build clean plaintext from pitch sections only (excludes section labels and UI elements)
    const container = document.getElementById('pitchContent');
    const textNodes = container.querySelectorAll('.pitch-text, .dm-ready-text');
    const cleanText = Array.from(textNodes).map(el => el.innerText.trim()).filter(Boolean).join('\n\n');
    const textToCopy = cleanText || container.innerText; // fallback to innerText if sections not found
    navigator.clipboard.writeText(textToCopy).then(() => {
        const b = document.querySelector('.copy-btn'); b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Copy', 2000);
    });
}

function copyDmReady() {
    const el = document.getElementById('dmReadyText');
    if (!el) return;
    navigator.clipboard.writeText(el.innerText.trim()).then(() => {
        const btn = document.querySelector('.dm-copy-btn');
        if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = '📋 Copy DM', 2000); }
    });
}
function setLoading(on) {
    document.getElementById('generateBtn').disabled = on;
    document.getElementById('spinner').style.display = on ? 'block' : 'none';
    const base = currentMode === 'bd' ? 'Generate BD Pitch →' : 'Generate Pitch →';
    document.getElementById('btnText').textContent = on ? 'Analyzing...' : base;
}
function clearAll() {
    ['xLink', 'niche', 'targetDesc', 'myProjectLink', 'myProjectDesc', 'theirProjectLink', 'theirProjectDesc'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    clearOutputs();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showError(msg) {
    const e = document.getElementById('errorMsg');
    e.innerHTML = `${msg} <button onclick="hideError();document.querySelector('.generate-btn').click()" style="margin-left:1rem;background:transparent;border:1px solid rgba(239,68,68,0.4);color:#f87171;font-family:'DM Mono',monospace;font-size:0.7rem;padding:2px 8px;cursor:pointer;letter-spacing:0.1em;">Retry ↺</button>`;
    e.style.display = 'block';
}
function hideError() { document.getElementById('errorMsg').style.display = 'none'; }

/* ── Chat ── */
function toggleChat() {
    document.getElementById('chatFab').classList.toggle('open');
    document.getElementById('chatPanel').classList.toggle('open');
    if (document.getElementById('chatPanel').classList.contains('open')) {
        document.getElementById('chatInput').focus(); scrollBottom();
    }
}
function askSuggestion(q) { document.getElementById('chatInput').value = q; sendChat(); }
function scrollBottom() { const m = document.getElementById('chatMessages'); m.scrollTop = m.scrollHeight; }

function addChatMsg(role, text, animate = true) {
    const msgs = document.getElementById('chatMessages');
    const el = document.createElement('div');
    el.className = `chat - msg ${role} `;
    if (!animate) el.style.animation = 'none';
    el.innerHTML = `< div class="chat-msg-role" > ${role === 'user' ? 'You' : 'Advisor'}</div > <div class="chat-bubble">${escHtml(text).replace(/\n/g, '<br>')}</div>`;
    msgs.appendChild(el); scrollBottom();
}

function showTyping() {
    const msgs = document.getElementById('chatMessages');
    const el = document.createElement('div'); el.className = 'chat-msg ai'; el.id = 'typing';
    el.innerHTML = `< div class="chat-typing" ><span></span><span></span><span></span></div > `;
    msgs.appendChild(el); scrollBottom();
}
function removeTyping() { document.getElementById('typing')?.remove(); }

async function sendChat() {
    const input = document.getElementById('chatInput');
    const q = input.value.trim(); if (!q) return;
    input.value = ''; document.getElementById('chatSendBtn').disabled = true;
    addChatMsg('user', q);
    chatHistory.push({ role: 'user', content: q });
    showTyping();

    const modeDesc = currentMode === 'bd'
        ? 'closing BD partnerships between Web3 projects'
        : 'reaching out to Web3 projects to get hired or collaborate';

    const system = `You're helping someone with ${modeDesc}. Give clear, useful advice in plain language — like a knowledgeable friend who's been through this before.Warm, honest, no fluff.
                ${pitchContext ? `\nHere's their situation:\n${pitchContext}\n\nTailor your advice to this.` : '\nNo pitch yet — give genuinely helpful general advice.'}
Keep it short and easy to read.No buzzwords, no "great question!" openers.`;

    try {
        const reply = (await callAI(system, chatHistory, 400)).trim();
        removeTyping();
        chatHistory.push({ role: 'assistant', content: reply });
        addChatMsg('ai', reply);
        if (currentUser) {
            if (!currentSessionId) await ensureSession((currentMode === 'bd' ? '🤝' : '💬') + ' Chat — ' + new Date().toLocaleDateString(), currentMode);
            await saveMsg('user', q);
            await saveMsg('assistant', reply);
        }
    } catch {
        removeTyping();
        addChatMsg('ai', 'Something went wrong. Try again.');
    }
    document.getElementById('chatSendBtn').disabled = false;
    document.getElementById('chatInput').focus();
}
// ── Page-load auth init ──────────────────────────────────────────────────────
// Scripts are `defer` so this runs after supabase.js + script.js are ready.
// We directly call getSession() to restore session from localStorage, then
// wait for the profileLoadPromise that onAuthStateChange sets up.
// This avoids any race between window events and async Supabase callbacks.
(async function initAuth() {
    console.log('[Init] initAuth started');
    try {
        const { data: { session }, error } = await sb.auth.getSession();
        console.log('[Init] getSession returned:', { hasSession: !!session, hasUser: !!session?.user, error });

        if (error) {
            console.error('[Init] getSession error:', error);
        }
        if (session?.user) {
            console.log('[Init] User found in session:', session.user.email);
            currentUser = session.user;
            // Wait up to 3 seconds for onAuthStateChange to start the profile load
            let waited = 0;
            while (!profileLoadPromise && waited < 3000) {
                await new Promise(r => setTimeout(r, 50));
                waited += 50;
            }
            console.log('[Init] Waited for profileLoadPromise:', waited, 'ms. Exists?', !!profileLoadPromise);
            if (profileLoadPromise) {
                await profileLoadPromise.catch(e => console.error('[Init] Profile load error:', e));
                console.log('[Init] profileLoadPromise resolved');
            }
        } else {
            console.warn('[Init] No user in session. LocalStorage keys:', Object.keys(localStorage));
        }
    } catch (e) {
        console.error('[Init] initAuth CRITICAL error:', e);
    }
    console.log('[Init] Calling updateAuthUI() with currentUser:', !!currentUser);
    updateAuthUI();
})();




