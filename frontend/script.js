const API = (typeof window !== 'undefined' && window.location.origin)
    ? window.location.origin
    : 'http://localhost:8000';

let sessionId = null;
let currentMode = 'jarvis';
let isStreaming = false;
let isListening = false;
let camStream = null;
let autoListenMode = false;
const SPEECH_ERROR_MAX_RETRIES = 15;
let speechErrorRetryCount = 0;
const SPEECH_SEND_DELAY_MS = 1800;
const SPEECH_RESTART_DELAY_MS = 700;
let speechSendTimeout = null;
let pendingSendTranscript = null;
let safariVoiceHintShown = false;
let orb = null;
let pendingAttachment = null; // { upload_id, filename, content_type, extracted_text }
let _attachmentInFlight = false; // true while processing a message that included an upload
let pendingYouTube = null;   // { video_id, url }
let currentQuiz = null;      // { questions[], currentIdx, score, contentEl }
let recognition = null;
let ttsPlayer = null;
let _speakAudio = null;
// True while Jarvis is producing speech. Used to mute speech recognition so the
// mic does not capture Jarvis's own voice and treat it as user input.
let _jarvisSpeaking = false;

function _onJarvisSpeechStart() {
    _jarvisSpeaking = true;
    if (isListening) {
        try { recognition && recognition.stop(); } catch (_) {}
    }
}

function _onJarvisSpeechEnd() {
    _jarvisSpeaking = false;
    maybeRestartListening();
}
let _ttsAudio = null;   // dedicated pre-unlocked element for inline TTS playback
const SETTINGS_KEY = 'jarvis_settings';
const DEFAULT_SETTINGS = { autoOpenActivity: true, autoOpenSearchResults: true, thinkingSounds: true, voiceInterrupt: true };
const PRE_STARTER_FILES = ['starter_1', 'starter_2', 'starter_3', 'starter_4', 'starter_5', 'starter_6', 'starter_7', 'starter_8', 'starter_9', 'starter_10'];
let PRE_STARTER_CACHE = {};
let settings = { ...DEFAULT_SETTINGS };
const $ = id => document.getElementById(id);
const chatMessages = $('chat-messages');
const messageInput = $('message-input');
const sendBtn      = $('send-btn');
const micBtn       = $('mic-btn');
const ttsBtn       = $('tts-btn');
const newChatBtn   = $('new-chat-btn');
const charCount    = $('char-count');
const welcomeTitle = $('welcome-title');
const modeSlider   = $('mode-slider');
const btnJarvis    = $('btn-jarvis');
const statusDot    = document.querySelector('.status-dot');
const statusText   = document.querySelector('.status-text');
const orbContainer = $('orb-container');
const searchResultsToggle = $('search-results-toggle');
const searchResultsWidget = $('search-results-widget');
const searchResultsClose  = $('search-results-close');
const searchResultsQuery  = $('search-results-query');
const searchResultsAnswer = $('search-results-answer');
const searchResultsList   = $('search-results-list');
const activityPanel       = $('activity-panel');
const activityToggle      = $('activity-toggle');
const activityClose       = $('activity-close');
const activityList        = $('activity-list');
const panelOverlay        = $('panel-overlay');
const speechWidget        = $('speech-widget');
const speechWidgetText    = $('speech-widget-text');
const settingsBtn         = $('settings-btn');
const camBtn              = $('cam-btn');
const camPanel            = $('cam-panel');
const camVideo            = $('cam-video');
const camCanvas           = $('cam-canvas');
const camVisionModeInput  = $('cam-vision-mode');
const camMinimize         = $('cam-minimize');
const camClose            = $('cam-close');
const camPanelHeader      = $('cam-panel-header');
const camPanelResize      = $('cam-panel-resize');
const settingsPanel       = $('settings-panel');
const settingsClose       = $('settings-close');
const toggleAutoActivity  = $('toggle-auto-activity');
const toggleAutoSearch    = $('toggle-auto-search');
const toggleThinkingSounds = $('toggle-thinking-sounds');
const toggleVoiceInterrupt = $('toggle-voice-interrupt');
const toastContainer     = $('toast-container');
const uploadBtn          = $('upload-btn');
const uploadInput        = $('upload-input');
const attachmentChips    = $('attachment-chips');

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

class PreStarterPlayer {
    constructor() {
        this.audio = document.createElement('audio');
        this.audio.preload = 'auto';
    }
    play(onComplete) {
        const loaded = PRE_STARTER_FILES.filter(f => PRE_STARTER_CACHE[f]);
        if (loaded.length === 0) {
            if (onComplete) onComplete();
            return;
        }
        const file = loaded[Math.floor(Math.random() * loaded.length)];
        const base64 = PRE_STARTER_CACHE[file];
        if (!base64) {
            if (onComplete) onComplete();
            return;
        }
        this.audio.src = 'data:audio/mp3;base64,' + base64;
        this.audio.currentTime = 0;
        let fired = false;
        const done = () => {
            if (fired) return;
            fired = true;
            this.audio.onended = null;
            this.audio.onerror = null;
            _onJarvisSpeechEnd();
            if (onComplete) onComplete();
        };
        this.audio.onended = done;
        this.audio.onerror = done;
        _onJarvisSpeechStart();
        const p = this.audio.play();
        if (p) p.catch(done);
    }
}

let preStarterPlayer = null;

// Browser speech fallback — speaks fullResponse when backend TTS returns no audio.
// Uses Web Speech API (built into every modern browser, no server needed).
function _browserSpeak(text) {
    if (!text || !window.speechSynthesis) return;
    if (ttsPlayer && !ttsPlayer.enabled) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text.slice(0, 4000));
    utter.lang = 'en-IN';
    utter.rate = 1.1;
    utter.onerror = e => console.warn('[TTS] speechSynthesis error:', e.error);
    const setVoice = () => {
        const voices = window.speechSynthesis.getVoices();
        const v = voices.find(x => x.lang === 'en-IN') || voices.find(x => x.lang.startsWith('en-IN')) || voices.find(x => x.lang.startsWith('en'));
        if (v) utter.voice = v;
        try {
            window.speechSynthesis.speak(utter);
            console.log('[TTS] speechSynthesis speaking, voice:', utter.voice ? utter.voice.name : 'default');
        } catch (e) {
            console.warn('[TTS] speechSynthesis.speak() threw:', e);
        }
    };
    if (window.speechSynthesis.getVoices().length > 0) { setVoice(); }
    else { window.speechSynthesis.onvoiceschanged = setVoice; }
}

// POST to /tts endpoint and play returned audio on the pre-unlocked element.
// Called from the per-message 🔊 button — guaranteed user gesture context.
async function speakText(btn, text) {
    if (!text) return;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    try {
        const res = await fetch(`${API}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ text: text.slice(0, 4000) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = _ttsAudio || new Audio();
        if (!audio.paused) audio.pause();
        audio.onended = () => { try { URL.revokeObjectURL(url); } catch (_) {} };
        audio.onerror = () => { try { URL.revokeObjectURL(url); } catch (_) {} _browserSpeak(text); };
        audio.src = url;
        audio.currentTime = 0;
        audio.play().catch(() => { _browserSpeak(text); });
    } catch (e) {
        console.warn('[speakText] backend failed:', e.message);
        _browserSpeak(text);
    } finally {
        if (btn) { setTimeout(() => { btn.disabled = false; btn.style.opacity = ''; }, 2000); }
    }
}

// Add a 🔊 speak button to a Jarvis message after the stream completes.
// This is the guaranteed fallback: button click = user gesture = audio always plays.
function addSpeakButton(contentEl, text) {
    if (!contentEl || !text) return;
    const existing = contentEl.querySelector('.msg-speak-btn');
    if (existing) existing.remove();
    const btn = document.createElement('button');
    btn.className = 'msg-speak-btn';
    btn.title = 'Read response aloud';
    btn.setAttribute('aria-label', 'Read response aloud');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
    btn.addEventListener('click', (e) => { e.preventDefault(); speakText(btn, text); });
    contentEl.appendChild(btn);
}

class TTSPlayer {
    constructor() {
        this.queue = [];
        this.playing = false;
        this.enabled = true;
        this.stopped = false;
        this._ctx = null;
        this._gainNode = null;
        this._currentSource = null;
        this._ctxUnlocked = false;
        this._didPlay = false;
    }
    _initCtx() {
        if (this._ctx && this._ctx.state !== 'closed') return;
        try {
            this._ctx = new (window.AudioContext || window.webkitAudioContext)();
            this._gainNode = this._ctx.createGain();
            this._gainNode.connect(this._ctx.destination);
        } catch (e) {
            this._ctx = null;
        }
    }
    unlock() {
        // Must be called from a user gesture to start/resume AudioContext
        this._initCtx();
        if (!this._ctx) return;
        if (this._ctx.state === 'suspended') {
            this._ctx.resume().catch(() => {});
        }
        if (!this._ctxUnlocked) {
            try {
                const buf = this._ctx.createBuffer(1, 1, this._ctx.sampleRate);
                const src = this._ctx.createBufferSource();
                src.buffer = buf;
                src.connect(this._ctx.destination);
                src.start(0);
                this._ctxUnlocked = true;
            } catch (_) {}
        }
    }
    enqueue(base64Audio) {
        if (!this.enabled) return;
        if (this.stopped) return;
        this.queue.push(base64Audio);
        if (!this.playing) this._playLoop();
    }
    stop() {
        this.stopped = true;
        if (this._currentSource) {
            try { this._currentSource.stop(0); } catch (_) {}
            this._currentSource = null;
        }
        this.queue = [];
        this.playing = false;
        if (ttsBtn) ttsBtn.classList.remove('tts-speaking');
        if (orbContainer) orbContainer.classList.remove('speaking');
        if (orb) orb.setActive(false);
        _onJarvisSpeechEnd();
        if (typeof this.onPlaybackComplete === 'function') this.onPlaybackComplete();
    }
    reset() {
        this.stop();
        this.stopped = false;
        this._didPlay = false;
        this._loopId = (this._loopId || 0) + 1;
    }
    async _playLoop() {
        if (this.playing) return;
        this.playing = true;
        _onJarvisSpeechStart();
        this._loopId = (this._loopId || 0) + 1;
        const myId = this._loopId;
        if (ttsBtn) ttsBtn.classList.add('tts-speaking');
        if (orbContainer) orbContainer.classList.add('speaking');
        if (orb) orb.setActive(true);
        while (this.queue.length > 0) {
            if (this.stopped || myId !== this._loopId) break;
            const b64 = this.queue.shift();
            try {
                await this._playB64(b64);
            } catch (e) {
                console.warn('[TTS] segment error:', e);
            }
        }
        if (myId !== this._loopId) { this.playing = false; _onJarvisSpeechEnd(); return; }
        this.playing = false;
        if (ttsBtn) ttsBtn.classList.remove('tts-speaking');
        if (orbContainer) orbContainer.classList.remove('speaking');
        if (orb) orb.setActive(false);
        _onJarvisSpeechEnd();
        if (typeof this.onPlaybackComplete === 'function') this.onPlaybackComplete();
    }
    _playB64(b64) {
        const ctxState = this._ctx ? this._ctx.state : 'none';
        if (this._ctx && this._ctx.state === 'running') {
            console.log('[TTS] playing via Web Audio, ctx:', ctxState);
            return this._playWebAudio(b64);
        }
        console.log('[TTS] playing via HTML Audio (ctx:', ctxState, ')');
        return this._playHTML(b64);
    }
    _playWebAudio(b64) {
        return new Promise(async (resolve) => {
            if (this.stopped) { resolve(); return; }
            try {
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                const audioBuf = await this._ctx.decodeAudioData(bytes.buffer.slice(0));
                if (this.stopped) { resolve(); return; }
                const src = this._ctx.createBufferSource();
                src.buffer = audioBuf;
                src.connect(this._gainNode);
                this._currentSource = src;
                src.onended = () => {
                    if (this._currentSource === src) this._currentSource = null;
                    resolve();
                };
                src.start(0);
                this._didPlay = true;
            } catch (e) {
                console.warn('[TTS] Web Audio failed, trying HTML:', e.message);
                await this._playHTML(b64).catch(() => {});
                resolve();
            }
        });
    }
    _playHTML(b64) {
        // Reuse the pre-unlocked _ttsAudio element — bypasses iframe autoplay restrictions.
        // A single element, once successfully played from a user gesture, stays unlocked
        // for all future play() calls on that same element even without a gesture.
        return new Promise(resolve => {
            try {
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                const blob = new Blob([bytes], { type: 'audio/mpeg' });
                const url = URL.createObjectURL(blob);
                const audio = _ttsAudio || new Audio();
                const done = () => { try { URL.revokeObjectURL(url); } catch (_) {} resolve(); };
                audio.onended = null;
                audio.onerror = null;
                audio.onended = done;
                audio.onerror = () => { console.warn('[TTS] HTML audio error'); done(); };
                if (!audio.paused) audio.pause();
                audio.src = url;
                audio.currentTime = 0;
                audio.play().then(() => { this._didPlay = true; }).catch(e => {
                    console.warn('[TTS] play() blocked:', e.name, '— audio element not yet unlocked');
                    done();
                });
            } catch (e) {
                console.warn('[TTS] _playHTML error:', e.message);
                resolve();
            }
        });
    }
}

function clearAttachment() {
    pendingAttachment = null;
    if (attachmentChips) { attachmentChips.innerHTML = ''; attachmentChips.style.display = 'none'; }
    if (uploadBtn) uploadBtn.classList.remove('upload-active');
    if (uploadInput) uploadInput.value = '';
}

function showAttachmentChip(filename) {
    if (!attachmentChips) return;
    attachmentChips.innerHTML = '';
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' +
        '<span class="chip-filename">' + escapeHtml(filename) + '</span>' +
        '<button class="chip-remove-btn" title="Remove attachment">×</button>';
    chip.querySelector('.chip-remove-btn').addEventListener('click', clearAttachment);
    attachmentChips.appendChild(chip);
    attachmentChips.style.display = 'flex';
    if (uploadBtn) uploadBtn.classList.add('upload-active');
}

async function uploadFile(file) {
    if (!file) return;
    showToast('Uploading ' + file.name + '…');
    const formData = new FormData();
    formData.append('file', file);
    if (sessionId) formData.append('session_id', sessionId);
    try {
        const res = await fetch(`${API}/upload`, { method: 'POST', headers: { ...getAuthHeaders() }, body: formData });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Upload failed (HTTP ${res.status})`);
        }
        const data = await res.json();
        pendingAttachment = {
            upload_id: data.upload_id,
            filename: data.filename,
            content_type: data.content_type,
            extracted_text: data.extracted_text,
        };
        showAttachmentChip(data.filename);
        showToast('File ready — send your message to use it.');
    } catch (err) {
        showToast(err.message || 'Upload failed. Please try again.', 6000);
        clearAttachment();
    }
}

function initUpload() {
    if (uploadBtn) uploadBtn.addEventListener('click', () => uploadInput && uploadInput.click());
    if (uploadInput) uploadInput.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        if (file) uploadFile(file);
    });
}

function init() {
    if (!chatMessages || !messageInput) {
        console.error('[JARVIS] Required DOM elements (chat-messages, message-input) not found.');
        return;
    }
    loadSettings();
    ttsPlayer = new TTSPlayer();
    ttsPlayer.onPlaybackComplete = maybeRestartListening;
    if (ttsBtn) ttsBtn.classList.add('tts-active');
    // Create shared audio elements — pre-unlocked on first user interaction.
    // A single HTMLAudioElement, once played from a user gesture, stays unlocked for
    // all future play() calls — even in iframes without allow="autoplay".
    _speakAudio = document.createElement('audio');
    _speakAudio.preload = 'auto';
    _ttsAudio = document.createElement('audio');
    _ttsAudio.preload = 'auto';
    const _silentWav = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    let _audioUnlocked = false;
    const _unlockAllAudio = () => {
        if (ttsPlayer) ttsPlayer.unlock();
        _speakAudio.src = _silentWav;
        _speakAudio.play().catch(() => {});
        // Unlock the dedicated TTS element once — after that, play() works without gesture
        if (!_audioUnlocked) {
            _audioUnlocked = true;
            _ttsAudio.src = _silentWav;
            _ttsAudio.play().then(() => {
                console.log('[TTS] _ttsAudio unlocked — auto-play will work');
            }).catch(() => {});
        }
    };
    document.addEventListener('click', _unlockAllAudio);
    document.addEventListener('keydown', _unlockAllAudio);
    document.addEventListener('touchstart', _unlockAllAudio);
    setGreeting();
    initOrb();
    initSpeech();
    preloadStarterAudio();
    preStarterPlayer = new PreStarterPlayer();
    checkHealth();
    bindEvents();
    initUpload();
    setMode(currentMode);
    autoResizeInput();
    _initAuthUI();
    _initAuth();
    _maybeStartWakeWord();
}

function _initAuthUI() {
    const googleBtn = $('google-signin-btn');
    if (googleBtn) googleBtn.addEventListener('click', _signInWithGoogle);
    const logoutBtn = $('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', _signOut);
}

async function preloadStarterAudio() {
    const base = (typeof window !== 'undefined' && window.location.origin) ? window.location.origin : '';
    for (const file of PRE_STARTER_FILES) {
        try {
            const r = await fetch(`${base}/app/audio/${file}.mp3`);
            if (!r.ok) continue;
            const blob = await r.blob();
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve((reader.result || '').split(',')[1] || '');
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            if (base64) PRE_STARTER_CACHE[file] = base64;
        } catch (_) {}
    }
}

function loadSettings() {
    try {
        const s = localStorage.getItem(SETTINGS_KEY);
        if (s) {
            const parsed = JSON.parse(s);
            settings = { ...DEFAULT_SETTINGS, ...parsed };
        }
        if (toggleAutoActivity) toggleAutoActivity.checked = settings.autoOpenActivity;
        if (toggleAutoSearch) toggleAutoSearch.checked = settings.autoOpenSearchResults;
        if (toggleThinkingSounds) toggleThinkingSounds.checked = settings.thinkingSounds;
        if (toggleVoiceInterrupt) toggleVoiceInterrupt.checked = settings.voiceInterrupt;
    } catch (_) {}
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {}
}


function setGreeting() {
    const h = new Date().getHours();
    let g = 'Good evening.';
    if (h < 12) g = 'Good morning.';
    else if (h < 17) g = 'Good afternoon.';
    else if (h >= 22) g = 'Burning the midnight oil?';
    if (welcomeTitle) welcomeTitle.textContent = g;
}

function initOrb() {
    if (typeof OrbRenderer === 'undefined') return;
    try {
        orb = new OrbRenderer(orbContainer, {
            hue: 0,
            hoverIntensity: 0.3,
            backgroundColor: [0.02, 0.02, 0.06]
        });
    } catch (e) { console.warn('Orb init failed:', e); }
}

function isSafariOrIOS() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
        (navigator.vendor && navigator.vendor.indexOf('Apple') > -1) ||
        (/Safari/.test(ua) && !/Chrome|Chromium|CriOS/.test(ua));
}

function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { micBtn.title = 'Speech not supported in this browser'; return; }
    recognition = new SR();
    const safariMode = isSafariOrIOS();
    recognition.continuous = true;
    recognition.interimResults = !safariMode;
    recognition.maxAlternatives = 3;
    recognition.lang = 'en-IN';
    recognition.onresult = e => {
        if (!e.results || e.results.length === 0) return;
        // Drop anything the mic captured while Jarvis was speaking — this is Jarvis's own voice.
        if (_jarvisSpeaking) {
            if (speechWidgetText) speechWidgetText.textContent = '';
            return;
        }
        const last = e.results[e.results.length - 1];
        // Pick the longest alternative transcript
        let transcript = '';
        for (let i = 0; i < (last ? last.length : 0); i++) {
            const alt = last[i] ? last[i].transcript.trim() : '';
            if (alt.length > transcript.length) transcript = alt;
        }
        const isFinal = last && last.isFinal;
        if (speechWidgetText) speechWidgetText.textContent = transcript;
        if (speechWidget) speechWidget.classList.add('visible');
        if (settings.voiceInterrupt && ttsPlayer && ttsPlayer.playing && transcript.length > 0) {
            ttsPlayer.stop();
            ttsPlayer.stopped = false;
        }
        if (isFinal && transcript) {
            // Intercept voice control commands — handle locally, never send to backend
            if (VOICE_STOP_COMMANDS.test(transcript)) {
                if (ttsPlayer) { ttsPlayer.stop(); ttsPlayer.stopped = false; }
                pendingSendTranscript = null;
                clearTimeout(speechSendTimeout);
                speechSendTimeout = null;
                if (speechWidget) speechWidget.classList.remove('visible');
                if (speechWidgetText) speechWidgetText.textContent = '';
                stopListening();
                return;
            }
            // Ignore noise/very-short transcripts (ambient sound, breath, etc.)
            if (transcript.length < 2) return;
            pendingSendTranscript = transcript;
            clearTimeout(speechSendTimeout);
            speechSendTimeout = setTimeout(() => {
                if (pendingSendTranscript) {
                    sendMessage(pendingSendTranscript);
                    pendingSendTranscript = null;
                }
                speechSendTimeout = null;
                stopListening();
            }, SPEECH_SEND_DELAY_MS);
        } else if (!isFinal) {
            pendingSendTranscript = null;
            clearTimeout(speechSendTimeout);
            speechSendTimeout = null;
        }
    };

    recognition.onstart = () => { speechErrorRetryCount = 0; };
    recognition.onerror = e => {
        const msg = (e && e.error) ? String(e.error) : '';
        // "no-speech" is completely normal — user was quiet. Restart silently without counting retries.
        if (msg === 'no-speech') {
            stopListening();
            if (autoListenMode && !isStreaming) {
                setTimeout(() => maybeRestartListening(), SPEECH_RESTART_DELAY_MS);
            }
            return;
        }
        stopListening();
        const isPermissionDenied = /denied|not-allowed|permission/i.test(msg);
        if (isPermissionDenied && micBtn) {
            micBtn.title = 'Microphone access denied. Allow in browser settings.';
            speechErrorRetryCount = SPEECH_ERROR_MAX_RETRIES;
        }
        if (autoListenMode && !isStreaming && !isPermissionDenied) {
            if (speechErrorRetryCount >= SPEECH_ERROR_MAX_RETRIES) speechErrorRetryCount = 0;
            speechErrorRetryCount++;
            const delay = Math.min(SPEECH_RESTART_DELAY_MS * speechErrorRetryCount, 5000);
            setTimeout(() => maybeRestartListening(), delay);
        } else if (speechErrorRetryCount >= SPEECH_ERROR_MAX_RETRIES && micBtn) {
            micBtn.title = 'Voice input — click to try again';
        }
    };

    recognition.onend = () => {
        if (pendingSendTranscript) {
            clearTimeout(speechSendTimeout);
            speechSendTimeout = null;
            sendMessage(pendingSendTranscript);
            pendingSendTranscript = null;
        } else {
            clearTimeout(speechSendTimeout);
            speechSendTimeout = null;
        }
        if (isListening) stopListening();
        maybeRestartListening();
    };
}

function startListening() {
    if (!recognition || isStreaming || isListening) return;
    if (isSafariOrIOS() && !safariVoiceHintShown) {
        showToast('Voice works best in Chrome. Safari has limited support.');
        safariVoiceHintShown = true;
    }
    isListening = true;
    pendingSendTranscript = null;
    clearTimeout(speechSendTimeout);
    speechSendTimeout = null;
    if (micBtn) micBtn.classList.add('listening');
    if (speechWidget) speechWidget.classList.add('visible');
    if (speechWidgetText) speechWidgetText.textContent = '';
    try {
        recognition.start();
    } catch (err) {
        isListening = false;
        if (micBtn) micBtn.classList.remove('listening');
        if (speechWidget) speechWidget.classList.remove('visible');
        // Recreate recognition to fix broken state (e.g. after task opens a new tab)
        recognition = null;
        initSpeech();
        if (isSafariOrIOS()) showToast('Tap the mic to continue voice input.');
    }
}

function stopListening() {
    clearTimeout(speechSendTimeout);
    speechSendTimeout = null;
    pendingSendTranscript = null;
    isListening = false;
    if (micBtn) micBtn.classList.remove('listening');
    if (speechWidget) speechWidget.classList.remove('visible');
    if (speechWidgetText) speechWidgetText.textContent = '';
    try { recognition.stop(); } catch (_) {}
}

function maybeRestartListening() {
    if (!recognition) return;
    if (isStreaming) return;
    // Never restart while Jarvis is speaking — mic would capture Jarvis's own voice.
    // _onJarvisSpeechEnd() calls this function again once TTS finishes.
    if (_jarvisSpeaking) return;
    const ttsActive = ttsPlayer && (ttsPlayer.playing || ttsPlayer.queue.length > 0);
    if (ttsActive) return;
    if (!autoListenMode) return;
    setTimeout(() => {
        if (autoListenMode && !isStreaming && !isListening && recognition && !_jarvisSpeaking) {
            startListening();
        }
    }, SPEECH_RESTART_DELAY_MS);
}

const CAM_BYPASS_TOKEN = 'TTCAMTOKENTT';
const CAMERA_QUERY_PATTERNS = [
    /what\s+(can|do)\s+you\s+see/i,
    /can\s+you\s+see/i,
    /describe\s+(what\s+you\s+see|this|the\s+image)/i,
    /what('s|is)\s+in\s+(this\s+)?(picture|image)/i,
    /what\s+do\s+i\s+look\s+like/i,
    /what\s+(am\s+i\s+)?holding/i,
    /show\s+me\s+what\s+you\s+see/i,
];

// Voice control commands that should be handled locally, never sent to the backend
const VOICE_STOP_COMMANDS = /^(stop|stop jarvis|stop it|quiet|be quiet|cancel|never mind|nevermind|silence|enough|stop talking|stop speaking|ok stop|okay stop|that'?s enough|shut up|pause)\.?[!.?]?$/i;

// Maps spoken words → option index (0=A, 1=B, 2=C, 3=D)
const VOICE_QUIZ_ANSWERS = {
    'a': 0, 'option a': 0, 'answer a': 0, 'choose a': 0, 'select a': 0, 'jarvis a': 0,
    'jarvis option a': 0, 'pick a': 0, 'go with a': 0, 'i pick a': 0, 'i choose a': 0,
    'b': 1, 'option b': 1, 'answer b': 1, 'choose b': 1, 'select b': 1, 'jarvis b': 1,
    'jarvis option b': 1, 'pick b': 1, 'go with b': 1, 'i pick b': 1, 'i choose b': 1,
    'c': 2, 'option c': 2, 'answer c': 2, 'choose c': 2, 'select c': 2, 'jarvis c': 2,
    'jarvis option c': 2, 'pick c': 2, 'go with c': 2, 'i pick c': 2, 'i choose c': 2,
    'd': 3, 'option d': 3, 'answer d': 3, 'choose d': 3, 'select d': 3, 'jarvis d': 3,
    'jarvis option d': 3, 'pick d': 3, 'go with d': 3, 'i pick d': 3, 'i choose d': 3,
    'first': 0, 'option one': 0, 'option 1': 0, 'one': 0,
    'second': 1, 'option two': 1, 'option 2': 1, 'two': 1,
    'third': 2, 'option three': 2, 'option 3': 2, 'three': 2,
    'fourth': 3, 'option four': 3, 'option 4': 3, 'four': 3,
};

function isCameraQuery(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim().toLowerCase();
    return CAMERA_QUERY_PATTERNS.some(r => r.test(t)) ||
        (t.includes('see') && (t.includes('what') || t.includes('describe')));
}

function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast('Camera not supported in this browser.');
        return Promise.reject(new Error('Camera not supported'));
    }
    if (camStream) return Promise.resolve();
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
        .then(stream => {
            camStream = stream;
            if (camVideo) camVideo.srcObject = stream;
            if (camPanel) { camPanel.classList.add('visible'); camPanel.setAttribute('aria-hidden', 'false'); }
            if (camBtn) {
                camBtn.classList.add('cam-active');
                camBtn.title = 'Camera on — click to turn off';
                const icon = camBtn.querySelector('.cam-icon');
                const iconActive = camBtn.querySelector('.cam-icon-active');
                if (icon) icon.style.display = 'none';
                if (iconActive) iconActive.style.display = '';
            }
        })
        .catch(err => {
            showToast('Camera access denied. ' + (err.message || ''));
            throw err;
        });
}

function stopCamera() {
    if (camStream) {
        camStream.getTracks().forEach(t => t.stop());
        camStream = null;
    }
    if (camVideo) camVideo.srcObject = null;
    if (camPanel) { camPanel.classList.remove('visible'); camPanel.setAttribute('aria-hidden', 'true'); }
    if (camVisionModeInput) camVisionModeInput.checked = false;
    if (camBtn) {
        camBtn.classList.remove('cam-active');
        camBtn.title = 'Camera — capture and send for vision';
        const icon = camBtn.querySelector('.cam-icon');
        const iconActive = camBtn.querySelector('.cam-icon-active');
        if (icon) icon.style.display = '';
        if (iconActive) iconActive.style.display = 'none';
    }
}

function initCameraPanel() {
    if (!camPanel) return;
    let dragStart = { x: 0, y: 0, left: 0, top: 0 };
    let resizeStart = { x: 0, y: 0, w: 0, h: 0 };
    if (camClose) camClose.addEventListener('click', () => stopCamera());
    if (camMinimize) camMinimize.addEventListener('click', () => {
        camPanel.classList.toggle('minimized');
    });
    if (camPanelHeader) {
        camPanelHeader.addEventListener('mousedown', (e) => {
            if (e.target.closest('.cam-panel-btn, .cam-panel-vision-mode')) return;
            e.preventDefault();
            const r = camPanel.getBoundingClientRect();
            dragStart = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
            const onMove = (ev) => {
                const dx = ev.clientX - dragStart.x;
                const dy = ev.clientY - dragStart.y;
                camPanel.style.left = (dragStart.left + dx) + 'px';
                camPanel.style.top = (dragStart.top + dy) + 'px';
                camPanel.style.right = 'auto';
                camPanel.style.bottom = 'auto';
            };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }
    if (camPanelResize) {
        camPanelResize.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const r = camPanel.getBoundingClientRect();
            resizeStart = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
            const onMove = (ev) => {
                const dw = ev.clientX - resizeStart.x;
                const dh = ev.clientY - resizeStart.y;
                const nw = Math.max(200, Math.min(window.innerWidth, resizeStart.w + dw));
                const nh = Math.max(150, Math.min(window.innerHeight * 0.7, resizeStart.h + dh));
                camPanel.style.width = nw + 'px';
                camPanel.style.height = nh + 'px';
            };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }
    camPanel.addEventListener('dblclick', (e) => {
        if (e.target.closest('.cam-panel-header') && !e.target.closest('.cam-panel-btn, .cam-panel-vision-mode')) {
            camPanel.classList.toggle('minimized');
        }
    });
    camPanel.querySelector('.cam-panel-body')?.addEventListener('click', (e) => {
        if (camPanel.classList.contains('minimized')) camPanel.classList.remove('minimized');
    });
}

function handleActions(actions, contentEl) {
    if (!actions) return;
    if (!contentEl) return;
    const safeOpen = url => {
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            try {
                const w = window.open(url, '_blank', 'noopener');
                if (!w) showToast('Pop-up blocked. Please allow pop-ups or copy the URL.');
            } catch (_) {
                showToast('Could not open link. Please try again.');
            }
        }
    };
    (actions.wopens || []).forEach(safeOpen);
    (actions.plays || []).forEach(safeOpen);
    (actions.googlesearches || []).forEach(safeOpen);
    (actions.youtubesearches || []).forEach(safeOpen);
    if (actions.images && actions.images.length > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'msg-actions-images';
        actions.images.forEach(url => {
            const img = document.createElement('img');
            img.src = url;
            img.alt = 'Generated image';
            img.className = 'msg-action-image';
            img.loading = 'lazy';
            img.onerror = () => {
                img.style.display = 'none';
                const fallback = document.createElement('div');
                fallback.className = 'msg-action-image-fallback';
                fallback.textContent = 'Image failed to load.';
                wrap.appendChild(fallback);
            };
            wrap.appendChild(img);
        });
        contentEl.appendChild(wrap);
    }
    if (actions.contents && actions.contents.length > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'msg-actions-contents';
        actions.contents.forEach(t => {
            const p = document.createElement('div');
            p.className = 'msg-action-content';
            p.textContent = t;
            wrap.appendChild(p);
        });
        contentEl.appendChild(wrap);
    }
    if (actions.cam && !_attachmentInFlight) {
        if (actions.cam.action === 'open') {
            startCamera();
        } else if (actions.cam.action === 'close') {
            stopCamera();
        } else if (actions.cam.action === 'open_and_capture') {
            const resendMsg = actions.cam.resend_message || 'What do you see?';
            (async () => {
                try {
                    await startCamera();
                    await new Promise((resolve) => {
                        if (!camVideo) { resolve(); return; }
                        if (camVideo.readyState >= 2 && camVideo.videoWidth > 0) {
                            setTimeout(resolve, 500);
                            return;
                        }
                        const onReady = () => {
                            camVideo.removeEventListener('loadeddata', onReady);
                            clearTimeout(t);
                            setTimeout(resolve, 600);
                        };
                        const t = setTimeout(() => {
                            camVideo.removeEventListener('loadeddata', onReady);
                            resolve();
                        }, 4000);
                        camVideo.addEventListener('loadeddata', onReady);
                    });
                    const frame = await captureFrameAsBase64Safe();
                    if (frame) {
                        sendMessageWithImage(resendMsg, frame);
                    } else {
                        showToast('Could not capture camera frame. Please try again.');
                    }
                } catch (err) {
                    showToast('Camera access denied.');
                }
            })();
        }
    }
}

function handleBackgroundTasks(tasks, contentEl) {
    if (!tasks || !tasks.length || !contentEl) return;
    tasks.forEach(task => {
        const card = document.createElement('div');
        card.className = 'bg-task-card';
        card.dataset.taskId = task.task_id;
        const label = task.type === 'generate image' ? 'Image Generation' : task.type === 'content' ? 'Content Writing' : task.type;
        const promptText = task.label ? `"${task.label}"` : '';
        card.innerHTML =
            '<div class="bg-task-header">' +
                '<div class="bg-task-spinner"></div>' +
                '<span class="bg-task-label">' + label + '</span>' +
                '<span class="bg-task-status">Working...</span>' +
            '</div>' +
            (promptText ? '<div class="bg-task-prompt">' + promptText + '</div>' : '');
        contentEl.appendChild(card);
        scrollToBottom();
        pollBackgroundTask(task.task_id, card);
    });
}

function pollBackgroundTask(taskId, cardEl) {
    let pollCount = 0;
    const maxPolls = 120;
    const interval = setInterval(() => {
        pollCount++;
        if (pollCount > maxPolls) {
            clearInterval(interval);
            updateTaskCard(cardEl, 'failed', 'Timed out');
            return;
        }
        fetch(`${API}/tasks/${encodeURIComponent(taskId)}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                if (data.status === 'completed') {
                    clearInterval(interval);
                    updateTaskCard(cardEl, 'completed', data);
                } else if (data.status === 'failed') {
                    clearInterval(interval);
                    updateTaskCard(cardEl, 'failed', data.error || 'Task failed');
                }
            })
            .catch(() => {  });
    }, 1500);
}

function updateTaskCard(cardEl, status, data) {
    if (!cardEl) return;
    const spinner = cardEl.querySelector('.bg-task-spinner');
    const statusEl = cardEl.querySelector('.bg-task-status');
    if (status === 'completed') {
        if (spinner) spinner.className = 'bg-task-done-icon';
        if (statusEl) statusEl.textContent = 'Ready!';
        cardEl.classList.add('bg-task-done');
        const viewBtn = document.createElement('button');
        viewBtn.className = 'bg-task-view-btn';
        viewBtn.textContent = 'Open in new tab';
        viewBtn.addEventListener('click', () => {
            const taskId = cardEl.dataset.taskId;
            window.open(`${window.location.origin}/app/viewer.html?task_id=${taskId}`, '_blank');
        });
        cardEl.appendChild(viewBtn);
        try {
            const taskId = cardEl.dataset.taskId;
            const w = window.open(`${window.location.origin}/app/viewer.html?task_id=${taskId}`, '_blank');
            if (!w) {
                showToast('Result ready! Click "Open in new tab" to view.');
            }
        } catch (_) {  }
    } else if (status === 'failed') {
        if (spinner) spinner.className = 'bg-task-fail-icon';
        if (statusEl) statusEl.textContent = typeof data === 'string' ? data : 'Failed';
        cardEl.classList.add('bg-task-failed');
    }
    scrollToBottom();
}

function captureFrameAsBase64() {
    if (!camVideo || !camStream || camVideo.readyState < 2) return null;
    if (!camCanvas) return null;
    const w = camVideo.videoWidth;
    const h = camVideo.videoHeight;
    if (!w || !h || w < 64 || h < 64) return null;
    camCanvas.width = w;
    camCanvas.height = h;
    const ctx = camCanvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(camVideo, 0, 0, w, h);
    try {
        return camCanvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    } catch (_) {
        return null;
    }
}

async function captureFrameAsBase64Safe() {
    if (!camVideo || !camStream || !camCanvas) return null;
    return new Promise((resolve) => {
        const doCapture = () => {
            const w = camVideo.videoWidth;
            const h = camVideo.videoHeight;
            if (!w || !h || w < 64 || h < 64) {
                resolve(null);
                return;
            }
            camCanvas.width = w;
            camCanvas.height = h;
            const ctx = camCanvas.getContext('2d');
            if (!ctx) { resolve(null); return; }
            ctx.drawImage(camVideo, 0, 0, w, h);
            try {
                const b64 = camCanvas.toDataURL('image/jpeg', 0.9).split(',')[1];
                resolve(b64);
            } catch (_) {
                resolve(null);
            }
        };
        if (camVideo.readyState < 2) {
            const onReady = () => { camVideo.removeEventListener('loadeddata', onReady); doCapture(); };
            camVideo.addEventListener('loadeddata', onReady);
            setTimeout(() => { camVideo.removeEventListener('loadeddata', onReady); doCapture(); }, 3000);
            return;
        }
        const w = camVideo.videoWidth;
        const h = camVideo.videoHeight;
        if (w && h && w >= 64 && h >= 64) {
            if (typeof camVideo.requestVideoFrameCallback === 'function') {
                camVideo.requestVideoFrameCallback(() => { doCapture(); });
            } else {
                setTimeout(doCapture, 150);
            }
        } else {
            setTimeout(() => {
                const w2 = camVideo.videoWidth || 0;
                const h2 = camVideo.videoHeight || 0;
                if (w2 && h2 && w2 >= 64 && h2 >= 64) doCapture();
                else resolve(null);
            }, 300);
        }
    });
}

async function sendMessageWithImage(text, imgBase64) {
    if (!text || !imgBase64 || isStreaming) return;
    const messageToSend = text + ' ' + CAM_BYPASS_TOKEN;
    addMessage('user', text);
    addTypingIndicator();
    isStreaming = true;
    if (sendBtn) sendBtn.disabled = true;
    if (messageInput) messageInput.disabled = true;
    if (orbContainer) orbContainer.classList.add('active');
    if (ttsPlayer) { ttsPlayer.reset(); ttsPlayer.unlock(); }
    let timeoutId = null;
    const controller = new AbortController();
    try {
        timeoutId = setTimeout(() => controller.abort(), 300000);
        const _ttsFlag2 = !!(ttsPlayer && ttsPlayer.enabled);
        let _ttsGotAudio2 = false;
        console.log('[TTS] sending vision request — tts:', _ttsFlag2, '| player:', !!ttsPlayer, '| enabled:', ttsPlayer?.enabled);
        const res = await fetch(`${API}/chat/jarvis/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                message: messageToSend,
                session_id: sessionId,
                tts: _ttsFlag2,
                imgbase64: imgBase64,
            }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        removeTypingIndicator();
        const contentEl = addMessage('assistant', '');
        contentEl.innerHTML = '<span class="msg-stream-text">...</span>';
        scrollToBottom();
        if (!res.body) throw new Error('No response body');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let fullResponse = '';
        let cursorEl = null;
        let streamDone = false;
        while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n\n');
            sseBuffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.session_id) sessionId = data.session_id;
                    if (data.activity) {
                        appendActivity(data.activity);
                        if (activityToggle) activityToggle.style.display = '';
                        if (activityPanel && settings.autoOpenActivity) { activityPanel.classList.add('open'); updatePanelOverlay(); }
                    }
                    if (data.actions) handleActions(data.actions, contentEl);
                    if (data.background_tasks) handleBackgroundTasks(data.background_tasks, contentEl);
                    if ('chunk' in data) {
                        const chunkText = data.chunk || '';
                        fullResponse += chunkText;
                        const textSpan = contentEl.querySelector('.msg-stream-text');
                        if (textSpan) {
                            textSpan.textContent = fullResponse;
                            textSpan.classList.remove('stream-placeholder');
                        }
                        if (!cursorEl) {
                            cursorEl = document.createElement('span');
                            cursorEl.className = 'stream-cursor';
                            cursorEl.textContent = '|';
                            contentEl.appendChild(cursorEl);
                        }
                        scrollToBottom();
                    }
                    if ('audio' in data) {
                        if (data.audio && ttsPlayer) {
                            console.log('[TTS] audio received, size:', data.audio.length, '| enabled:', ttsPlayer.enabled, '| ctx:', ttsPlayer._ctx ? ttsPlayer._ctx.state : 'null');
                            ttsPlayer.enqueue(data.audio);
                            _ttsGotAudio2 = true;
                        } else {
                            console.warn('[TTS] audio event arrived but empty — backend TTS likely failed. ttsPlayer:', !!ttsPlayer, 'enabled:', ttsPlayer?.enabled);
                        }
                    }
                    if (data.error) throw new Error(data.error);
                    if (data.done) { streamDone = true; break; }
                } catch (parseErr) {
                    if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
                }
            }
            if (streamDone) break;
        }
        if (cursorEl) cursorEl.remove();
        addSpeakButton(contentEl, fullResponse);
        if (_ttsFlag2 && fullResponse) {
            if (!_ttsGotAudio2) {
                console.log('[TTS] no backend audio — browser speechSynthesis fallback');
                _browserSpeak(fullResponse);
            } else {
                const _savedResp2 = fullResponse;
                setTimeout(() => {
                    if (ttsPlayer && !ttsPlayer._didPlay) {
                        console.log('[TTS] audio not playing after 3s — browser fallback (vision)');
                        _browserSpeak(_savedResp2);
                    }
                }, 3000);
            }
        }
        const textSpan = contentEl.querySelector('.msg-stream-text');
        if (textSpan && !fullResponse) textSpan.textContent = '(No response)';
    } catch (err) {
        clearTimeout(timeoutId);
        removeTypingIndicator();
        addMessage('assistant', 'Something went wrong analyzing the image. Please try again.');
    } finally {
        clearTimeout(timeoutId);
        isStreaming = false;
        if (sendBtn) sendBtn.disabled = false;
        if (messageInput) messageInput.disabled = false;
        if (orbContainer) orbContainer.classList.remove('active');
    }
}

async function checkHealth() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const r = await fetch(`${API}/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
        const d = await r.json().catch(() => null);
        const ok = d && (d.status === 'healthy' || d.status === 'degraded');
        if (statusDot) statusDot.classList.toggle('offline', !ok);
        if (statusText) statusText.textContent = ok ? 'Online' : 'Offline';
    } catch (e) {
        if (statusDot) statusDot.classList.add('offline');
        if (statusText) statusText.textContent = 'Offline';
        if (typeof console !== 'undefined' && console.warn) console.warn('[Health] Check failed:', e);
    }
}

function showToast(msg, durationMs = 5000) {
    if (!toastContainer || !msg) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    toastContainer.appendChild(el);
    el.offsetHeight;
    el.classList.add('toast-visible');
    const t = setTimeout(() => {
        el.classList.remove('toast-visible');
        setTimeout(() => el.remove(), 300);
    }, durationMs);
    el.addEventListener('click', () => { clearTimeout(t); el.classList.remove('toast-visible'); setTimeout(() => el.remove(), 300); });
}

function bindEvents() {
    if (sendBtn) sendBtn.addEventListener('click', () => { if (!isStreaming) sendMessage(); });
    if (messageInput) messageInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isStreaming) sendMessage(); }
    });
    if (messageInput) messageInput.addEventListener('input', () => {
        autoResizeInput();
        const len = messageInput.value.length;
        if (charCount) charCount.textContent = len > 100 ? `${len.toLocaleString()} / 32,000` : '';
    });
    if (camBtn) camBtn.addEventListener('click', () => {
        if (camStream) stopCamera();
        else startCamera();
    });
    initCameraPanel();
    if (micBtn) micBtn.addEventListener('click', () => {
        if (isListening) {
            autoListenMode = false;
            stopListening();
            if (micBtn) micBtn.classList.remove('auto-listen');
        } else {
            autoListenMode = true;
            speechErrorRetryCount = 0;
            if (micBtn) {
                micBtn.classList.add('auto-listen');
                micBtn.title = 'Voice input — click to stop auto-listen';
            }
            startListening();
        }
    });
    if (ttsBtn) ttsBtn.addEventListener('click', () => {
        if (ttsPlayer) ttsPlayer.enabled = !ttsPlayer.enabled;
        ttsBtn.classList.toggle('tts-active', ttsPlayer && ttsPlayer.enabled);
        if (ttsPlayer && !ttsPlayer.enabled) ttsPlayer.stop();
    });
    if (newChatBtn) newChatBtn.addEventListener('click', newChat);
    if (btnJarvis) btnJarvis.addEventListener('click', () => setMode('jarvis'));
    document.querySelectorAll('.chip').forEach(c => {
        c.addEventListener('click', () => { if (!isStreaming) sendMessage(c.dataset.msg); });
    });
    if (searchResultsToggle) {
        searchResultsToggle.addEventListener('click', () => {
            if (searchResultsWidget) { searchResultsWidget.classList.toggle('open'); updatePanelOverlay(); }
        });
    }
    if (searchResultsClose && searchResultsWidget) {
        searchResultsClose.addEventListener('click', () => { searchResultsWidget.classList.remove('open'); updatePanelOverlay(); });
    }
    if (activityToggle) {
        activityToggle.addEventListener('click', () => {
            if (activityPanel) { activityPanel.classList.toggle('open'); updatePanelOverlay(); }
        });
    }
    if (activityClose && activityPanel) {
        activityClose.addEventListener('click', () => { activityPanel.classList.remove('open'); updatePanelOverlay(); });
    }
    if (settingsBtn && settingsPanel) {
        settingsBtn.addEventListener('click', () => {
            settingsPanel.classList.toggle('open');
            updatePanelOverlay();
        });
    }
    if (settingsClose && settingsPanel) {
        settingsClose.addEventListener('click', () => {
            settingsPanel.classList.remove('open');
            updatePanelOverlay();
        });
    }
    if (toggleAutoActivity) {
        toggleAutoActivity.addEventListener('change', () => {
            settings.autoOpenActivity = toggleAutoActivity.checked;
            saveSettings();
        });
    }
    if (toggleAutoSearch) {
        toggleAutoSearch.addEventListener('change', () => {
            settings.autoOpenSearchResults = toggleAutoSearch.checked;
            saveSettings();
        });
    }
    if (toggleThinkingSounds) {
        toggleThinkingSounds.addEventListener('change', () => {
            settings.thinkingSounds = toggleThinkingSounds.checked;
            saveSettings();
        });
    }
    if (toggleVoiceInterrupt) {
        toggleVoiceInterrupt.addEventListener('change', () => {
            settings.voiceInterrupt = toggleVoiceInterrupt.checked;
            saveSettings();
        });
    }
}


function autoResizeInput() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
}

function updatePanelOverlay() {
    if (!panelOverlay) return;
    const lecturesPanel = $('lectures-panel');
    const anyOpen = (activityPanel && activityPanel.classList.contains('open')) ||
        (searchResultsWidget && searchResultsWidget.classList.contains('open')) ||
        (settingsPanel && settingsPanel.classList.contains('open')) ||
        (lecturesPanel && lecturesPanel.classList.contains('open'));
    panelOverlay.classList.toggle('visible', !!anyOpen);
}

function setMode(mode) {
    currentMode = mode || 'jarvis';
    if (btnJarvis) btnJarvis.classList.add('active');
    if (modeSlider) modeSlider.classList.remove('center', 'right');
    if (activityToggle) activityToggle.style.display = '';
}

function newChat() {
    if (ttsPlayer) ttsPlayer.stop();
    if (camStream) stopCamera();
    clearAttachment();
    sessionId = null;
    pendingYouTube = null;
    currentQuiz = null;
    if (chatMessages) chatMessages.innerHTML = '';
    chatMessages.appendChild(createWelcome());
    messageInput.value = '';
    autoResizeInput();
    setGreeting();
    if (searchResultsWidget) searchResultsWidget.classList.remove('open');
    if (searchResultsToggle) searchResultsToggle.style.display = 'none';
    if (activityPanel) activityPanel.classList.remove('open');
    if (settingsPanel) settingsPanel.classList.remove('open');
    if (activityToggle) activityToggle.style.display = 'none';
    if (activityList) {
        activityList.innerHTML = '<div class="activity-empty" id="activity-empty">Send a message to see the flow here.</div>';
    }
    updatePanelOverlay();
}

function createWelcome() {
    const h = new Date().getHours();
    let g = 'Good evening.';
    if (h < 12) g = 'Good morning.';
    else if (h < 17) g = 'Good afternoon.';
    else if (h >= 22) g = 'Burning the midnight oil?';
    const div = document.createElement('div');
    div.className = 'welcome-screen';
    div.id = 'welcome-screen';
    div.innerHTML = `
        <div class="welcome-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        </div>
        <h2 class="welcome-title">${g}</h2>
        <p class="welcome-sub">How may I assist you today?</p>
        <div class="welcome-chips">
            <button class="chip" data-msg="What can you do?">What can you do?</button>
            <button class="chip" data-msg="Open YouTube for me">Open YouTube</button>
            <button class="chip" data-msg="Tell me a fun fact">Fun fact</button>
            <button class="chip" data-msg="Play some music">Play music</button>
        </div>`;
    div.querySelectorAll('.chip').forEach(c => {
        c.addEventListener('click', () => { if (!isStreaming) sendMessage(c.dataset.msg); });
    });
    return div;
}

function isUrlLike(str) {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim();
    return s.length > 40 && (/^https?:\/\//i.test(s));
}

function friendlyUrlLabel(url) {
    if (!url || typeof url !== 'string') return 'View source';
    try {
        const u = new URL(url.startsWith('http') ? url : 'https://' + url);
        const host = u.hostname.replace(/^www\./, '');
        const path = u.pathname !== '/' ? u.pathname.slice(0, 20) + (u.pathname.length > 20 ? '…' : '') : '';
        return path ? host + path : host;
    } catch (_) {
        return url.length > 40 ? url.slice(0, 37) + '…' : url;
    }
}

function truncateSnippet(text, maxLen) {
    if (!text || typeof text !== 'string') return '';
    const t = text.trim();
    if (t.length <= maxLen) return t;
    return t.slice(0, maxLen).trim() + '…';
}

function renderSearchResults(payload) {
    if (!payload) return;
    if (searchResultsQuery) searchResultsQuery.textContent = (payload.query || '').trim() || 'Search';
    if (searchResultsAnswer) searchResultsAnswer.textContent = (payload.answer || '').trim() || '';
    if (!searchResultsList) return;
    searchResultsList.innerHTML = '';
    const results = payload.results || [];
    const maxContentLen = 220;
    for (const r of results) {
        let title = (r.title || '').trim();
        let content = (r.content || '').trim();
        const url = (r.url || '').trim();
        if (isUrlLike(title)) title = friendlyUrlLabel(url) || 'Source';
        if (!title) title = friendlyUrlLabel(url) || 'Source';
        if (isUrlLike(content)) content = '';
        content = truncateSnippet(content, maxContentLen);
        const score = r.score != null ? Math.round((r.score || 0) * 100) : null;
        const card = document.createElement('div');
        card.className = 'search-result-card';
        const urlDisplay = url ? escapeHtml(friendlyUrlLabel(url)) : '';
        const hrefSafe = safeUrlForHref(url);
        const urlMarkup = urlDisplay
            ? (hrefSafe ? `<a href="${hrefSafe}" target="_blank" rel="noopener" class="card-url" title="${escapeAttr(url)}">${urlDisplay}</a>` : `<span class="card-url">${urlDisplay}</span>`)
            : '';
        card.innerHTML = `
            <div class="card-title">${escapeHtml(title)}</div>
            ${content ? `<div class="card-content">${escapeHtml(content)}</div>` : ''}
            ${urlMarkup}
            ${score != null ? `<div class="card-score">Relevance: ${escapeHtml(String(score))}%</div>` : ''}`;
        searchResultsList.appendChild(card);
    }
}

function safeUrlForHref(url) {
    if (!url || typeof url !== 'string') return '';
    const u = url.trim();
    if (u.startsWith('https://') || u.startsWith('http://')) return escapeAttr(u);
    return '';
}

function escapeAttr(str) {
    if (typeof str !== 'string') return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

const ACTIVITY_STEPS = {
    query_detected:      { step: 1, label: 'Query detected' },
    decision:            { step: 2, label: 'Primary Brain' },
    intent_classified:   { step: 3, label: 'Task Brain' },
    routing:             { step: 4, label: 'Route selected' },
    tasks_executing:     { step: 0, label: 'Executing tasks' },
    tasks_completed:     { step: 0, label: 'Tasks completed' },
    actions_emitted:     { step: 0, label: 'Actions sent' },
    vision_analyzing:    { step: 0, label: 'Analyzing image' },
    streaming_started:   { step: 5, label: 'Streaming response' },
    extracting_query:    { step: 0, label: 'Extracting query' },
    searching_web:       { step: 0, label: 'Searching web' },
    search_completed:    { step: 0, label: 'Search completed' },
    context_retrieved:   { step: 0, label: 'Context retrieved' },
    background_dispatched: { step: 0, label: 'Background tasks' },
    first_chunk:         { step: 6, label: 'Core responded' },
};

function appendActivity(activity) {
    if (!activityList || !activity) return;
    const item = document.createElement('div');
    item.className = 'activity-item';
    item.setAttribute('data-event', activity.event || '');
    const stepInfo = ACTIVITY_STEPS[activity.event] || { step: 0, label: activity.event || 'Activity', icon: 'dot' };
    let detail = '';
    const addRouteClass = (route) => {
        if (route === 'general') item.classList.add('route-general');
        else if (route === 'realtime') item.classList.add('route-realtime');
        else if (route === 'vision' || route === 'camera') item.classList.add('route-vision');
        else if (route === 'task') item.classList.add('route-task');
        else if (route === 'mixed') item.classList.add('route-task');
        else if (route === 'chat') item.classList.add('route-chat');
    };
    if (activity.event === 'query_detected') {
        detail = activity.message || '';
    } else if (activity.event === 'decision') {
        const ms = activity.elapsed_ms;
        const timing = ms != null ? ` (${ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s'})` : '';
        const cat = (activity.query_type || '?').charAt(0).toUpperCase() + (activity.query_type || '').slice(1);
        detail = `${cat} — ${activity.reasoning || ''}${timing}`;
        addRouteClass(activity.query_type);
    } else if (activity.event === 'intent_classified') {
        detail = (activity.intent || '?').charAt(0).toUpperCase() + (activity.intent || '').slice(1);
        item.classList.add('activity-sub', 'route-task');
    } else if (activity.event === 'routing') {
        detail = `→ ${(activity.route || '?').charAt(0).toUpperCase() + (activity.route || '').slice(1)}`;
        addRouteClass(activity.route);
    } else if (activity.event === 'tasks_executing') {
        detail = activity.message || 'Running tasks...';
        item.classList.add('activity-sub', 'route-task');
    } else if (activity.event === 'tasks_completed') {
        detail = activity.message || 'Completed';
        item.classList.add('activity-sub', 'route-task');
    } else if (activity.event === 'actions_emitted') {
        detail = activity.message || 'Actions sent';
        item.classList.add('activity-sub');
    } else if (activity.event === 'vision_analyzing') {
        detail = activity.message || 'Analyzing image...';
        item.classList.add('activity-sub', 'route-vision');
    } else if (activity.event === 'streaming_started') {
        detail = `Generating via ${(activity.route || '?').charAt(0).toUpperCase() + (activity.route || '').slice(1)}`;
        addRouteClass(activity.route);
    } else if (activity.event === 'first_chunk') {
        const ms = activity.elapsed_ms;
        detail = ms != null ? `Core responded in ${ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s'}` : 'Response started';
        addRouteClass(activity.route);
    } else if (activity.event === 'extracting_query') {
        detail = activity.message || 'Parsing your question for search...';
        item.classList.add('activity-sub');
    } else if (activity.event === 'searching_web') {
        detail = activity.message || (activity.query ? `Query: "${activity.query}"` : 'Scanning Pulse...');
        item.classList.add('activity-sub', 'route-realtime');
    } else if (activity.event === 'search_completed') {
        detail = activity.message || 'Search completed';
        item.classList.add('activity-sub', 'route-realtime');
    } else if (activity.event === 'context_retrieved') {
        detail = activity.message || 'Knowledge base ready';
        item.classList.add('activity-sub', 'route-general');
    } else {
        detail = activity.message || (typeof activity === 'object' ? JSON.stringify(activity) : String(activity));
    }
    const stepNum = stepInfo.step ? `<span class="activity-step">${stepInfo.step}</span>` : '';
    item.innerHTML = `
        <div class="activity-event">${stepNum}${escapeHtml(stepInfo.label)}</div>
        <div class="activity-detail">${escapeHtml(detail || '')}</div>`;
    const emptyEl = activityList.querySelector('.activity-empty');
    if (emptyEl) emptyEl.style.display = 'none';
    activityList.appendChild(item);
    activityList.scrollTop = activityList.scrollHeight;
}

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function hideWelcome() {
    const w = document.getElementById('welcome-screen');
    if (w) w.remove();
}

const AVATAR_ICON_USER = '<svg class="msg-avatar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
const AVATAR_ICON_ASSISTANT = '<svg class="msg-avatar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><circle cx="9" cy="16" r="1" fill="currentColor"/><circle cx="15" cy="16" r="1" fill="currentColor"/></svg>';

function addMessage(role, text) {
    hideWelcome();
    const msg = document.createElement('div');
    msg.className = `message ${role}`;
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = role === 'assistant' ? AVATAR_ICON_ASSISTANT : AVATAR_ICON_USER;
    const body = document.createElement('div');
    body.className = 'msg-body';
    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = role === 'assistant'
        ? `Jarvis  (${currentMode === 'jarvis' ? 'Jarvis' : currentMode === 'realtime' ? 'Realtime' : 'General'})`
        : 'You';
    const content = document.createElement('div');
    content.className = 'msg-content';
    content.textContent = text;
    body.appendChild(label);
    body.appendChild(content);
    msg.appendChild(avatar);
    msg.appendChild(body);
    chatMessages.appendChild(msg);
    if (typeof gsap !== 'undefined') {
        gsap.from(msg, { opacity: 0, y: 14, scale: 0.97, duration: 0.38, ease: 'power2.out' });
    }
    scrollToBottom();
    return content;
}

function addTypingIndicator() {
    hideWelcome();
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    msg.id = 'typing-msg';
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = AVATAR_ICON_ASSISTANT;
    const body = document.createElement('div');
    body.className = 'msg-body';
    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = `Jarvis  (${currentMode === 'jarvis' ? 'Jarvis' : currentMode === 'realtime' ? 'Realtime' : 'General'})`;
    const content = document.createElement('div');
    content.className = 'msg-content';
    content.innerHTML = '<span class="msg-stream-text">...</span>';
    body.appendChild(label);
    body.appendChild(content);
    msg.appendChild(avatar);
    msg.appendChild(body);
    chatMessages.appendChild(msg);
    scrollToBottom();
    return content;
}

function removeTypingIndicator() {
    const t = document.getElementById('typing-msg');
    if (t) t.remove();
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

async function sendMessage(textOverride) {
    let text = (textOverride || messageInput.value).trim();
    // Intercept voice stop commands from typed input as well
    if (text && VOICE_STOP_COMMANDS.test(text)) {
        if (ttsPlayer) { ttsPlayer.stop(); ttsPlayer.stopped = false; }
        if (messageInput) messageInput.value = '';
        return;
    }
    const visionModeOn = camVisionModeInput && camVisionModeInput.checked;
    const hasAttachment = !!pendingAttachment;
    const wantsCamera = !hasAttachment && (visionModeOn || isCameraQuery(text) || (camStream && text));
    if (wantsCamera && !text) text = 'What do you see?';
    if (!text || isStreaming) return;
    if (isListening) {
        pendingSendTranscript = null;
        clearTimeout(speechSendTimeout);
        speechSendTimeout = null;
        stopListening();
    }
    if ((isCameraQuery(text) || visionModeOn) && !camStream && !hasAttachment) {
        try {
            await startCamera();
            await new Promise((resolve) => {
                if (!camVideo) { resolve(); return; }
                if (camVideo.readyState >= 2 && camVideo.videoWidth > 0) { resolve(); return; }
                const onReady = () => { camVideo.removeEventListener('loadeddata', onReady); clearTimeout(t); resolve(); };
                const t = setTimeout(() => { camVideo.removeEventListener('loadeddata', onReady); resolve(); }, 3000);
                camVideo.addEventListener('loadeddata', onReady);
            });
        } catch (_) {
        }
    }
    let imgBase64 = null;
    if (camStream && wantsCamera) {
        imgBase64 = await captureFrameAsBase64Safe();
        if (!imgBase64) showToast('Camera frame not ready. Please try again.');
    }
    messageInput.value = '';
    autoResizeInput();
    charCount.textContent = '';
    // Build API message — prepend attachment content if a file was attached
    let apiMessage = text;
    const attachmentSnapshot = pendingAttachment;
    if (attachmentSnapshot) {
        apiMessage = `[Uploaded: ${attachmentSnapshot.filename}]\n${attachmentSnapshot.extracted_text}\n\nUser: ${text}`;
        clearAttachment();
    }
    const userContentEl = addMessage('user', text);
    // Show a small file badge in the user bubble
    if (attachmentSnapshot && userContentEl) {
        const badge = document.createElement('div');
        badge.className = 'msg-attachment-badge';
        badge.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> ' + escapeHtml(attachmentSnapshot.filename);
        userContentEl.insertBefore(badge, userContentEl.firstChild);
    }
    addTypingIndicator();
    isStreaming = true;
    if (sendBtn) sendBtn.disabled = true;
    if (messageInput) messageInput.disabled = true;
    if (orbContainer) orbContainer.classList.add('active');
    if (ttsPlayer) { ttsPlayer.reset(); ttsPlayer.unlock(); }
    _attachmentInFlight = !!attachmentSnapshot;
    const messageToSend = imgBase64 ? (apiMessage + ' ' + CAM_BYPASS_TOKEN) : apiMessage;
    const endpoint = '/chat/jarvis/stream';
    if (activityList) {
        activityList.innerHTML = '<div class="activity-empty" id="activity-empty">Processing...</div>';
        if (activityToggle) activityToggle.style.display = '';
        if (activityPanel && settings.autoOpenActivity) { activityPanel.classList.add('open'); updatePanelOverlay(); }
    }
    let firstChunkReceived = false;
    let timeoutId = null;
    const controller = new AbortController();
    try {
        if (ttsPlayer?.enabled && settings.thinkingSounds && preStarterPlayer) {
            preStarterPlayer.play(() => {});
        }
        timeoutId = setTimeout(() => controller.abort(), 300000);
        const _ttsFlag = !!(ttsPlayer && ttsPlayer.enabled);
        let _ttsGotAudio = false;
        console.log('[TTS] sending request — tts:', _ttsFlag, '| player:', !!ttsPlayer, '| enabled:', ttsPlayer?.enabled);
        const res = await fetch(`${API}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                message: messageToSend,
                session_id: sessionId,
                tts: _ttsFlag,
                imgbase64: imgBase64 || null
            }),
            signal: controller.signal,
        });
        if (!res.ok) {
            let errMsg = `HTTP ${res.status}`;
            try {
                const err = await res.json();
                errMsg = err.detail || (Array.isArray(err.detail) ? err.detail.map(d => d.msg || d.loc?.join('.')).join('; ') : err.message) || errMsg;
            } catch (_) {}
            throw new Error(errMsg);
        }
        removeTypingIndicator();
        const contentEl = addMessage('assistant', '');
        contentEl.innerHTML = '<span class="msg-stream-text">...</span>';
        scrollToBottom();
        if (!res.body) throw new Error('No response body');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let fullResponse = '';
        let cursorEl = null;
        let streamDone = false;
        while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n\n');
            sseBuffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.session_id) sessionId = data.session_id;
                    if (data.activity) {
                        appendActivity(data.activity);
                        if (activityToggle) activityToggle.style.display = '';
                        if (activityPanel && settings.autoOpenActivity) { activityPanel.classList.add('open'); updatePanelOverlay(); }
                    }
                    if (data.search_results) {
                        renderSearchResults(data.search_results);
                        if (searchResultsToggle) searchResultsToggle.style.display = '';
                        if (searchResultsWidget && settings.autoOpenSearchResults) { searchResultsWidget.classList.add('open'); updatePanelOverlay(); }
                    }
                    if (data.actions) {
                        handleActions(data.actions, contentEl);
                    }
                    if (data.background_tasks) {
                        handleBackgroundTasks(data.background_tasks, contentEl);
                    }
                    if (data.youtube_detected) {
                        pendingYouTube = { video_id: data.youtube_detected.video_id, url: data.youtube_detected.url };
                        window.open(data.youtube_detected.url, '_blank');
                    }
                    if (data.interactive_choice && data.interactive_choice.type === 'youtube_analysis') {
                        renderYouTubeChoiceButtons(data.interactive_choice.video_id, contentEl);
                    }
                    if (data.practice_files) {
                        renderPracticeFiles(data.practice_files, contentEl);
                    }
                    if ('chunk' in data) {
                        const chunkText = data.chunk || '';
                        if (chunkText && !firstChunkReceived) {
                            firstChunkReceived = true;
                        }
                        fullResponse += chunkText;
                        const textSpan = contentEl.querySelector('.msg-stream-text');
                        if (textSpan) {
                            textSpan.textContent = fullResponse;
                            textSpan.classList.remove('stream-placeholder');
                        }
                        if (!cursorEl) {
                            cursorEl = document.createElement('span');
                            cursorEl.className = 'stream-cursor';
                            cursorEl.textContent = '|';
                            contentEl.appendChild(cursorEl);
                        }
                        scrollToBottom();
                    }
                    if ('audio' in data) {
                        if (data.audio && ttsPlayer) {
                            console.log('[TTS] audio received, size:', data.audio.length, '| enabled:', ttsPlayer.enabled, '| ctx:', ttsPlayer._ctx ? ttsPlayer._ctx.state : 'null');
                            ttsPlayer.enqueue(data.audio);
                            _ttsGotAudio = true;
                        } else {
                            console.warn('[TTS] audio event arrived but empty — backend TTS likely failed. ttsPlayer:', !!ttsPlayer, 'enabled:', ttsPlayer?.enabled);
                        }
                    }
                    if (data.error) throw new Error(data.error);
                    if (data.done) { streamDone = true; break; }
                } catch (parseErr) {
                    if (parseErr.message && !parseErr.message.includes('JSON'))
                        throw parseErr;
                }
            }
            if (streamDone) break;
        }
        if (cursorEl) cursorEl.remove();
        addSpeakButton(contentEl, fullResponse);
        if (_ttsFlag && fullResponse) {
            if (!_ttsGotAudio) {
                console.log('[TTS] no backend audio — browser speechSynthesis fallback');
                _browserSpeak(fullResponse);
            } else {
                const _savedResp = fullResponse;
                setTimeout(() => {
                    if (ttsPlayer && !ttsPlayer._didPlay) {
                        console.log('[TTS] audio received but not playing after 3s — browser fallback');
                        _browserSpeak(_savedResp);
                    }
                }, 3000);
            }
        }
        const textSpan = contentEl.querySelector('.msg-stream-text');
        if (textSpan && !fullResponse) textSpan.textContent = '(No response)';
    } catch (err) {
        clearTimeout(timeoutId);
        removeTypingIndicator();
        let msg = 'Something went wrong. Please try again.';
        if (err.name === 'AbortError') {
            msg = 'Request timed out. Please try again.';
        } else if (err.message && err.message.includes('503')) {
            msg = 'Service temporarily unavailable. Please try again in a moment.';
        } else if (err.message && err.message.includes('429')) {
            msg = 'Rate limit reached. Please wait a moment before trying again.';
        } else if (err.message && err.message.length > 0) {
            msg = err.message.length > 100 ? err.message.slice(0, 97) + '...' : err.message;
        }
        addMessage('assistant', msg);
        showToast(msg, 6000);
    } finally {
        clearTimeout(timeoutId);
        isStreaming = false;
        _attachmentInFlight = false;
        if (sendBtn) sendBtn.disabled = false;
        if (messageInput) messageInput.disabled = false;
        if (orbContainer) orbContainer.classList.remove('active');
        maybeRestartListening();
    }
}

// ─── YouTube Quiz & Summary ────────────────────────────────────────────────

function renderYouTubeChoiceButtons(videoId, contentEl) {
    const target = contentEl || Array.from(document.querySelectorAll('.message.assistant .msg-content')).pop();
    if (!target) return;
    const wrap = document.createElement('div');
    wrap.className = 'yt-choice-wrap';
    const mcqBtn = document.createElement('button');
    mcqBtn.className = 'yt-choice-btn';
    mcqBtn.innerHTML = '&#128221; Generate 10 MCQ Questions';
    const sumBtn = document.createElement('button');
    sumBtn.className = 'yt-choice-btn';
    sumBtn.innerHTML = '&#128218; Summarise the Video';
    wrap.appendChild(mcqBtn);
    wrap.appendChild(sumBtn);
    target.appendChild(wrap);
    scrollToBottom();

    mcqBtn.addEventListener('click', () => {
        mcqBtn.disabled = true; sumBtn.disabled = true;
        mcqBtn.classList.add('selected');
        startQuiz(videoId);
    });
    sumBtn.addEventListener('click', () => {
        mcqBtn.disabled = true; sumBtn.disabled = true;
        sumBtn.classList.add('selected');
        startSummary(videoId);
    });
}

function renderPracticeFiles(payload, contentEl) {
    const target = contentEl || Array.from(
        document.querySelectorAll('.message.assistant .msg-content')
    ).pop();
    if (!target || !payload?.files?.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'practice-files-wrap';
    const label = document.createElement('div');
    label.className = 'practice-files-label';
    label.textContent = `${payload.class_name.replace('_', ' ').toUpperCase()} — ${payload.files.length} file(s)`;
    wrap.appendChild(label);
    for (const file of payload.files) {
        const card = document.createElement('div');
        card.className = 'practice-card';
        const info = document.createElement('div');
        info.className = 'practice-card-info';
        const name = document.createElement('div');
        name.className = 'practice-card-name';
        name.textContent = file.filename;
        const meta = document.createElement('div');
        meta.className = 'practice-card-meta';
        meta.textContent = `${file.class_name.replace('_', ' ').toUpperCase()} · ${file.size_label}`;
        info.appendChild(name);
        info.appendChild(meta);
        const btnWrap = document.createElement('div');
        btnWrap.className = 'practice-card-btns';
        const openBtn = document.createElement('a');
        openBtn.className = 'practice-open-btn';
        openBtn.href = `${API}${file.download_url}?inline=true`;
        openBtn.target = '_blank';
        openBtn.rel = 'noopener';
        openBtn.textContent = '⎋ Open';
        const dlBtn = document.createElement('a');
        dlBtn.className = 'practice-download-btn';
        dlBtn.href = `${API}${file.download_url}`;
        dlBtn.download = file.filename;
        dlBtn.target = '_blank';
        dlBtn.textContent = '⬇ Download';
        btnWrap.appendChild(openBtn);
        btnWrap.appendChild(dlBtn);
        card.appendChild(info);
        card.appendChild(btnWrap);
        wrap.appendChild(card);
    }
    target.appendChild(wrap);
    scrollToBottom();
}

let _quizAudio = null;
async function speakText(text) {
    if (!ttsPlayer || !ttsPlayer.enabled || !text) return;
    if (_quizAudio) { _quizAudio.pause(); _quizAudio = null; }
    const audio = _speakAudio || document.createElement('audio');
    _quizAudio = audio;
    let spoke = false;
    try {
        const res = await fetch(`${API}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        audio.src = url;
        _onJarvisSpeechStart();
        spoke = true;
        await new Promise((resolve) => {
            audio.onended = () => { URL.revokeObjectURL(url); if (_quizAudio === audio) _quizAudio = null; resolve(); };
            audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
            audio.play().catch(e => { console.warn('speakText play error:', e); resolve(); });
        });
    } catch (e) {
        console.warn('speakText error:', e);
    } finally {
        if (spoke) _onJarvisSpeechEnd();
    }
}

async function startQuiz(videoId) {
    const loadingEl = addMessage('assistant', 'Generating 10 quiz questions, Sir — just a moment...');
    try {
        const res = await fetch(`${API}/quiz/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ session_id: sessionId, video_id: videoId }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (loadingEl && loadingEl.closest('.message')) loadingEl.closest('.message').remove();
        currentQuiz = { questions: data.questions, currentIdx: 0, score: 0 };
        renderQuestion(0);
    } catch (e) {
        if (loadingEl) loadingEl.textContent = `Sorry Sir, quiz generation failed: ${e.message}`;
    }
}

function renderQuestion(idx) {
    if (!currentQuiz) return;
    if (idx >= currentQuiz.questions.length) { renderQuizResult(); return; }
    currentQuiz.currentIdx = idx;
    const q = currentQuiz.questions[idx];
    const total = currentQuiz.questions.length;

    const card = document.createElement('div');
    card.className = 'quiz-card';
    card.innerHTML = `
        <div class="quiz-progress">Q ${idx + 1} / ${total} &nbsp;&bull;&nbsp; Score: ${currentQuiz.score}</div>
        <div class="quiz-question">${escapeHtml(q.question)}</div>
        <div class="quiz-options"></div>
        `;
    const optWrap = card.querySelector('.quiz-options');
    q.options.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.className = 'quiz-opt-btn';
        btn.textContent = `${String.fromCharCode(65 + i)}. ${opt}`;
        btn.addEventListener('click', () => submitAnswer(card, q, i));
        optWrap.appendChild(btn);
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'message assistant';
    wrapper.innerHTML = '<div class="msg-avatar">' + AVATAR_ICON_ASSISTANT + '</div>';
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.appendChild(card);
    wrapper.appendChild(body);
    chatMessages.appendChild(wrapper);
    scrollToBottom();
    const optLabels = q.options.map((o, i) => `${String.fromCharCode(65 + i)}: ${o}`).join('. ');
    speakText(`Question ${idx + 1} of ${total}. ${q.question}. ${optLabels}.`);
}

async function submitAnswer(card, q, chosenIdx) {
    _quizListening = false;
    const btns = card.querySelectorAll('.quiz-opt-btn');
    btns.forEach(b => b.disabled = true);
    const correct = q.correct;
    btns[correct].classList.add('correct');
    if (chosenIdx !== correct) {
        btns[chosenIdx].classList.add('wrong');
        await speakText('Sir, that is the wrong answer.');
    } else {
        currentQuiz.score++;
        await speakText('Correct, Sir.');
    }
    renderQuestion(currentQuiz.currentIdx + 1);
}

// ─── Classroom Attention AI ───────────────────────────────────────────────────
const classroomBtn            = $('classroom-btn');
const classroomConsentOverlay = $('classroom-consent-overlay');
const classroomConsentAccept  = $('classroom-consent-accept');
const classroomConsentDecline = $('classroom-consent-decline');
const classroomDashboard      = $('classroom-dashboard');
const classroomStopBtn        = $('classroom-stop-btn');
const classroomMinimizeBtn    = $('classroom-minimize-btn');
const classroomVideo       = $('classroom-video');
const classroomCanvas      = $('classroom-canvas');
const clsAttention         = $('cls-attention');
const clsAttentive         = $('cls-attentive');
const clsDistracted        = $('cls-distracted');
const clsTotal             = $('cls-total');
const classroomStudents    = $('classroom-students');
const classroomNextScan    = $('classroom-next-scan');
const clsMiniPct           = $('cls-mini-pct');

let classroomStream      = null;
let classroomInterval    = null;
let classroomCountdown   = null;
let classroomSecsLeft    = 30;

classroomBtn.addEventListener('click', () => {
    classroomConsentOverlay.setAttribute('aria-hidden', 'false');
    classroomConsentOverlay.classList.add('visible');
});

classroomConsentDecline.addEventListener('click', () => {
    classroomConsentOverlay.setAttribute('aria-hidden', 'true');
    classroomConsentOverlay.classList.remove('visible');
});

classroomConsentAccept.addEventListener('click', async () => {
    classroomConsentOverlay.setAttribute('aria-hidden', 'true');
    classroomConsentOverlay.classList.remove('visible');
    await startClassroomMode();
});

classroomStopBtn.addEventListener('click', stopClassroomMode);

classroomMinimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    classroomDashboard.classList.toggle('minimized');
});

// Clicking the header while minimized restores the panel
$('classroom-dashboard-header').addEventListener('click', (e) => {
    if (classroomDashboard.classList.contains('minimized') &&
        e.target !== classroomStopBtn && e.target !== classroomMinimizeBtn) {
        classroomDashboard.classList.remove('minimized');
    }
});

async function startClassroomMode() {
    try {
        classroomStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        classroomVideo.srcObject = classroomStream;
        classroomDashboard.setAttribute('aria-hidden', 'false');
        classroomDashboard.classList.add('visible');
        classroomBtn.classList.add('active');
        // Wait for first video frame to render before capturing
        await new Promise(resolve => {
            if (classroomVideo.readyState >= 2) { resolve(); return; }
            classroomVideo.addEventListener('loadeddata', resolve, { once: true });
            setTimeout(resolve, 2000); // fallback: max 2s wait
        });
        await runClassroomScan();
        classroomSecsLeft = 30;
        classroomInterval = setInterval(async () => {
            await runClassroomScan();
            classroomSecsLeft = 30;
        }, 30000);
        classroomCountdown = setInterval(() => {
            classroomSecsLeft = Math.max(0, classroomSecsLeft - 1);
            classroomNextScan.textContent = `Next scan in ${classroomSecsLeft}s`;
        }, 1000);
    } catch (err) {
        showToast('Webcam access denied or unavailable.', 'error');
    }
}

function stopClassroomMode() {
    clearInterval(classroomInterval);
    clearInterval(classroomCountdown);
    classroomInterval = null;
    classroomCountdown = null;
    classroomSecsLeft = 30;
    if (classroomStream) {
        classroomStream.getTracks().forEach(t => t.stop());
        classroomStream = null;
    }
    classroomVideo.srcObject = null;
    classroomDashboard.setAttribute('aria-hidden', 'true');
    classroomDashboard.classList.remove('visible');
    classroomBtn.classList.remove('active');
    classroomDashboard.classList.remove('minimized');
    classroomNextScan.textContent = 'Next scan in 30s';
    clsAttention.textContent  = '--';
    clsAttentive.textContent  = '--';
    clsDistracted.textContent = '--';
    clsTotal.textContent      = '--';
    clsMiniPct.textContent    = '';
    classroomStudents.innerHTML = '';
}

async function runClassroomScan() {
    if (!classroomStream) return;
    classroomNextScan.textContent = 'Scanning...';
    const ctx = classroomCanvas.getContext('2d');
    classroomCanvas.width  = classroomVideo.videoWidth  || 640;
    classroomCanvas.height = classroomVideo.videoHeight || 480;
    ctx.drawImage(classroomVideo, 0, 0, classroomCanvas.width, classroomCanvas.height);
    const dataUrl = classroomCanvas.toDataURL('image/jpeg', 0.8);
    const b64 = dataUrl.split(',')[1];
    try {
        const res = await fetch(`${API}/classroom/analyse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frame_base64: b64 }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'Classroom analysis failed.', 'error');
            return;
        }
        const data = await res.json();
        renderClassroomData(data);
    } catch (e) {
        showToast('Could not reach server for classroom analysis.', 'error');
    }
}

document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && classroomStream) {
        await runClassroomScan();
        classroomSecsLeft = 30;
    }
});

function renderClassroomData(data) {
    const pct = data.overall_attention_percent;
    clsAttention.textContent  = pct != null ? `${pct}%` : '--';
    clsAttentive.textContent  = data.attentive_count  ?? '--';
    clsDistracted.textContent = data.distracted_count ?? '--';
    clsTotal.textContent      = data.total_visible    ?? '--';
    clsMiniPct.textContent    = pct != null ? `${pct}%` : '--';

    classroomStudents.innerHTML = '';
    const students = data.students || [];
    if (!students.length) {
        classroomStudents.innerHTML = '<p class="classroom-no-students">No students detected.</p>';
        return;
    }
    students.forEach(s => {
        const score = s['attention 1-10'] ?? s.attention ?? '?';
        const bar = document.createElement('div');
        bar.className = 'classroom-student-row';
        const fill = Math.min(100, Math.max(0, (Number(score) / 10) * 100));
        bar.innerHTML = `
            <span class="cls-student-pos">${s.position || 'Unknown'}</span>
            <div class="cls-student-bar-wrap">
                <div class="cls-student-bar" style="width:${fill}%"></div>
            </div>
            <span class="cls-student-score ${Number(score) >= 6 ? 'good' : 'low'}">${score}/10</span>
            <span class="cls-student-status">${s.status || ''}</span>
        `;
        classroomStudents.appendChild(bar);
    });
}

function renderQuizResult() {
    if (!currentQuiz) return;
    voiceQuizMode = false;
    _quizListening = false;
    stopListening();
    const score = currentQuiz.score;
    const total = currentQuiz.questions.length;
    const pct = Math.round((score / total) * 100);
    const emoji = pct >= 80 ? '🏆' : pct >= 60 ? '👍' : pct >= 40 ? '📚' : '💪';

    const card = document.createElement('div');
    card.className = 'quiz-result-card';
    card.innerHTML = `
        <div class="quiz-result-emoji">${emoji}</div>
        <div class="quiz-result-score">${score} / ${total}</div>
        <div class="quiz-result-pct">${pct}% Correct</div>
        <div class="quiz-result-actions">
            <button class="quiz-action-btn" id="quiz-replay-btn">&#x1F504; Try Again</button>
            <button class="quiz-action-btn secondary" id="quiz-done-btn">&#x2705; Done</button>
        </div>`;

    const wrapper = document.createElement('div');
    wrapper.className = 'message assistant';
    wrapper.innerHTML = '<div class="msg-avatar">' + AVATAR_ICON_ASSISTANT + '</div>';
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.appendChild(card);
    wrapper.appendChild(body);
    chatMessages.appendChild(wrapper);
    scrollToBottom();
    const resultPhrase = pct >= 80 ? 'Excellent work' : pct >= 60 ? 'Well done' : pct >= 40 ? 'Good effort' : 'Keep practicing';
    speakText(`${resultPhrase}, Sir. You scored ${score} out of ${total}. That is ${pct} percent correct.`);

    card.querySelector('#quiz-replay-btn').addEventListener('click', () => {
        currentQuiz.score = 0;
        currentQuiz.currentIdx = 0;
        renderQuestion(0);
    });
    card.querySelector('#quiz-done-btn').addEventListener('click', () => {
        voiceQuizMode = false;
        _quizListening = false;
        currentQuiz = null;
        addMessage('assistant', 'Great effort, Sir! Let me know if you have any questions about the video.');
    });
}

async function startSummary(videoId) {
    const loadingEl = addMessage('assistant', 'Generating video summary, Sir — just a moment...');
    try {
        const res = await fetch(`${API}/quiz/summary`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ session_id: sessionId, video_id: videoId }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (loadingEl && loadingEl.closest('.message')) loadingEl.closest('.message').remove();
        const summaryEl = addMessage('assistant', '');
        summaryEl.innerHTML = renderMarkdown(data.summary);
        speakText(data.summary);
    } catch (e) {
        if (loadingEl) loadingEl.textContent = `Sorry Sir, summary generation failed: ${e.message}`;
    }
}

function renderMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/^#{1,3}\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    html = html.replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
    return html;
}

// ─── Feature 8 — Lecture Catalog (admin only) ───────────────────────────────
const ADMIN_TOKEN_KEY = 'jarvis_admin_token';

function _getAdminToken() {
    try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch (_) { return ''; }
}
function _setAdminToken(t) {
    try {
        if (t) localStorage.setItem(ADMIN_TOKEN_KEY, t);
        else localStorage.removeItem(ADMIN_TOKEN_KEY);
    } catch (_) {}
}

async function _adminFetch(path, opts = {}) {
    const token = _getAdminToken();
    const headers = { ...(opts.headers || {}) };
    if (token) headers['X-Admin-Token'] = token;
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    if (res.status === 401) {
        // Stale or wrong token — clear it and hide the admin UI
        _setAdminToken('');
        _updateAdminUI(false);
    }
    return res;
}

function _updateAdminUI(signedIn) {
    const btn = $('lectures-btn');
    const signedOut = $('admin-signed-out');
    const signedInEl = $('admin-signed-in');
    if (btn) btn.style.display = signedIn ? '' : 'none';
    if (signedOut) signedOut.style.display = signedIn ? 'none' : '';
    if (signedInEl) signedInEl.style.display = signedIn ? '' : 'none';
}

async function _verifyAdminOnLoad() {
    const token = _getAdminToken();
    if (!token) { _updateAdminUI(false); return; }
    try {
        const res = await _adminFetch('/lectures');
        _updateAdminUI(res.ok);
    } catch (_) {
        _updateAdminUI(false);
    }
}

function _openAdminModal() {
    const modal = $('admin-modal');
    const input = $('admin-token-input');
    const errEl = $('admin-modal-error');
    if (errEl) errEl.style.display = 'none';
    if (input) input.value = '';
    if (modal) {
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        setTimeout(() => input && input.focus(), 50);
    }
}
function _closeAdminModal() {
    const modal = $('admin-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
    }
}

async function _submitAdminToken() {
    const input = $('admin-token-input');
    const errEl = $('admin-modal-error');
    const submitBtn = $('admin-modal-submit');
    const token = (input && input.value || '').trim();
    if (!token) {
        if (errEl) { errEl.textContent = 'Please enter your admin token.'; errEl.style.display = 'block'; }
        return;
    }
    if (submitBtn) submitBtn.disabled = true;
    try {
        const res = await fetch(`${API}/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
        });
        if (res.ok) {
            _setAdminToken(token);
            _updateAdminUI(true);
            _closeAdminModal();
            showToast('Signed in as Admin.');
        } else if (res.status === 401) {
            if (errEl) { errEl.textContent = 'Invalid token.'; errEl.style.display = 'block'; }
        } else if (res.status === 503) {
            if (errEl) { errEl.textContent = 'Admin features are not configured on the server.'; errEl.style.display = 'block'; }
        } else {
            if (errEl) { errEl.textContent = `Unexpected error (${res.status}).`; errEl.style.display = 'block'; }
        }
    } catch (e) {
        if (errEl) { errEl.textContent = `Network error: ${e.message}`; errEl.style.display = 'block'; }
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

function _signOutAdmin() {
    _setAdminToken('');
    _updateAdminUI(false);
    _closeLecturesPanel();
    showToast('Signed out of Admin.');
}

// ─── Lectures drawer ────────────────────────────────────────────────────────
function _openLecturesPanel() {
    const panel = $('lectures-panel');
    if (panel) {
        panel.classList.add('open');
        panel.setAttribute('aria-hidden', 'false');
    }
    if (typeof updatePanelOverlay === 'function') updatePanelOverlay();
    _hideLectureForm();
    _refreshLecturesList();
}

function _closeLecturesPanel() {
    const panel = $('lectures-panel');
    if (panel) {
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
    }
    if (typeof updatePanelOverlay === 'function') updatePanelOverlay();
    _hideLectureForm();
}

async function _refreshLecturesList() {
    const listEl = $('lectures-list');
    const emptyEl = $('lectures-empty');
    if (!listEl) return;
    listEl.innerHTML = '<p class="lectures-loading">Loading…</p>';
    try {
        const res = await _adminFetch('/lectures');
        if (!res.ok) {
            listEl.innerHTML = `<p class="lectures-error">Failed to load lectures (HTTP ${res.status}).</p>`;
            return;
        }
        const data = await res.json();
        const lectures = data.lectures || [];
        if (lectures.length === 0) {
            listEl.innerHTML = '<p class="lectures-empty">No lectures yet. Click "+ Add Lecture" to add one.</p>';
            return;
        }
        // Group by class
        const groups = {};
        for (const l of lectures) {
            if (!groups[l.class_name]) groups[l.class_name] = [];
            groups[l.class_name].push(l);
        }
        const html = Object.keys(groups).map(cls => {
            const friendlyClass = cls === 'UKG' ? 'UKG' : `Class ${cls.replace('class_', '')}`;
            const items = groups[cls].map(l => `
                <div class="lecture-item" data-class="${l.class_name}" data-chapter="${l.chapter}">
                    <div class="lecture-item-info">
                        <div class="lecture-item-title">Chapter ${l.chapter} — ${_esc(l.title)}</div>
                        <div class="lecture-item-url"><a href="${_esc(l.youtube_url)}" target="_blank" rel="noopener">${_esc(l.youtube_url)}</a></div>
                    </div>
                    <div class="lecture-item-actions">
                        <button class="btn-mini lecture-edit-btn" data-class="${l.class_name}" data-chapter="${l.chapter}">Edit</button>
                        <button class="btn-mini lecture-del-btn" data-class="${l.class_name}" data-chapter="${l.chapter}">Delete</button>
                    </div>
                </div>
            `).join('');
            return `
                <div class="lecture-group">
                    <h4 class="lecture-group-title">${friendlyClass} <span class="lecture-group-count">(${groups[cls].length})</span></h4>
                    ${items}
                </div>
            `;
        }).join('');
        listEl.innerHTML = html;
        // Wire up edit/delete
        listEl.querySelectorAll('.lecture-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const cls = btn.getAttribute('data-class');
                const ch = parseInt(btn.getAttribute('data-chapter'), 10);
                const lec = lectures.find(l => l.class_name === cls && l.chapter === ch);
                if (lec) _showLectureForm('edit', lec);
            });
        });
        listEl.querySelectorAll('.lecture-del-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const cls = btn.getAttribute('data-class');
                const ch = btn.getAttribute('data-chapter');
                if (!confirm(`Delete ${cls.replace('class_', 'Class ')} Chapter ${ch}?`)) return;
                const res = await _adminFetch(`/lectures/${cls}/${ch}`, { method: 'DELETE' });
                if (res.ok || res.status === 204) {
                    showToast('Lecture deleted.');
                    _refreshLecturesList();
                } else {
                    showToast(`Delete failed (HTTP ${res.status}).`, 6000);
                }
            });
        });
    } catch (e) {
        listEl.innerHTML = `<p class="lectures-error">Network error: ${_esc(e.message)}</p>`;
    }
}

function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _populateClassDropdown() {
    const sel = $('lecture-class');
    if (!sel || sel.options.length > 1) return;  // already populated
    for (let i = 1; i <= 12; i++) {
        const opt = document.createElement('option');
        opt.value = `class_${i}`;
        opt.textContent = `Class ${i}`;
        sel.appendChild(opt);
    }
}

function _showLectureForm(mode, lec) {
    _populateClassDropdown();
    const form = $('lecture-form');
    const title = $('lecture-form-title');
    const mode_input = $('lecture-form-mode');
    const orig = $('lecture-form-original-key');
    const cls = $('lecture-class');
    const ch = $('lecture-chapter');
    const t = $('lecture-title');
    const url = $('lecture-url');
    const err = $('lecture-form-error');
    if (err) err.style.display = 'none';
    if (mode === 'edit' && lec) {
        if (title) title.textContent = `Edit Class ${lec.class_name.replace('class_', '')} Chapter ${lec.chapter}`;
        if (mode_input) mode_input.value = 'edit';
        if (orig) orig.value = `${lec.class_name}/${lec.chapter}`;
        if (cls) { cls.value = lec.class_name; cls.disabled = true; }
        if (ch) { ch.value = lec.chapter; ch.disabled = true; }
        if (t) t.value = lec.title || '';
        if (url) url.value = lec.youtube_url || '';
    } else {
        if (title) title.textContent = 'Add Lecture';
        if (mode_input) mode_input.value = 'add';
        if (orig) orig.value = '';
        if (cls) { cls.disabled = false; cls.value = 'class_1'; }
        if (ch) { ch.disabled = false; ch.value = ''; }
        if (t) t.value = '';
        if (url) url.value = '';
    }
    if (form) form.style.display = '';
}

function _hideLectureForm() {
    const form = $('lecture-form');
    if (form) form.style.display = 'none';
}

const _YT_RE = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?(?:[^&]*&)*v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;

async function _saveLectureForm() {
    const mode = ($('lecture-form-mode') || {}).value || 'add';
    const cls = ($('lecture-class') || {}).value || '';
    const chRaw = ($('lecture-chapter') || {}).value || '';
    const titleVal = (($('lecture-title') || {}).value || '').trim();
    const urlVal = (($('lecture-url') || {}).value || '').trim();
    const err = $('lecture-form-error');
    const saveBtn = $('lecture-form-save');

    const setErr = msg => {
        if (err) { err.textContent = msg; err.style.display = 'block'; }
    };

    if (err) err.style.display = 'none';

    // Client-side validation (mirrors backend)
    if (!cls) return setErr('Please choose a class.');
    const ch = parseInt(chRaw, 10);
    if (!ch || ch < 1 || ch > 80) return setErr('Chapter must be a number between 1 and 80.');
    if (!titleVal) return setErr('Title is required.');
    if (titleVal.length > 120) return setErr('Title must be 120 characters or fewer.');
    if (!_YT_RE.test(urlVal)) return setErr('Please enter a valid YouTube URL.');

    if (saveBtn) saveBtn.disabled = true;
    try {
        let res;
        if (mode === 'edit') {
            res = await _adminFetch(`/lectures/${cls}/${ch}`, {
                method: 'PUT',
                body: JSON.stringify({ title: titleVal, youtube_url: urlVal }),
            });
        } else {
            res = await _adminFetch('/lectures', {
                method: 'POST',
                body: JSON.stringify({ class_name: cls, chapter: ch, title: titleVal, youtube_url: urlVal }),
            });
            if (res.status === 409) {
                if (!confirm(`A lecture already exists at Class ${cls.replace('class_', '')} Chapter ${ch}. Overwrite it?`)) {
                    if (saveBtn) saveBtn.disabled = false;
                    return;
                }
                res = await _adminFetch('/lectures?overwrite=true', {
                    method: 'POST',
                    body: JSON.stringify({ class_name: cls, chapter: ch, title: titleVal, youtube_url: urlVal }),
                });
            }
        }
        if (res.ok) {
            showToast(mode === 'edit' ? 'Lecture updated.' : 'Lecture added.');
            _hideLectureForm();
            _refreshLecturesList();
        } else {
            let detail = `HTTP ${res.status}`;
            try { const j = await res.json(); detail = j.detail || detail; } catch (_) {}
            setErr(detail);
        }
    } catch (e) {
        setErr(`Network error: ${e.message}`);
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

// Wire up admin/lectures UI on DOM ready
(function _initAdminLecturesUI() {
    const bindWhenReady = () => {
        const lecBtn = $('lectures-btn');
        const lecClose = $('lectures-close');
        const addBtn = $('lectures-add-btn');
        const formCancel = $('lecture-form-cancel');
        const formSave = $('lecture-form-save');
        const signinBtn = $('admin-signin-btn');
        const signoutBtn = $('admin-signout-btn');
        const modalSubmit = $('admin-modal-submit');
        const modalCancel = $('admin-modal-cancel');
        const modalClose = $('admin-modal-close');
        const tokenInput = $('admin-token-input');

        if (lecBtn) lecBtn.addEventListener('click', _openLecturesPanel);
        if (lecClose) lecClose.addEventListener('click', _closeLecturesPanel);
        if (addBtn) addBtn.addEventListener('click', () => _showLectureForm('add'));
        if (formCancel) formCancel.addEventListener('click', _hideLectureForm);
        if (formSave) formSave.addEventListener('click', _saveLectureForm);
        if (signinBtn) signinBtn.addEventListener('click', _openAdminModal);
        if (signoutBtn) signoutBtn.addEventListener('click', _signOutAdmin);
        if (modalSubmit) modalSubmit.addEventListener('click', _submitAdminToken);
        if (modalCancel) modalCancel.addEventListener('click', _closeAdminModal);
        if (modalClose) modalClose.addEventListener('click', _closeAdminModal);
        if (tokenInput) tokenInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); _submitAdminToken(); }
        });

        _verifyAdminOnLoad();
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindWhenReady);
    } else {
        bindWhenReady();
    }
})();

// ─── Three.js ambient particle background ───────────────────────────────────
(function initParticles() {
    const canvas = document.getElementById('particles-bg');
    if (!canvas || typeof THREE === 'undefined') return;

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
    } catch (e) {
        return; // WebGL not supported — skip particles, don't crash script
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 6;

    const COUNT = 150;
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT * 3; i++) pos[i] = (Math.random() - 0.5) * 22;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0x7c6aef, size: 0.045, transparent: true, opacity: 0.55 });
    const points = new THREE.Points(geo, mat);
    scene.add(points);

    const pos2 = new Float32Array(60 * 3);
    for (let i = 0; i < 60 * 3; i++) pos2[i] = (Math.random() - 0.5) * 22;
    const geo2 = new THREE.BufferGeometry();
    geo2.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
    const mat2 = new THREE.PointsMaterial({ color: 0x4ecdc4, size: 0.03, transparent: true, opacity: 0.35 });
    const points2 = new THREE.Points(geo2, mat2);
    scene.add(points2);

    (function animate() {
        requestAnimationFrame(animate);
        points.rotation.y += 0.00025;
        points.rotation.x += 0.00008;
        points2.rotation.y -= 0.00015;
        points2.rotation.x += 0.00012;
        renderer.render(scene, camera);
    })();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
})();

// ─── GSAP page-load entrance ─────────────────────────────────────────────────
(function initGSAPEntrance() {
    if (typeof gsap === 'undefined') return;
    // Only animate non-critical decorative elements — never animate input-bar or
    // chat-area since hiding them even briefly breaks core UX
    try {
        gsap.from('.header',        { opacity: 0, y: -10, duration: 0.7, ease: 'power3.out', delay: 0.1, clearProps: 'all' });
    } catch (e) { /* silently skip if GSAP has issues */ }
})();

// ─── GSAP button micro-interactions ──────────────────────────────────────────
(function initButtonFX() {
    if (typeof gsap === 'undefined') return;
    try {
        document.querySelectorAll('.btn-icon, .action-btn').forEach(btn => {
            btn.addEventListener('mouseenter', () => gsap.to(btn, { scale: 1.13, duration: 0.18, ease: 'back.out(2.5)' }));
            btn.addEventListener('mouseleave', () => gsap.to(btn, { scale: 1, duration: 0.18, ease: 'power2.out' }));
        });

        const sendBtn = document.getElementById('send-btn');
        if (sendBtn) {
            sendBtn.addEventListener('click', () => {
                gsap.to(sendBtn, { scale: 0.88, duration: 0.08, ease: 'power1.in', yoyo: true, repeat: 1 });
            });
        }
    } catch (e) { /* silently skip */ }
})();

// ─── Feature 6: Animated AI Avatar ───────────────────────────────────────────
(function initAvatar() {

    // 1. DOM guards
    const orbEl           = document.getElementById('orb-container');
    const micEl           = document.getElementById('mic-btn');
    const avatarContainer = document.getElementById('avatar-container');
    if (!avatarContainer || !orbEl || !micEl) return;

    const faceEl       = document.getElementById('avatar-face');
    const stateLabelEl = document.getElementById('avatar-state-label');

    // 2. Build SVG face programmatically (54×54 viewBox)
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function svgEl(tag, attrs) {
        const e = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
        return e;
    }

    const svg = svgEl('svg', { viewBox: '0 0 54 54', xmlns: SVG_NS, 'aria-hidden': 'true' });

    // Defs: glow filter
    const defs   = svgEl('defs', {});
    const filter = svgEl('filter', { id: 'avatarGlow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
    const fBlur  = svgEl('feGaussianBlur', { stdDeviation: '1.4', result: 'blur' });
    const fMrg   = svgEl('feMerge', {});
    fMrg.appendChild(svgEl('feMergeNode', { in: 'blur' }));
    fMrg.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
    filter.appendChild(fBlur);
    filter.appendChild(fMrg);
    defs.appendChild(filter);
    svg.appendChild(defs);

    // Hexagonal outer ring (flat-top, radius 25.5 from centre 27,27)
    const hexPts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        return `${(27 + 25.5 * Math.cos(a)).toFixed(1)},${(27 + 25.5 * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    svg.appendChild(svgEl('polygon', { points: hexPts, class: 'avatar-hex-ring' }));

    // Corner accent dots at alternate hex vertices (0, 2, 4)
    [0, 2, 4].forEach(i => {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        svg.appendChild(svgEl('circle', {
            cx: (27 + 25.5 * Math.cos(a)).toFixed(1),
            cy: (27 + 25.5 * Math.sin(a)).toFixed(1),
            r: '1.2', fill: 'rgba(124,106,239,0.6)',
        }));
    });

    // Head circle
    svg.appendChild(svgEl('circle', { cx: '27', cy: '27', r: '21', class: 'avatar-head' }));

    // Brow line
    svg.appendChild(svgEl('line', {
        x1: '14', y1: '17', x2: '40', y2: '17',
        stroke: 'rgba(124,106,239,0.25)', 'stroke-width': '0.6', 'stroke-linecap': 'round',
    }));

    // Visor scan line
    svg.appendChild(svgEl('line', { x1: '14', y1: '27', x2: '40', y2: '27', class: 'avatar-visor-line' }));

    // Eyes: left cx=18, right cx=36, cy=22
    const eyeIrisEls = [];
    [18, 36].forEach(cx => {
        svg.appendChild(svgEl('ellipse', { cx, cy: '22', rx: '5.5', ry: '4.8', class: 'avatar-eye-outer' }));
        const iris = svgEl('ellipse', { cx, cy: '22', rx: '4', ry: '3.8', class: 'avatar-eye-iris' });
        svg.appendChild(iris);
        eyeIrisEls.push(iris);
        svg.appendChild(svgEl('ellipse', { cx, cy: '22', rx: '1.8', ry: '1.8', class: 'avatar-eye-pupil' }));
        svg.appendChild(svgEl('ellipse', {
            cx: cx - 1.2, cy: '20.6', rx: '0.9', ry: '0.7', class: 'avatar-eye-highlight',
        }));
    });

    // Waveform mouth bars: 5 bars centred at x=27, baseline y=41
    const BAR_W = 3, BAR_GAP = 2, BAR_BASE_H = 2.5, BAR_Y_BOTTOM = 41, BAR_MAX_EXTRA = 14;
    const barsStartX = 27 - (5 * BAR_W + 4 * BAR_GAP) / 2;
    const barEls = Array.from({ length: 5 }, (_, i) => {
        const bar = svgEl('rect', {
            x: (barsStartX + i * (BAR_W + BAR_GAP)).toFixed(1),
            y: (BAR_Y_BOTTOM - BAR_BASE_H).toFixed(1),
            width: BAR_W, height: BAR_BASE_H, rx: '1.5', class: 'avatar-bar',
        });
        svg.appendChild(bar);
        return bar;
    });

    if (faceEl) faceEl.appendChild(svg);

    // 3. State machine
    let avatarState = 'idle';
    let hideTimeout = null;
    const STATE_LABELS = { idle: 'STANDBY', listening: 'LISTENING', talking: 'SPEAKING' };

    function avatarSetState(next) {
        if (next === avatarState) return;
        const prev = avatarState;
        avatarState = next;

        avatarContainer.classList.remove('avatar-idle', 'avatar-listening', 'avatar-talking');
        avatarContainer.classList.add('avatar-' + next);
        if (stateLabelEl) stateLabelEl.textContent = STATE_LABELS[next] || 'STANDBY';

        if (next !== 'idle' && hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
        if (next === 'idle') {
            hideTimeout = setTimeout(() => { hideTimeout = null; }, 1800);
        }

        // GSAP eye transitions on state change
        if (typeof gsap !== 'undefined') {
            try {
                if (next === 'listening') {
                    gsap.to(eyeIrisEls, { scaleX: 1.15, scaleY: 1.15, transformOrigin: 'center', duration: 0.35, ease: 'back.out(2)' });
                } else if (next === 'talking') {
                    gsap.to(eyeIrisEls, { scaleX: 1, scaleY: 1, duration: 0.25, ease: 'power2.out' });
                } else {
                    gsap.to(eyeIrisEls, { scaleX: 0.9, scaleY: 0.9, duration: 0.4, ease: 'power2.inOut' });
                }
            } catch (_) {}
        }

        if (next === 'talking' && !audioCtx) _initAudioCtx();
        if (prev === 'talking' && next !== 'talking') _resetBars();
    }

    // 4. Web Audio — lazy init (AudioContext requires prior user gesture; TTS satisfies this)
    let audioCtx = null, analyser = null, freqData = null;

    function _initAudioCtx() {
        if (typeof ttsPlayer === 'undefined' || !ttsPlayer || !ttsPlayer.audio) return;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 64;
            analyser.smoothingTimeConstant = 0.75;
            freqData = new Uint8Array(analyser.frequencyBinCount);
            const src = audioCtx.createMediaElementSource(ttsPlayer.audio);
            src.connect(analyser);
            analyser.connect(audioCtx.destination);
        } catch (e) { audioCtx = null; analyser = null; }
    }

    function _resetBars() {
        barEls.forEach(b => {
            b.setAttribute('height', BAR_BASE_H);
            b.setAttribute('y', (BAR_Y_BOTTOM - BAR_BASE_H).toFixed(1));
        });
    }

    // 5. MutationObservers — no modifications to existing code
    new MutationObserver(() => {
        if (orbEl.classList.contains('speaking')) {
            avatarSetState('talking');
        } else if (avatarState === 'talking') {
            avatarSetState(micEl.classList.contains('active') ? 'listening' : 'idle');
        }
    }).observe(orbEl, { attributes: true, attributeFilter: ['class'] });

    new MutationObserver(() => {
        if (micEl.classList.contains('active')) {
            if (avatarState !== 'talking') avatarSetState('listening');
        } else if (avatarState === 'listening') {
            avatarSetState('idle');
        }
    }).observe(micEl, { attributes: true, attributeFilter: ['class'] });

    // 6. rAF loop — eye oscillation (listening) + lip sync bars (talking)
    const BIN_MAP = [2, 3, 5, 7, 9];

    (function _tick(ts) {
        requestAnimationFrame(_tick);
        if (avatarState === 'listening') {
            const sc = 1 + Math.sin((ts / 900) * Math.PI * 2) * 0.06;
            eyeIrisEls.forEach(e => {
                e.setAttribute('rx', (4 * sc).toFixed(2));
                e.setAttribute('ry', (3.8 * sc).toFixed(2));
            });
        } else if (avatarState === 'talking') {
            if (analyser && freqData) {
                if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
                analyser.getByteFrequencyData(freqData);
                barEls.forEach((bar, i) => {
                    const h = BAR_BASE_H + (freqData[BIN_MAP[i]] / 255) * BAR_MAX_EXTRA;
                    bar.setAttribute('height', h.toFixed(2));
                    bar.setAttribute('y', (BAR_Y_BOTTOM - h).toFixed(2));
                });
            } else {
                barEls.forEach((bar, i) => {
                    const h = BAR_BASE_H + Math.abs(Math.sin((ts / 220) + i * 0.9)) * 9;
                    bar.setAttribute('height', h.toFixed(2));
                    bar.setAttribute('y', (BAR_Y_BOTTOM - h).toFixed(2));
                });
            }
        }
    })(0);

    // 7. Initial state
    avatarContainer.classList.add('avatar-idle');

})();

document.addEventListener('DOMContentLoaded', init);