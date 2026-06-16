// ============================================================================
// auth.js — Feature 7 (Supabase Google OAuth). Phase 4 Step C extraction.
// Loaded BEFORE script.js (ordered classic <script>), so these definitions
// are visible to script.js at runtime. Auth bypasses cleanly when Supabase is
// unconfigured (test-user-001 placeholder). Shared helpers ($, showToast, API)
// live in script.js and are only referenced here at call time (post-init).
// ============================================================================

// ==================== AUTH (Feature 7) ====================
const _AUTH_TOKEN_KEY = 'jarvis_auth_token';
let _authToken = null;
let _supabaseClient = null;

function getAuthHeaders() {
    return _authToken ? { 'Authorization': `Bearer ${_authToken}` } : {};
}

function _isTokenValid(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp > Date.now() / 1000;
    } catch { return false; }
}

function _showLoginOverlay() {
    const el = $('login-overlay');
    if (el) el.style.display = 'flex';
}

function _hideLoginOverlay() {
    const el = $('login-overlay');
    if (el) el.style.display = 'none';
}

function _showUserPill(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const email = payload.email || '';
        const shortEl = $('user-email-short');
        if (shortEl) shortEl.textContent = email.split('@')[0];
        const pill = $('user-pill');
        if (pill) pill.style.display = 'flex';
    } catch {}
}

async function _initAuth() {
    // Handle redirect from Supabase OAuth (token in URL hash)
    const hash = window.location.hash;
    if (hash.includes('access_token=')) {
        const params = new URLSearchParams(hash.substring(1));
        const token = params.get('access_token');
        if (token) {
            localStorage.setItem(_AUTH_TOKEN_KEY, token);
            _authToken = token;
            history.replaceState(null, '', window.location.pathname);
        }
    } else {
        _authToken = localStorage.getItem(_AUTH_TOKEN_KEY);
    }

    // Clear expired token
    if (_authToken && !_isTokenValid(_authToken)) {
        _authToken = null;
        localStorage.removeItem(_AUTH_TOKEN_KEY);
    }

    // Init Supabase client using backend-served config
    let _supabaseConfigured = false;
    try {
        const res = await fetch(`${API}/auth/config`);
        if (res.ok) {
            const cfg = await res.json();
            if (window.supabase && cfg.supabase_url && cfg.supabase_anon_key) {
                _supabaseClient = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
                _supabaseConfigured = true;
            }
        }
    } catch (e) {
        console.warn('[AUTH] Could not load Supabase config', e);
    }

    if (_authToken) {
        _hideLoginOverlay();
        _showUserPill(_authToken);
    } else if (!_supabaseConfigured) {
        // Supabase not configured — bypass login (uses test-user-001 placeholder until Feature 7)
        _hideLoginOverlay();
    } else {
        _showLoginOverlay();
    }
}

async function _signInWithGoogle() {
    if (!_supabaseClient) {
        showToast('Auth not configured — check Supabase setup.', 'error');
        return;
    }
    const { error } = await _supabaseClient.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) showToast('Sign-in failed: ' + error.message, 'error');
}

function _signOut() {
    _authToken = null;
    localStorage.removeItem(_AUTH_TOKEN_KEY);
    if (_supabaseClient) _supabaseClient.auth.signOut().catch(() => {});
    const pill = $('user-pill');
    if (pill) pill.style.display = 'none';
    _showLoginOverlay();
}
// ==================== END AUTH ====================

function _initAuthUI() {
    const googleBtn = $('google-signin-btn');
    if (googleBtn) googleBtn.addEventListener('click', _signInWithGoogle);
    const logoutBtn = $('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', _signOut);
}
