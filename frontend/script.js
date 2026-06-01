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
const SPEECH_SEND_DELAY_MS = 1000;   // silence after a final command before sending (was 1800 — felt sluggish)
const SPEECH_RESTART_DELAY_MS = 250; // gap between listening sessions; kept short so "Jarvis" isn't missed in dead air (was 700)
let speechSendTimeout = null;
let pendingSendTranscript = null;

// ─── High-accuracy voice: VAD-gated capture → Groq Whisper (/stt) ───────────
// When enabled, the mic audio is cleaned (noise-suppression + echo-cancellation
// + auto-gain + a gain boost) in the browser, a local voice-activity detector
// grabs just the spoken segments, and each segment is transcribed by Groq
// Whisper. On rate-limit/error we fall back to the browser's Web Speech engine
// so voice never breaks. The engine stays allocated across utterances.
let _voiceMode = 'whisper';            // 'whisper' | 'webspeech' (decided in startListening)
let _whisperListening = false;         // VAD is armed (acting on audio)
let _whisperCtx = null, _whisperStream = null, _whisperProcessor = null;
let _whisperSource = null, _whisperGain = null, _whisperSilent = null;
let _whisperSampleRate = 16000;
let _sttBusy = false;                  // a /stt request is in flight (don't overlap)
const WHISPER_GAIN = 1.4;              // extra sensitivity boost (helps soft/distant)
const VAD_END_SILENCE_MS = 700;        // trailing silence that ends a segment
const VAD_MAX_SEG_MS = 10000;          // hard cap on a single utterance
const VAD_MIN_SEG_MS = 250;            // ignore blips shorter than this
const VAD_PREROLL_FRAMES = 4;          // ~300ms kept before speech so onsets aren't clipped
let _vadSpeaking = false, _vadSilenceMs = 0, _vadSegMs = 0, _vadNoiseFloor = 0.01;
let _vadSegFrames = [];
const _vadPreroll = [];
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
// True if the *current* SpeechRecognition session captured Jarvis's voice at any
// point. SpeechRecognition buffers audio and can finalize a capture *after* the
// audio that caused it has stopped — so checking only `_jarvisSpeaking` at the
// moment a result arrives misses Jarvis-voice captures that finalize a few
// hundred ms after he stops. Once this flag is set, every result for the rest
// of the recognition session is dropped; it resets only when startListening()
// opens a fresh session.
let _micCurrentSessionTainted = false;

function _onJarvisSpeechStart() {
    _jarvisSpeaking = true;
    if (isListening) {
        // Mark the in-flight recognition session as tainted before we abort,
        // so any result that slips through during the teardown is dropped.
        _micCurrentSessionTainted = true;
        try {
            // abort() discards captured-but-not-yet-emitted speech. stop() would
            // let those captures become "final" results after _jarvisSpeaking
            // flips false, slipping through the gate and creating the loop.
            if (recognition && recognition.abort) recognition.abort();
            else if (recognition) recognition.stop();
        } catch (_) {}
    }
    // Wake-word mode: pause the state machine while Jarvis talks. Visual
    // feedback (BLOCKED) reflects that the mic isn't open, and _onJarvisSpeechEnd
    // will return us to PASSIVE after a drain delay.
    if (typeof settings !== 'undefined' && settings && settings.wakeWord && _micState !== MIC_STATE_OFF) {
        _clearWakeActiveTimer();
        _setMicState(MIC_STATE_BLOCKED);
    }
}

function _onJarvisSpeechEnd() {
    _jarvisSpeaking = false;
    if (typeof settings !== 'undefined' && settings && settings.wakeWord && _micState === MIC_STATE_BLOCKED) {
        // 400 ms drain so the tail of Jarvis's last word doesn't leak into the
        // mic capture, then return to passive wake-word listening.
        setTimeout(() => {
            if (!_jarvisSpeaking && !_videoWatchMode && !isStreaming) {
                _enterPassiveListening();
            }
        }, 400);
    } else {
        maybeRestartListening();
    }
}

// True while the user is watching a YouTube lecture/video. The video's audio
// plays through the speakers and the microphone picks it up; without this
// guard, every spoken word from the video is transcribed and sent to Jarvis,
// creating a feedback loop. Resumes when the user signals "done" (via the
// interactive_choice event) or manually clicks the mic.
let _videoWatchMode = false;
let _autoListenBeforeVideo = false;

function _enterVideoWatchMode() {
    if (_videoWatchMode) return;
    _videoWatchMode = true;
    _autoListenBeforeVideo = autoListenMode;
    autoListenMode = false;
    if (isListening) {
        try { recognition && recognition.stop(); } catch (_) {}
    }
    if (typeof micBtn !== 'undefined' && micBtn) {
        micBtn.classList.remove('auto-listen', 'listening');
        micBtn.title = 'Voice paused while a video is open — say "done" or click to resume';
    }
    if (typeof showToast === 'function') {
        showToast('🎬 Voice paused while you watch the video. Say "done" when finished — or click the mic to talk now.', 7000);
    }
}

function _exitVideoWatchMode() {
    if (!_videoWatchMode) return;
    _videoWatchMode = false;
    if (_autoListenBeforeVideo) {
        autoListenMode = true;
        _autoListenBeforeVideo = false;
        if (typeof micBtn !== 'undefined' && micBtn) {
            micBtn.classList.add('auto-listen');
            micBtn.title = 'Voice input — click to stop auto-listen';
        }
        maybeRestartListening();
    } else if (typeof micBtn !== 'undefined' && micBtn) {
        micBtn.title = 'Voice input';
    }
}

// ─── Wake-word state machine ("Jarvis" hands-free activation) ───────────────
// PASSIVE  : mic running, only acts on the "Jarvis" wake word
// ACTIVE   : wake word heard, command capture window open (10s)
// BLOCKED  : Jarvis is speaking / video is playing / response streaming
// OFF      : wake word disabled or mic permission not yet granted
const MIC_STATE_OFF = 'off';
const MIC_STATE_PASSIVE = 'passive';
const MIC_STATE_ACTIVE = 'active';
const MIC_STATE_BLOCKED = 'blocked';
let _micState = MIC_STATE_OFF;
let _wakeActiveTimer = null;
const WAKE_ACTIVE_WINDOW_MS = 10000;
// Substring matcher for the wake word. The SpeechRecognition engine mis-hears
// "Jarvis" constantly, so we accept a broad set of look-alikes/sound-alikes —
// recall matters more than precision here (a stray match just opens the 10s
// command window). Add more variants here if a real misread keeps slipping through.
const _WAKE_WORD_RE = /\b(jarvis|jarviss|jarvis's|jarvi|jarviz|jarvice|jarvees|javis|javies|javiss|jervis|jervice|jarwis|jarwiss|jaravis|jarvas|jaris|jarius|travis|charvis|harvis|garvis|marvis|narvis|sarvis|darvis|larvis|yarvis|service)\b/i;

function _matchWakeWord(text) {
    if (!text) return null;
    const m = _WAKE_WORD_RE.exec(text);
    if (!m) return null;
    const after = text.slice(m.index + m[0].length).trim().replace(/^[,.!?\s]+/, '');
    return { matched: m[0], remaining: after };
}

function _setMicState(newState) {
    if (_micState === newState) return;
    _micState = newState;
    if (!micBtn) return;
    micBtn.classList.remove('wake-word-mode', 'wake-active', 'listening', 'auto-listen');
    if (newState === MIC_STATE_PASSIVE) {
        micBtn.classList.add('wake-word-mode');
        micBtn.title = 'Wake word active — say "Jarvis" to talk';
    } else if (newState === MIC_STATE_ACTIVE) {
        micBtn.classList.add('wake-active', 'listening');
        micBtn.title = 'Listening, Sir — go ahead';
    } else if (newState === MIC_STATE_BLOCKED) {
        micBtn.title = _jarvisSpeaking ? 'Jarvis speaking…' : 'Mic paused';
    } else {
        micBtn.title = settings.wakeWord
            ? 'Click mic to enable wake word ("Jarvis")'
            : 'Voice input — click to start';
    }
}

function _clearWakeActiveTimer() {
    if (_wakeActiveTimer) {
        clearTimeout(_wakeActiveTimer);
        _wakeActiveTimer = null;
    }
}

function _startActiveWindow() {
    _setMicState(MIC_STATE_ACTIVE);
    _clearWakeActiveTimer();
    _wakeActiveTimer = setTimeout(() => {
        _wakeActiveTimer = null;
        if (_micState === MIC_STATE_ACTIVE) {
            if (speechWidget) speechWidget.classList.remove('visible');
            if (speechWidgetText) speechWidgetText.textContent = '';
            if (typeof showToast === 'function') {
                showToast('No command heard, returning to wake-word mode.', 3000);
            }
            _enterPassiveListening();
        }
    }, WAKE_ACTIVE_WINDOW_MS);
}

function _resetActiveWindow() {
    if (_micState !== MIC_STATE_ACTIVE) return;
    _clearWakeActiveTimer();
    _wakeActiveTimer = setTimeout(() => {
        _wakeActiveTimer = null;
        if (_micState === MIC_STATE_ACTIVE) _enterPassiveListening();
    }, WAKE_ACTIVE_WINDOW_MS);
}

function _enterPassiveListening() {
    _clearWakeActiveTimer();
    if (!settings || !settings.wakeWord) {
        _setMicState(MIC_STATE_OFF);
        autoListenMode = false;
        if (isListening) stopListening();
        return;
    }
    if (_jarvisSpeaking || _videoWatchMode || isStreaming) {
        _setMicState(MIC_STATE_BLOCKED);
        return;
    }
    _setMicState(MIC_STATE_PASSIVE);
    autoListenMode = true;
    if (!isListening) startListening();
}

function _enterActiveListening() {
    if (_jarvisSpeaking || _videoWatchMode) {
        _setMicState(MIC_STATE_BLOCKED);
        return;
    }
    autoListenMode = true;
    if (!isListening) startListening();
    _startActiveWindow();
}

function _disableMic() {
    _clearWakeActiveTimer();
    _setMicState(MIC_STATE_OFF);
    autoListenMode = false;
    _whisperListening = false;
    _stopWhisperEngine();
    if (isListening) stopListening();
}

// Called once at end of init(). The mic needs a user gesture to start, so we
// don't actually open it here — the first mic click does that. This just
// configures the button label to invite that first click.
function _maybeStartWakeWord() {
    if (!recognition) return;
    if (!settings || !settings.wakeWord) {
        if (micBtn) micBtn.title = 'Voice input — click to start';
        return;
    }
    _setMicState(MIC_STATE_OFF);
    if (micBtn) micBtn.title = 'Click mic once to enable wake word ("Jarvis")';
}

let _ttsAudio = null;   // dedicated pre-unlocked element for inline TTS playback
const SETTINGS_KEY = 'jarvis_settings';
const DEFAULT_SETTINGS = { autoOpenActivity: true, autoOpenSearchResults: true, thinkingSounds: true, voiceInterrupt: true, wakeWord: true, highAccuracyVoice: true };
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
const toggleWakeWord       = $('toggle-wake-word');
const toggleHighAccuracyVoice = $('toggle-high-accuracy-voice');
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
    // Mute the mic while the browser speaks — the audio comes through speakers
    // and would otherwise leak into the mic and trigger a feedback loop.
    let _markedSpeaking = false;
    const _endSpeech = () => {
        if (_markedSpeaking) { _markedSpeaking = false; _onJarvisSpeechEnd(); }
    };
    utter.onstart = () => { _onJarvisSpeechStart(); _markedSpeaking = true; };
    utter.onend = _endSpeech;
    utter.onerror = e => { console.warn('[TTS] speechSynthesis error:', e.error); _endSpeech(); };
    const setVoice = () => {
        const voices = window.speechSynthesis.getVoices();
        const v = voices.find(x => x.lang === 'en-IN') || voices.find(x => x.lang.startsWith('en-IN')) || voices.find(x => x.lang.startsWith('en'));
        if (v) utter.voice = v;
        try {
            window.speechSynthesis.speak(utter);
            console.log('[TTS] speechSynthesis speaking, voice:', utter.voice ? utter.voice.name : 'default');
        } catch (e) {
            console.warn('[TTS] speechSynthesis.speak() threw:', e);
            _endSpeech();
        }
    };
    if (window.speechSynthesis.getVoices().length > 0) { setVoice(); }
    else { window.speechSynthesis.onvoiceschanged = setVoice; }
}

// POST to /tts endpoint and play returned audio on the pre-unlocked element.
// Called from the per-message 🔊 button — guaranteed user gesture context.
async function speakMessageButton(btn, text) {
    if (!text) return;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    let spoke = false;
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
        // Mute mic while this plays (defense against feedback loop).
        _onJarvisSpeechStart();
        spoke = true;
        audio.onended = () => { try { URL.revokeObjectURL(url); } catch (_) {} _onJarvisSpeechEnd(); };
        audio.onerror = () => { try { URL.revokeObjectURL(url); } catch (_) {} _onJarvisSpeechEnd(); _browserSpeak(text); };
        audio.src = url;
        audio.currentTime = 0;
        audio.play().catch(() => { _onJarvisSpeechEnd(); _browserSpeak(text); });
    } catch (e) {
        console.warn('[speakMessageButton] backend failed:', e.message);
        if (spoke) _onJarvisSpeechEnd();
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
    btn.addEventListener('click', (e) => { e.preventDefault(); speakMessageButton(btn, text); });
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
        // Lifecycle counter — bumps on every reset(). Used to cancel stale
        // _browserSpeak fallback timers from previous streams so they don't
        // re-speak old text after a new message has started.
        this._lifecycleId = 0;
        this._pendingFallbackTimers = [];
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
        // Bump the lifecycle counter — any pending fallback timers from the
        // previous stream will see the new id and decline to fire.
        this._lifecycleId = (this._lifecycleId || 0) + 1;
        // Belt-and-braces: also clear the actual timer handles so the
        // _browserSpeak callback can never fire after reset.
        if (this._pendingFallbackTimers && this._pendingFallbackTimers.length) {
            for (const id of this._pendingFallbackTimers) {
                try { clearTimeout(id); } catch (_) {}
            }
            this._pendingFallbackTimers = [];
        }
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
        if (toggleWakeWord) toggleWakeWord.checked = settings.wakeWord;
        if (toggleHighAccuracyVoice) toggleHighAccuracyVoice.checked = settings.highAccuracyVoice;
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
    recognition.maxAlternatives = 5;  // more guesses for the wake-word scanner to find "Jarvis" in
    recognition.lang = 'en-IN';
    recognition.onresult = e => {
        if (!e.results || e.results.length === 0) return;
        // Drop anything the mic captured while Jarvis was speaking — this is Jarvis's own voice.
        // Also drop everything for the rest of this recognition session if Jarvis has
        // ever spoken during it: the SpeechRecognition engine can finalize a capture
        // *after* the audio that caused it ended, which would otherwise sneak Jarvis's
        // own words through the gate as a "user message" and create a feedback loop.
        if (_jarvisSpeaking || _micCurrentSessionTainted) {
            if (_jarvisSpeaking) _micCurrentSessionTainted = true;
            if (speechWidgetText) speechWidgetText.textContent = '';
            return;
        }
        // Drop anything captured while a YouTube lecture is open — the video's audio
        // leaks through the speakers and the mic transcribes it as fake user input.
        if (_videoWatchMode) {
            if (speechWidgetText) speechWidgetText.textContent = '';
            return;
        }
        const last = e.results[e.results.length - 1];
        // Collect every alternative the engine returned. The wake word often hides
        // in a shorter, lower-ranked guess, so we scan them all (below) instead of
        // trusting only the top/longest one.
        const alts = [];
        for (let i = 0; i < (last ? last.length : 0); i++) {
            const a = last[i] ? last[i].transcript.trim() : '';
            if (a) alts.push(a);
        }
        // Longest alternative = the command transcript (most complete phrasing).
        let transcript = '';
        for (const a of alts) { if (a.length > transcript.length) transcript = a; }
        const isFinal = last && last.isFinal;

        // === Wake-word PASSIVE mode ===
        // Only act on results that contain "Jarvis". Everything else is silent
        // background — the speech widget stays empty so it doesn't feel "always on".
        if (_micState === MIC_STATE_PASSIVE) {
            // Scan ALL alternatives — checking only the longest one silently drops
            // the wake word when the engine buries "Jarvis" in a shorter guess.
            // Among the guesses that DO contain it, keep the one carrying the most
            // command text, so "Jarvis what's the weather" beats a bare "Jarvis".
            let wake = null;
            for (const a of alts) {
                const w = _matchWakeWord(a);
                if (w && (!wake || w.remaining.length > wake.remaining.length)) wake = w;
            }
            if (!wake) {
                if (speechWidgetText) speechWidgetText.textContent = '';
                return;
            }
            if (speechWidget) speechWidget.classList.add('visible');
            if (wake.remaining && wake.remaining.length >= 2) {
                // Wake word + command in the same utterance: "Jarvis, what's the weather?"
                if (speechWidgetText) speechWidgetText.textContent = wake.remaining;
                if (isFinal) {
                    _clearWakeActiveTimer();
                    pendingSendTranscript = null;
                    clearTimeout(speechSendTimeout);
                    speechSendTimeout = null;
                    sendMessage(wake.remaining);
                } else {
                    // Interim — open the active window so the user has time to finish
                    if (_micState !== MIC_STATE_ACTIVE) _startActiveWindow();
                }
            } else {
                // Bare wake word — open the 10s command window
                if (speechWidgetText) speechWidgetText.textContent = 'Listening, Sir…';
                _startActiveWindow();
            }
            return;
        }

        // === Active command capture (manual mic, or after wake-word fired) ===
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
                if (settings.wakeWord) _enterPassiveListening();
                else stopListening();
                return;
            }
            // Ignore noise/very-short transcripts (ambient sound, breath, etc.)
            if (transcript.length < 2) return;
            // If the user said "Jarvis ..." in active mode, strip the prefix
            let cmd = transcript;
            const wakeStrip = _matchWakeWord(cmd);
            if (wakeStrip && wakeStrip.remaining && wakeStrip.remaining.length >= 2) {
                cmd = wakeStrip.remaining;
            }
            pendingSendTranscript = cmd;
            clearTimeout(speechSendTimeout);
            speechSendTimeout = setTimeout(() => {
                if (pendingSendTranscript) {
                    _clearWakeActiveTimer();
                    sendMessage(pendingSendTranscript);
                    pendingSendTranscript = null;
                }
                speechSendTimeout = null;
                // In wake-word mode, the BLOCKED→PASSIVE transition happens via
                // _onJarvisSpeechEnd or maybeRestartListening. Without wake word,
                // stop the mic the way the legacy click-toggle expects.
                if (!settings.wakeWord) stopListening();
            }, SPEECH_SEND_DELAY_MS);
        } else if (!isFinal) {
            // Interim activity in ACTIVE — extend the 10s window
            _resetActiveWindow();
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

// ─── High-accuracy voice engine (cleaned mic → local VAD → Groq Whisper) ────
function _whisperSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
        (window.AudioContext || window.webkitAudioContext));
}

function _resetWhisperVad() {
    _vadSpeaking = false; _vadSilenceMs = 0; _vadSegMs = 0;
    _vadSegFrames = []; _vadPreroll.length = 0;
}

async function _ensureWhisperEngine() {
    if (_whisperCtx) return;
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain(); gain.gain.value = WHISPER_GAIN;
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    // Mute mic→speakers (gain 0) so there's no echo, but keep the node connected
    // to the destination so onaudioprocess keeps firing.
    const silent = ctx.createGain(); silent.gain.value = 0;
    source.connect(gain); gain.connect(processor); processor.connect(silent); silent.connect(ctx.destination);
    processor.onaudioprocess = _whisperOnAudio;
    _whisperCtx = ctx; _whisperStream = stream; _whisperProcessor = processor;
    _whisperSource = source; _whisperGain = gain; _whisperSilent = silent;
    _whisperSampleRate = ctx.sampleRate || 16000;
    _resetWhisperVad();
}

function _stopWhisperEngine() {
    try { if (_whisperProcessor) _whisperProcessor.onaudioprocess = null; } catch (_) {}
    try { if (_whisperProcessor) _whisperProcessor.disconnect(); } catch (_) {}
    try { if (_whisperSource) _whisperSource.disconnect(); } catch (_) {}
    try { if (_whisperGain) _whisperGain.disconnect(); } catch (_) {}
    try { if (_whisperSilent) _whisperSilent.disconnect(); } catch (_) {}
    try { if (_whisperStream) _whisperStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { if (_whisperCtx) _whisperCtx.close(); } catch (_) {}
    _whisperCtx = _whisperStream = _whisperProcessor = _whisperSource = _whisperGain = _whisperSilent = null;
    _resetWhisperVad();
}

function _whisperOnAudio(e) {
    // Don't capture while Jarvis is speaking, a video is playing, a response is
    // streaming, the VAD is disarmed, or a /stt call is still in flight.
    if (!_whisperListening || _jarvisSpeaking || _videoWatchMode || isStreaming || _sttBusy) {
        if (_vadSpeaking) _resetWhisperVad();
        return;
    }
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) { const s = input[i]; sum += s * s; }
    const rms = Math.sqrt(sum / input.length);
    const frameMs = (input.length / _whisperSampleRate) * 1000;
    if (!_vadSpeaking) _vadNoiseFloor = _vadNoiseFloor * 0.95 + rms * 0.05;   // track quiet baseline
    const startThresh = Math.max(0.012, _vadNoiseFloor * 2.5 + 0.004);
    const endThresh = Math.max(0.008, _vadNoiseFloor * 1.8 + 0.002);
    const frame = new Float32Array(input);   // copy — the engine reuses `input`
    if (!_vadSpeaking) {
        _vadPreroll.push(frame);
        if (_vadPreroll.length > VAD_PREROLL_FRAMES) _vadPreroll.shift();
        if (rms > startThresh) {
            _vadSpeaking = true;
            _vadSegFrames = _vadPreroll.slice();
            _vadSegMs = _vadPreroll.length * frameMs;
            _vadSilenceMs = 0;
            _vadPreroll.length = 0;
        }
    } else {
        _vadSegFrames.push(frame);
        _vadSegMs += frameMs;
        if (rms < endThresh) {
            _vadSilenceMs += frameMs;
            if (_vadSilenceMs >= VAD_END_SILENCE_MS) _finalizeWhisperSegment();
        } else {
            _vadSilenceMs = 0;
        }
        if (_vadSegMs >= VAD_MAX_SEG_MS) _finalizeWhisperSegment();
    }
}

function _finalizeWhisperSegment() {
    const frames = _vadSegFrames;
    const segMs = _vadSegMs;
    _resetWhisperVad();
    if (segMs < VAD_MIN_SEG_MS) return;
    let len = 0;
    for (const f of frames) len += f.length;
    if (!len) return;
    const pcm = new Float32Array(len);
    let o = 0;
    for (const f of frames) { pcm.set(f, o); o += f.length; }
    const wav = _encodeWav(pcm, _whisperSampleRate);
    _sttBusy = true;
    if (speechWidgetText) speechWidgetText.textContent = '…';
    _sttTranscribe(wav)
        .then(text => { if (text) _onFinalVoiceText(text); })
        .catch(() => {})
        .finally(() => { _sttBusy = false; });
}

function _encodeWav(samples, sampleRate) {
    const len = samples.length;
    const buffer = new ArrayBuffer(44 + len * 2);
    const view = new DataView(buffer);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + len * 2, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, 'data'); view.setUint32(40, len * 2, true);
    let off = 44;
    for (let i = 0; i < len; i++) {
        let s = Math.max(-1, Math.min(1, samples[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(off, s, true); off += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
}

async function _sttTranscribe(blob) {
    const fd = new FormData();
    fd.append('file', blob, 'cmd.wav');
    let resp;
    try {
        resp = await fetch(`${API}/stt`, { method: 'POST', headers: { ...getAuthHeaders() }, body: fd });
    } catch (e) {
        _enterWebSpeechFallback();
        throw e;
    }
    // 429 = all Groq keys rate-limited; 503 = no key configured. Both → fall back.
    if (resp.status === 429 || resp.status === 503) {
        _enterWebSpeechFallback();
        throw new Error('stt unavailable ' + resp.status);
    }
    if (!resp.ok) throw new Error('stt http ' + resp.status);
    const data = await resp.json().catch(() => null);
    return (data && data.text ? String(data.text) : '').trim();
}

// Shared dispatcher for a complete recognized utterance (used by the Whisper
// engine). Mirrors the Web Speech final-result handling: wake gate in PASSIVE,
// command in ACTIVE.
function _onFinalVoiceText(text) {
    text = (text || '').trim();
    if (!text || text.length < 2) return;
    if (_jarvisSpeaking || _videoWatchMode || isStreaming) return;
    if (_micState === MIC_STATE_PASSIVE) {
        const wake = _matchWakeWord(text);
        if (!wake) { if (speechWidgetText) speechWidgetText.textContent = ''; return; }
        if (speechWidget) speechWidget.classList.add('visible');
        if (wake.remaining && wake.remaining.length >= 2) {
            if (speechWidgetText) speechWidgetText.textContent = wake.remaining;
            _clearWakeActiveTimer();
            sendMessage(wake.remaining);
        } else {
            if (speechWidgetText) speechWidgetText.textContent = 'Listening, Sir…';
            _startActiveWindow();
        }
        return;
    }
    // ACTIVE (woken, or manual mic): treat the utterance as a command.
    if (VOICE_STOP_COMMANDS.test(text)) {
        if (ttsPlayer) { ttsPlayer.stop(); ttsPlayer.stopped = false; }
        if (speechWidget) speechWidget.classList.remove('visible');
        if (speechWidgetText) speechWidgetText.textContent = '';
        _clearWakeActiveTimer();
        if (settings.wakeWord) _setMicState(MIC_STATE_PASSIVE);
        return;
    }
    let cmd = text;
    const ws = _matchWakeWord(cmd);
    if (ws && ws.remaining && ws.remaining.length >= 2) cmd = ws.remaining;
    if (speechWidgetText) speechWidgetText.textContent = cmd;
    _clearWakeActiveTimer();
    if (settings.wakeWord) _setMicState(MIC_STATE_PASSIVE);   // back to wake-gating after this command
    sendMessage(cmd);
}

// Whisper unavailable (rate-limited / errored) → switch to the browser engine
// for the rest of the session. Re-enable by reloading or toggling the setting.
function _enterWebSpeechFallback() {
    if (_voiceMode === 'webspeech') return;
    const wasArmed = _whisperListening;
    _stopWhisperEngine();
    _whisperListening = false;
    _sttBusy = false;
    _voiceMode = 'webspeech';
    isListening = false;
    if (typeof showToast === 'function') showToast('High-accuracy voice unavailable — using standard recognition.', 3500);
    if (wasArmed && autoListenMode && !isStreaming && !_jarvisSpeaking && !_videoWatchMode) {
        setTimeout(() => { if (_voiceMode === 'webspeech' && !isListening) startListening(); }, 200);
    }
}

function startListening() {
    if (!recognition || isStreaming || isListening) return;
    // Refuse to start the mic while Jarvis is speaking (or has audio queued).
    // Starting now would capture his own voice through the speakers and create a
    // feedback loop. The mic click handler is supposed to stop TTS before calling
    // this; the gate here catches code paths that don't (auto-restart, races).
    const ttsActive = _jarvisSpeaking ||
        (ttsPlayer && (ttsPlayer.playing || ttsPlayer.queue.length > 0));
    if (ttsActive) return;
    // High-accuracy path: run the cleaned-audio VAD→Whisper engine instead of the
    // browser recognizer. The engine stays allocated across utterances; here we
    // just arm it (lazily creating it on first use).
    if (settings.highAccuracyVoice && _whisperSupported()) {
        _voiceMode = 'whisper';
        isListening = true;
        _whisperListening = true;
        if (micBtn) micBtn.classList.add('listening');
        if (speechWidget) speechWidget.classList.add('visible');
        if (speechWidgetText) speechWidgetText.textContent = '';
        _ensureWhisperEngine().catch(() => _enterWebSpeechFallback());
        return;
    }
    _voiceMode = 'webspeech';
    if (isSafariOrIOS() && !safariVoiceHintShown) {
        showToast('Voice works best in Chrome. Safari has limited support.');
        safariVoiceHintShown = true;
    }
    isListening = true;
    // Fresh recognition session — clear any taint carried from a previous one.
    _micCurrentSessionTainted = false;
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
    // Whisper engine stays allocated between utterances — just disarm the VAD so
    // it stops acting on audio. Full teardown happens in _disableMic.
    if (_voiceMode === 'whisper') { _whisperListening = false; return; }
    try { recognition.stop(); } catch (_) {}
}

function maybeRestartListening() {
    if (!recognition) return;
    if (isStreaming) return;
    // Never restart while Jarvis is speaking — mic would capture Jarvis's own voice.
    // _onJarvisSpeechEnd() calls this function again once TTS finishes.
    if (_jarvisSpeaking) return;
    // Never restart while a YouTube lecture is open — _exitVideoWatchMode() calls
    // this function again once the user signals "done".
    if (_videoWatchMode) return;
    const ttsActive = ttsPlayer && (ttsPlayer.playing || ttsPlayer.queue.length > 0);
    if (ttsActive) return;
    if (!autoListenMode) return;
    setTimeout(() => {
        if (autoListenMode && !isStreaming && !isListening && recognition && !_jarvisSpeaking && !_videoWatchMode) {
            // Wake-word mode: never auto-restart into ACTIVE. The 10s command
            // window only opens after we hear "Jarvis" again. Returning here
            // means the previous response finished or the user cancelled.
            if (settings && settings.wakeWord && _micState !== MIC_STATE_ACTIVE) {
                _enterPassiveListening();
            } else {
                startListening();
            }
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
                const _myLifecycle = ttsPlayer ? ttsPlayer._lifecycleId : -1;
                const _timerId = setTimeout(() => {
                    if (!ttsPlayer) return;
                    // Stale guard: a newer message has started — don't re-speak old text.
                    if (ttsPlayer._lifecycleId !== _myLifecycle) return;
                    if (ttsPlayer._didPlay) return;
                    console.log('[TTS] audio not playing after 3s — browser fallback (vision)');
                    _browserSpeak(_savedResp2);
                }, 3000);
                if (ttsPlayer && ttsPlayer._pendingFallbackTimers) {
                    ttsPlayer._pendingFallbackTimers.push(_timerId);
                }
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
    // Accept legacy callers that passed a category string (e.g. 'error') as the
    // second arg; coerce it to a sensible default duration so the toast doesn't
    // vanish instantly (setTimeout treats non-numeric durations as 0).
    if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs <= 0) {
        durationMs = 5000;
    }
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
        // Manual override: if mic is paused because a video is being watched,
        // a click is an explicit "I'm ready to talk now" signal — exit watch mode.
        if (_videoWatchMode) {
            _autoListenBeforeVideo = true;
            _exitVideoWatchMode();
            return;
        }
        speechErrorRetryCount = 0;

        // Interrupt Jarvis if he's currently speaking: stop the audio, wait for
        // the speaker buffer to drain, then open the mic in ACTIVE mode.
        const ttsActive = _jarvisSpeaking ||
            (ttsPlayer && (ttsPlayer.playing || ttsPlayer.queue.length > 0));
        if (ttsActive) {
            if (ttsPlayer) { ttsPlayer.stop(); ttsPlayer.stopped = false; }
            try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
            setTimeout(() => {
                if (!_jarvisSpeaking) _enterActiveListening();
            }, 400);
            return;
        }

        // State-based click behaviour
        if (_micState === MIC_STATE_ACTIVE) {
            // Cancel the current command window
            if (settings.wakeWord) _enterPassiveListening();
            else _disableMic();
        } else if (_micState === MIC_STATE_PASSIVE) {
            // Skip wake-word check — user wants to talk right now
            _enterActiveListening();
        } else {
            // OFF or BLOCKED → start listening
            if (settings.wakeWord) {
                _enterPassiveListening();
                showToast('Wake word active. Say "Jarvis" anytime to talk.', 4500);
            } else {
                _enterActiveListening();
            }
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
    if (toggleWakeWord) {
        toggleWakeWord.addEventListener('change', () => {
            settings.wakeWord = toggleWakeWord.checked;
            saveSettings();
            // Apply immediately. If turning on, drop into PASSIVE listening when
            // possible (mic permission must already be granted from a prior
            // click — otherwise the title prompts the user to click).
            if (settings.wakeWord) {
                if (_jarvisSpeaking || _videoWatchMode || isStreaming) {
                    _setMicState(MIC_STATE_BLOCKED);
                } else if (recognition) {
                    _enterPassiveListening();
                    showToast('Wake word enabled. Say "Jarvis" to talk.', 4000);
                } else {
                    showToast('Wake word enabled. Speech recognition is not available in this browser.', 5000);
                }
            } else {
                _disableMic();
                showToast('Wake word disabled. Click the mic to talk.', 3500);
            }
        });
    }
    if (toggleHighAccuracyVoice) {
        toggleHighAccuracyVoice.addEventListener('change', () => {
            settings.highAccuracyVoice = toggleHighAccuracyVoice.checked;
            saveSettings();
            // Apply live: tear down whatever engine is currently running (in its
            // current mode), then re-arm on the newly chosen engine if the mic was on.
            const wasListening = isListening || _whisperListening;
            if (_voiceMode === 'whisper') { _whisperListening = false; _stopWhisperEngine(); }
            else { try { if (recognition) recognition.stop(); } catch (_) {} }
            isListening = false;
            _voiceMode = (settings.highAccuracyVoice && _whisperSupported()) ? 'whisper' : 'webspeech';
            showToast(settings.highAccuracyVoice
                ? 'High-accuracy voice on (Whisper).'
                : 'High-accuracy voice off — using standard recognition.', 3000);
            if (wasListening && autoListenMode && !isStreaming && !_jarvisSpeaking && !_videoWatchMode) {
                setTimeout(() => { if (!isListening) startListening(); }, 250);
            }
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
    // Clear video-watch mode so the new chat starts with a clean mic state
    if (_videoWatchMode) {
        _videoWatchMode = false;
        _autoListenBeforeVideo = false;
    }
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

// Like safeUrlForHref, but returns the RAW (un-escaped) URL for use with
// window.open / location.href. escapeAttr turns `&` into `&amp;`, which is
// correct inside an href="" attribute (the browser decodes it on click) but
// breaks window.open — it would request a literal `&amp;`, so e.g. a Dropbox
// link `...?rlkey=x&dl=0` becomes `...?rlkey=x&amp;dl=0` → Dropbox Error 400.
function safeUrlForOpen(url) {
    if (!url || typeof url !== 'string') return '';
    const u = url.trim();
    if (u.startsWith('https://') || u.startsWith('http://')) return u;
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
                        // Pause speech recognition — the video's audio leaks through the speakers
                        // and the mic would otherwise transcribe it as user input (loop).
                        _enterVideoWatchMode();
                        window.open(data.youtube_detected.url, '_blank');
                    }
                    if (data.interactive_choice && data.interactive_choice.type === 'youtube_analysis') {
                        // User signalled "done" — server acknowledged. Resume mic if it was on.
                        _exitVideoWatchMode();
                        renderYouTubeChoiceButtons(data.interactive_choice.video_id, contentEl);
                    }
                    if (data.practice_files) {
                        renderPracticeFiles(data.practice_files, contentEl);
                    }
                    if (data.practicals) {
                        renderPracticalBundle(data.practicals, contentEl);
                    }
                    if (data.notes) {
                        renderNotesCard(data.notes, contentEl);
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
                const _myLifecycle = ttsPlayer ? ttsPlayer._lifecycleId : -1;
                const _timerId = setTimeout(() => {
                    if (!ttsPlayer) return;
                    // Stale guard: ttsPlayer.reset() bumps _lifecycleId for every new
                    // message. If we're now on a newer lifecycle, this fallback is
                    // for stale text — don't speak it (would be a duplicate / wrong
                    // voice playing the previous message).
                    if (ttsPlayer._lifecycleId !== _myLifecycle) return;
                    if (ttsPlayer._didPlay) return;
                    console.log('[TTS] audio received but not playing after 3s — browser fallback');
                    _browserSpeak(_savedResp);
                }, 3000);
                if (ttsPlayer && ttsPlayer._pendingFallbackTimers) {
                    ttsPlayer._pendingFallbackTimers.push(_timerId);
                }
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
    const pracBtn = document.createElement('button');
    pracBtn.className = 'yt-choice-btn';
    pracBtn.innerHTML = '&#128170; Practical Exercises';
    const notesBtn = document.createElement('button');
    notesBtn.className = 'yt-choice-btn';
    notesBtn.innerHTML = '&#128221; Notes / PPT';
    wrap.appendChild(mcqBtn);
    wrap.appendChild(sumBtn);
    wrap.appendChild(pracBtn);
    wrap.appendChild(notesBtn);
    target.appendChild(wrap);
    scrollToBottom();

    const disableAll = () => { mcqBtn.disabled = true; sumBtn.disabled = true; pracBtn.disabled = true; notesBtn.disabled = true; };
    mcqBtn.addEventListener('click', () => {
        disableAll();
        mcqBtn.classList.add('selected');
        startQuiz(videoId);
    });
    sumBtn.addEventListener('click', () => {
        disableAll();
        sumBtn.classList.add('selected');
        startSummary(videoId);
    });
    pracBtn.addEventListener('click', () => {
        disableAll();
        pracBtn.classList.add('selected');
        startPracticals(videoId);
    });
    notesBtn.addEventListener('click', () => {
        notesBtn.classList.add('selected');
        startNotes();
    });
}

// Ask the server for this session's lecture notes (resolved from pending_youtube
// context) and render the link card. Mirrors startPracticals' SSE read.
async function startNotes() {
    const loadingEl = addMessage('assistant', 'Fetching the notes for this lesson, Sir…');
    try {
        const res = await fetch(`${API}/chat/jarvis/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                message: 'give me notes for this session',
                session_id: sessionId,
                tts: false,
            }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let notes = null;
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.notes) notes = data.notes;
                    if ('chunk' in data) text += (data.chunk || '');
                } catch (_) {}
            }
        }
        if (loadingEl && loadingEl.closest('.message')) loadingEl.closest('.message').remove();
        const contentEl = addMessage('assistant', notes ? '' : (text || "Sir, no notes are saved for this lesson yet.")).parentElement.querySelector('.msg-content');
        if (notes) renderNotesCard(notes, contentEl);
    } catch (e) {
        if (loadingEl) loadingEl.textContent = `Sorry Sir, I couldn't load the notes: ${e.message}`;
    }
}

// Render a clickable notes card and open the document in a new tab.
function renderNotesCard(notes, contentEl) {
    const target = contentEl || Array.from(
        document.querySelectorAll('.message.assistant .msg-content')
    ).pop();
    if (!target || !notes || !notes.notes_url) return;
    const href = safeUrlForHref(notes.notes_url);
    if (!href) return;

    const friendlyClass = notes.class_name === 'UKG' ? 'UKG' : `Class ${String(notes.class_name).replace('class_', '')}`;
    const typeLabel = ({ slides: 'Slides', pdf: 'PDF', ppt: 'PowerPoint', doc: 'Document' })[notes.notes_type] || 'Notes';
    const icon = notes.notes_type === 'pdf' ? '📄' : (notes.notes_type === 'ppt' || notes.notes_type === 'slides') ? '📊' : '📝';

    const card = document.createElement('div');
    card.className = 'notes-card';
    card.innerHTML = `
        <div class="notes-card-icon">${icon}</div>
        <div class="notes-card-body">
            <div class="notes-card-title">${escapeHtml(friendlyClass)} • Chapter ${notes.chapter} Notes</div>
            <div class="notes-card-meta">${escapeHtml(typeLabel)}${notes.title ? ' • ' + escapeHtml(notes.title) : ''}</div>
        </div>
        <a class="notes-card-open" href="${href}" target="_blank" rel="noopener">Open ↗</a>`;
    target.appendChild(card);
    scrollToBottom();

    // Auto-open in a new tab (the student asked for "notes on this session").
    // Use the RAW url — window.open does not decode the `&amp;` that the href
    // attribute needs, which otherwise breaks Dropbox links (Error 400).
    const openHref = safeUrlForOpen(notes.notes_url);
    if (openHref) { try { window.open(openHref, '_blank', 'noopener'); } catch (_) {} }
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
        currentQuiz = { questions: data.questions, currentIdx: 0, score: 0, video_id: videoId };
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
            <button class="quiz-action-btn" id="quiz-practical-btn">&#128170; Try Practical</button>
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
    const pracBtnEl = card.querySelector('#quiz-practical-btn');
    if (pracBtnEl) {
        pracBtnEl.addEventListener('click', () => {
            pracBtnEl.disabled = true;
            const vid = (pendingYouTube && pendingYouTube.video_id) || (currentQuiz && currentQuiz.video_id);
            voiceQuizMode = false;
            _quizListening = false;
            currentQuiz = null;
            if (vid) {
                startPracticals(vid);
            } else {
                addMessage('assistant', 'Sir, I need the video context to find practicals. Open the lecture again.');
            }
        });
    }
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


// ─── Feature 9 — Practical exercises (student UI) ────────────────────────────

async function startPracticals(videoId) {
    // The server resolves which class/chapter this video maps to (via pending_youtube
    // context) and returns the bundle — which now carries the teacher-saved,
    // grade-aware practice_tasks. No live generation: students only see what the
    // teacher generated and saved in the Lecture Panel.
    const loadingEl = addMessage('assistant', 'Loading your practice, Sir — just a moment...');
    try {
        const res = await fetch(`${API}/chat/jarvis/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                message: 'give me practice for this lecture',
                session_id: sessionId,
                tts: false,
            }),
        });
        if (!res.ok || !res.body) {
            throw new Error(`HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let bundle = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.practicals) bundle = data.practicals;
                } catch (_) {}
            }
        }
        if (loadingEl && loadingEl.closest('.message')) loadingEl.closest('.message').remove();
        if (!bundle) {
            addMessage('assistant', "Sir, I couldn't load practice for this lecture.");
            return;
        }
        const contentEl = addMessage('assistant', '').parentElement.querySelector('.msg-content') || addMessage('assistant', '');
        renderPracticalBundle(bundle, contentEl);
    } catch (e) {
        if (loadingEl) loadingEl.textContent = `Sorry Sir, practice failed to load: ${e.message}`;
    }
}

// Render one practice activity card. activity_type-aware: shows a code block and
// platform badge only for coding tasks; renders resource links, materials, and
// steps when present. Used for both student-facing and admin-preview cards.
function _renderAITaskCard(task, opts) {
    opts = opts || {};
    const steps = (task.steps || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');
    const outcomes = (task.learning_outcomes || []).map(o => `<li>${escapeHtml(o)}</li>`).join('');
    const materials = (task.materials || []).map(m => `<li>${escapeHtml(m)}</li>`).join('');
    const code = task.starter_code ? `<pre class="practical-code"><code>${escapeHtml(task.starter_code)}</code></pre>` : '';
    const resources = (task.resources || [])
        .map(r => {
            const href = safeUrlForHref(r.url);
            if (!href) return '';
            return `<a class="practical-resource-link" href="${href}" target="_blank" rel="noopener">${escapeHtml(r.label || r.url)} ↗</a>`;
        })
        .filter(Boolean)
        .join('');
    const activity = task.activity_type ? `<span class="practical-badge practical-activity">${escapeHtml(task.activity_type)}</span>` : '';
    // Platform badge only meaningful for coding tasks (non-coding tasks have it empty).
    const platform = task.platform_suggestion
        ? `<span class="practical-badge practical-platform">${escapeHtml(task.platform_suggestion)}</span>` : '';
    const removeBtn = opts.removable
        ? `<button class="practical-card-remove" data-idx="${opts.idx}" title="Remove this activity">✕</button>` : '';
    return `
        <div class="practical-card practical-ai-card">
            ${removeBtn}
            <div class="practical-card-title">
                ${activity}
                <span class="practical-badge practical-difficulty practical-difficulty-${escapeHtml(task.difficulty || 'beginner')}">${escapeHtml(task.difficulty || 'beginner')}</span>
                <span class="practical-badge practical-time">${task.estimated_minutes || 30} min</span>
                ${platform}
                ${escapeHtml(task.title)}
            </div>
            <p class="practical-card-desc">${escapeHtml(task.description)}</p>
            ${steps ? `<div class="practical-steps"><strong>Steps:</strong><ol>${steps}</ol></div>` : ''}
            ${materials ? `<div class="practical-materials"><strong>You'll need:</strong><ul>${materials}</ul></div>` : ''}
            ${code}
            ${resources ? `<div class="practical-resources"><strong>Links:</strong> ${resources}</div>` : ''}
            ${outcomes ? `<div class="practical-outcomes"><strong>You'll learn:</strong><ul>${outcomes}</ul></div>` : ''}
        </div>`;
}

function renderPracticalBundle(bundle, contentEl) {
    const target = contentEl || Array.from(
        document.querySelectorAll('.message.assistant .msg-content')
    ).pop();
    if (!target || !bundle) return;
    const friendlyClass = bundle.class_name === 'UKG' ? 'UKG' : `Class ${bundle.class_name.replace('class_', '')}`;
    const wrap = document.createElement('div');
    // practice-sheet gives a clean white, high-contrast, printable surface so the
    // animated background doesn't bleed through the questions.
    wrap.className = 'practical-bundle practice-sheet';

    const practiceTasks = bundle.practice_tasks || [];

    const header = document.createElement('div');
    header.className = 'practical-bundle-header';
    header.innerHTML = `
        <div class="practical-bundle-heading">
            <span class="practical-bundle-title">💪 Practice</span>
            <span class="practical-bundle-context">${escapeHtml(friendlyClass)} • Chapter ${bundle.chapter}${bundle.lecture && bundle.lecture.title ? ' • ' + escapeHtml(bundle.lecture.title) : ''}</span>
        </div>
    `;
    // Download button — only meaningful when there are activities to put on the sheet.
    if (practiceTasks.length > 0) {
        const dlBtn = document.createElement('button');
        dlBtn.className = 'practice-download-pdf-btn';
        dlBtn.innerHTML = '⬇ Download';
        dlBtn.title = 'Download this practice sheet as a PDF';
        dlBtn.addEventListener('click', () => buildPracticePdf(bundle));
        header.appendChild(dlBtn);
    }
    wrap.appendChild(header);
    const curated = bundle.curated || [];
    const pdfs = bundle.class_pdfs || [];

    // Section 0 (primary): teacher-saved, grade-aware practice activities
    if (practiceTasks.length > 0) {
        const aiSection = document.createElement('div');
        aiSection.className = 'practical-section practical-section-ai';
        aiSection.innerHTML = `
            <div class="practical-section-header">
                <span class="practical-section-icon">🎯</span>
                <span class="practical-section-title">Activities for this lesson</span>
            </div>`;
        const cards = document.createElement('div');
        cards.className = 'practical-cards';
        cards.innerHTML = practiceTasks.map(t => _renderAITaskCard(t)).join('');
        aiSection.appendChild(cards);
        wrap.appendChild(aiSection);
    } else if (curated.length === 0 && pdfs.length === 0) {
        const p = document.createElement('p');
        p.className = 'practical-empty';
        p.textContent = "Your teacher hasn't added practice for this lesson yet.";
        wrap.appendChild(p);
    }

    // Section 1: legacy curated links (only when present)
    if (curated.length > 0) {
        const curatedSection = document.createElement('div');
        curatedSection.className = 'practical-section practical-section-curated';
        curatedSection.innerHTML = `
            <div class="practical-section-header">
                <span class="practical-section-icon">💡</span>
                <span class="practical-section-title">More resources</span>
            </div>`;
        const cards = document.createElement('div');
        cards.className = 'practical-cards';
        cards.innerHTML = curated.map(p => `
            <div class="practical-card practical-curated-card">
                <div class="practical-card-title">
                    <span class="practical-badge practical-platform">${escapeHtml(p.platform)}</span>
                    <span class="practical-badge practical-difficulty practical-difficulty-${escapeHtml(p.difficulty)}">${escapeHtml(p.difficulty)}</span>
                    <span class="practical-badge practical-time">${p.estimated_minutes} min</span>
                    ${escapeHtml(p.title)}
                </div>
                <p class="practical-card-desc">${escapeHtml(p.description)}</p>
                <a class="practical-open-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">
                    Open exercise →
                </a>
            </div>
        `).join('');
        curatedSection.appendChild(cards);
        wrap.appendChild(curatedSection);
    }

    // Section 2: class PDFs (general material) — `pdfs` declared above
    if (pdfs.length > 0) {
        const pdfSection = document.createElement('div');
        pdfSection.className = 'practical-section practical-section-pdfs';
        pdfSection.innerHTML = `
            <div class="practical-section-header">
                <span class="practical-section-icon">📚</span>
                <span class="practical-section-title">General Class Material</span>
            </div>`;
        const pdfList = document.createElement('div');
        pdfList.className = 'practical-pdf-list';
        pdfList.innerHTML = pdfs.map(f => `
            <div class="practice-card">
                <div class="practice-card-info">
                    <div class="practice-card-name">${escapeHtml(f.filename)}</div>
                    <div class="practice-card-meta">${escapeHtml(f.size_label)}</div>
                </div>
                <div class="practice-card-btns">
                    <a class="practice-open-btn" href="${escapeHtml(f.download_url)}" target="_blank" rel="noopener">Open</a>
                    <a class="practice-download-btn" href="${escapeHtml(f.download_url)}" download>Download</a>
                </div>
            </div>
        `).join('');
        pdfSection.appendChild(pdfList);
        wrap.appendChild(pdfSection);
    }

    target.appendChild(wrap);
    scrollToBottom();
}

// Print the practice sheet to PDF via a hidden iframe.
//
// Why a hidden iframe (not window.open + document.write): the popup approach
// left a blank `about:blank` tab on the live Space — popups get downgraded /
// the written auto-print script doesn't run, so nothing renders. The iframe
// stays in the current tab: no popup blocker, no stray tab, and print() targets
// ONLY the iframe's document.
//
// Why not jsPDF: jsPDF's built-in fonts are Latin-1 only, so Hindi/Devanagari
// content (lessons are often in Hindi) came out as garbage — each codepoint was
// truncated to its low byte and drawn as a random Latin glyph. The browser
// shapes Devanagari (and any Unicode script) correctly, so we render the EXACT
// same card HTML the on-screen sheet uses and let the browser print it. The PDF
// is a true, identical replica of the on-screen practice sheet.
function buildPracticePdf(bundle) {
    const tasks = (bundle && bundle.practice_tasks) || [];
    if (!tasks.length) {
        showToast('No activities to download.', 4000);
        return;
    }

    const friendlyClass = bundle.class_name === 'UKG' ? 'UKG' : `Class ${String(bundle.class_name).replace('class_', '')}`;
    const lectureTitle = (bundle.lecture && bundle.lecture.title) || '';
    const docTitle = `Practice_${friendlyClass.replace(/\s+/g, '')}_Chapter${bundle.chapter}`;
    const context = `${friendlyClass} • Chapter ${bundle.chapter}${lectureTitle ? ' • ' + lectureTitle : ''}`;

    // Reuse the EXACT on-screen card markup so the PDF matches the sheet 1:1.
    const cardsHtml = tasks.map(t => _renderAITaskCard(t, {})).join('');

    // Self-contained stylesheet mirroring the on-screen .practice-sheet (white
    // surface, dark text, the same coloured badges and purple activity accent).
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(docTitle)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Nirmala UI", system-ui, Arial, sans-serif;
         color: #1f2937; background: #fff; margin: 0; padding: 28px 32px; line-height: 1.45;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet-header { border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 16px; }
  .sheet-title { font-size: 20px; font-weight: 700; color: #111827; }
  .sheet-context { font-size: 13px; color: #6b7280; margin-top: 3px; }
  .sheet-generated { font-size: 11px; color: #9ca3af; margin-top: 3px; }
  .practical-cards { display: flex; flex-direction: column; gap: 12px; }
  .practical-card { padding: 12px 14px; background: #fff; border: 1px solid #e5e7eb;
                    border-left: 3px solid #a855f7; border-radius: 10px; page-break-inside: avoid; }
  .practical-card-remove { display: none; }
  .practical-card-title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
                          font-size: 15px; font-weight: 600; color: #111827; margin-bottom: 6px; }
  .practical-card-desc { font-size: 13px; color: #374151; line-height: 1.5; margin: 0 0 8px; }
  .practical-badge { display: inline-flex; align-items: center; font-size: 11px; font-weight: 500;
                     padding: 2px 8px; border-radius: 10px; background: #eef2ff; color: #3730a3; }
  .practical-activity { background: #f3e8ff; color: #6b21a8; }
  .practical-platform { background: #e0e7ff; color: #3730a3; }
  .practical-time { background: #fef3c7; color: #92400e; }
  .practical-difficulty-beginner { background: #dcfce7; color: #166534; }
  .practical-difficulty-intermediate { background: #fef3c7; color: #92400e; }
  .practical-difficulty-advanced { background: #fee2e2; color: #991b1b; }
  .practical-steps, .practical-outcomes, .practical-materials, .practical-resources {
      font-size: 13px; color: #374151; margin-top: 8px; }
  .practical-steps ol, .practical-outcomes ul, .practical-materials ul {
      margin: 4px 0 0; padding-left: 22px; line-height: 1.55; }
  .practical-resources { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .practical-resource-link { display: inline-block; font-size: 12px; color: #4338ca;
      text-decoration: none; padding: 2px 8px; border: 1px solid #c7d2fe; border-radius: 8px; }
  .practical-code { margin: 10px 0; padding: 10px 12px; background: #f8fafc; border: 1px solid #e5e7eb;
      border-radius: 8px; font-size: 12px; color: #1e293b; white-space: pre-wrap; word-break: break-word;
      font-family: "Consolas", "Courier New", monospace; }
  .practical-code code { background: none; padding: 0; color: inherit; }
  @page { margin: 16mm; }
</style></head>
<body>
  <div class="sheet-header">
    <div class="sheet-title">💪 Practice Sheet</div>
    <div class="sheet-context">${escapeHtml(context)}</div>
    <div class="sheet-generated">Generated by J.A.R.V.I.S · ${escapeHtml(new Date().toLocaleDateString())}</div>
  </div>
  <div class="practical-cards">${cardsHtml}</div>
</body></html>`;

    // Drop any previous print frame, then create a fresh off-screen one.
    const prev = document.getElementById('practice-print-frame');
    if (prev) prev.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'practice-print-frame';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.title = docTitle;   // hints the default "Save as PDF" filename
    // Off-screen with real dimensions so the inner document lays out for print.
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;';
    iframe.onload = () => {
        try {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
        } catch (e) {
            showToast('Could not open the print dialog: ' + e.message, 6000);
        }
        // print() blocks until the dialog closes; clean up shortly after.
        setTimeout(() => { try { iframe.remove(); } catch (_) {} }, 1000);
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
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
                        <button class="btn-mini lecture-edit-btn" data-class="${l.class_name}" data-chapter="${l.chapter}" title="Edit lecture">Edit</button>
                        <button class="btn-mini lecture-prac-btn" data-class="${l.class_name}" data-chapter="${l.chapter}" data-title="${_esc(l.title)}" title="Manage practical exercises">Practicals</button>
                        <button class="btn-mini lecture-del-btn" data-class="${l.class_name}" data-chapter="${l.chapter}" title="Delete lecture">Delete</button>
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
        listEl.querySelectorAll('.lecture-prac-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const cls = btn.getAttribute('data-class');
                const ch = parseInt(btn.getAttribute('data-chapter'), 10);
                const title = btn.getAttribute('data-title') || '';
                _openPracticalsAdminPanel(cls, ch, title);
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
    const notesUrl = $('lecture-notes-url');
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
        if (notesUrl) notesUrl.value = lec.notes_url || '';
    } else {
        if (title) title.textContent = 'Add Lecture';
        if (mode_input) mode_input.value = 'add';
        if (orig) orig.value = '';
        if (cls) { cls.disabled = false; cls.value = 'class_1'; }
        if (ch) { ch.disabled = false; ch.value = ''; }
        if (t) t.value = '';
        if (url) url.value = '';
        if (notesUrl) notesUrl.value = '';
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
    const notesVal = (($('lecture-notes-url') || {}).value || '').trim();
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
            // Persist the notes URL too (separate endpoint). The lecture now exists,
            // so set/clear is safe. A bad notes URL keeps the form open so it can be fixed.
            const notesOk = await _saveLectureNotes(cls, ch, notesVal, setErr);
            if (!notesOk) {
                if (saveBtn) saveBtn.disabled = false;
                _refreshLecturesList();   // lecture itself saved fine
                return;
            }
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

// Save or clear the notes URL for a lecture. Returns true on success (incl. no-op),
// false if a non-empty URL was rejected (so the caller can keep the form open).
async function _saveLectureNotes(cls, ch, notesVal, setErr) {
    try {
        if (notesVal) {
            const res = await _adminFetch(`/lectures/${cls}/${ch}/notes`, {
                method: 'PUT',
                body: JSON.stringify({ notes_url: notesVal }),
            });
            if (!res.ok) {
                let detail = `Notes URL rejected (HTTP ${res.status}).`;
                try { const j = await res.json(); detail = j.detail || detail; } catch (_) {}
                if (setErr) setErr(detail);
                return false;
            }
        } else {
            // No URL — clear any existing notes. 404 just means there were none.
            const res = await _adminFetch(`/lectures/${cls}/${ch}/notes`, { method: 'DELETE' });
            if (!res.ok && res.status !== 404 && res.status !== 204) {
                // Non-fatal: lecture saved, notes clear failed. Surface but don't block.
                showToast(`Note: couldn't clear old notes (HTTP ${res.status}).`, 5000);
            }
        }
        return true;
    } catch (e) {
        if (setErr) setErr(`Network error saving notes: ${e.message}`);
        return false;
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


// ─── Feature 9: Practicals admin panel ───────────────────────────────────────

let _practicalsCurrentClass = null;
let _practicalsCurrentChapter = null;
let _practicalsCurrentLectureTitle = '';

// Working set of practice tasks the teacher is currently reviewing (before save).
let _practiceWorkingSet = [];
let _practiceSavedExists = false;

function _openPracticalsAdminPanel(class_name, chapter, lecture_title) {
    _practicalsCurrentClass = class_name;
    _practicalsCurrentChapter = chapter;
    _practicalsCurrentLectureTitle = lecture_title || '';
    _practiceWorkingSet = [];
    _practiceSavedExists = false;
    const panel = $('practicals-panel');
    const ctx = $('practicals-context');
    const titleEl = $('practicals-panel-title');
    const friendlyClass = class_name === 'UKG' ? 'UKG' : `Class ${class_name.replace('class_', '')}`;
    if (titleEl) titleEl.textContent = `Practice — ${friendlyClass} Chapter ${chapter}`;
    if (ctx) ctx.textContent = lecture_title ? `Lecture: ${lecture_title}` : '';
    if (panel) {
        panel.classList.add('open');
        panel.setAttribute('aria-hidden', 'false');
    }
    if (typeof updatePanelOverlay === 'function') updatePanelOverlay();
    _loadSavedPractice();
}

function _closePracticalsAdminPanel(allTheWay) {
    const panel = $('practicals-panel');
    if (panel) {
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
    }
    _practicalsCurrentClass = null;
    _practicalsCurrentChapter = null;
    _practicalsCurrentLectureTitle = '';
    _practiceWorkingSet = [];
    if (allTheWay && typeof _closeLecturesPanel === 'function') _closeLecturesPanel();
    if (typeof updatePanelOverlay === 'function') updatePanelOverlay();
}

function _practiceStatus(msg, kind) {
    const el = $('practice-admin-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'practice-admin-status' + (kind ? ' practice-admin-status-' + kind : '');
}

function _practiceToggleButtons() {
    const saveBtn = $('practice-save-btn');
    const clearBtn = $('practice-clear-btn');
    const genBtn = $('practice-generate-btn');
    const dlBtn = $('practice-download-btn');
    const hasWorking = _practiceWorkingSet.length > 0;
    if (saveBtn) saveBtn.style.display = hasWorking ? '' : 'none';
    if (clearBtn) clearBtn.style.display = _practiceSavedExists ? '' : 'none';
    if (dlBtn) dlBtn.style.display = hasWorking ? '' : 'none';
    if (genBtn) genBtn.textContent = hasWorking ? '🔄 Regenerate' : '✨ Generate Practice';
}

// Download the current admin working set as a PDF (homework distribution).
function _downloadPracticePdf() {
    buildPracticePdf({
        class_name: _practicalsCurrentClass,
        chapter: _practicalsCurrentChapter,
        lecture: { title: _practicalsCurrentLectureTitle || '' },
        practice_tasks: _practiceWorkingSet,
    });
}

function _renderPracticeAdminCards() {
    const wrap = $('practice-admin-cards');
    if (!wrap) return;
    if (!_practiceWorkingSet.length) {
        wrap.innerHTML = '';
        _practiceToggleButtons();
        return;
    }
    wrap.innerHTML = _practiceWorkingSet
        .map((t, i) => _renderAITaskCard(t, { removable: true, idx: i }))
        .join('');
    wrap.querySelectorAll('.practical-card-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.getAttribute('data-idx'), 10);
            if (!isNaN(idx)) {
                _practiceWorkingSet.splice(idx, 1);
                _renderPracticeAdminCards();
            }
        });
    });
    _practiceToggleButtons();
}

async function _loadSavedPractice() {
    _renderPracticeAdminCards();
    _practiceStatus('Loading…');
    try {
        const res = await _adminFetch(`/lectures/${_practicalsCurrentClass}/${_practicalsCurrentChapter}/practicals`);
        if (!res.ok) {
            _practiceStatus(`Failed to load (HTTP ${res.status}).`, 'error');
            return;
        }
        const bundle = await res.json();
        const saved = bundle.practice_tasks || [];
        _practiceWorkingSet = saved.slice();
        _practiceSavedExists = saved.length > 0;
        if (saved.length) {
            _practiceStatus(`Showing saved practice — ${saved.length} activit${saved.length === 1 ? 'y' : 'ies'}. Regenerate to replace, or save edits.`, 'ok');
        } else {
            _practiceStatus('No practice saved yet. Click "Generate Practice" to create age-appropriate activities from this lesson.');
        }
        _renderPracticeAdminCards();
    } catch (e) {
        _practiceStatus(`Network error: ${e.message}`, 'error');
    }
}

async function _generatePractice() {
    const genBtn = $('practice-generate-btn');
    if (genBtn) genBtn.disabled = true;
    _practiceStatus('Generating age-appropriate practice from this lesson… this can take 10–20 seconds.');
    try {
        const res = await _adminFetch(
            `/lectures/${_practicalsCurrentClass}/${_practicalsCurrentChapter}/practice/generate`,
            { method: 'POST' }
        );
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { const j = await res.json(); detail = j.detail || detail; } catch (_) {}
            _practiceStatus(`Generation failed: ${detail}`, 'error');
            return;
        }
        const data = await res.json();
        _practiceWorkingSet = (data.tasks || []).slice();
        const codingNote = data.coding_allowed
            ? 'coding allowed for this grade (only if the lesson teaches it)'
            : 'no coding — too young for this grade band';
        _practiceStatus(`Generated ${_practiceWorkingSet.length} activities for ${data.grade_band} (${codingNote}). Review below, drop any you don't want, then Save.`, 'ok');
        _renderPracticeAdminCards();
    } catch (e) {
        _practiceStatus(`Network error: ${e.message}`, 'error');
    } finally {
        if (genBtn) genBtn.disabled = false;
    }
}

async function _savePractice() {
    if (!_practiceWorkingSet.length) {
        _practiceStatus('Nothing to save — generate practice first.', 'error');
        return;
    }
    const saveBtn = $('practice-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    try {
        const res = await _adminFetch(
            `/lectures/${_practicalsCurrentClass}/${_practicalsCurrentChapter}/practice`,
            { method: 'PUT', body: JSON.stringify({ tasks: _practiceWorkingSet }) }
        );
        if (res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data.tasks) _practiceWorkingSet = data.tasks.slice();
            _practiceSavedExists = true;
            showToast('Practice saved — students will see this now.');
            _practiceStatus(`Saved ${_practiceWorkingSet.length} activities for students.`, 'ok');
            _renderPracticeAdminCards();
        } else {
            let detail = `HTTP ${res.status}`;
            try { const j = await res.json(); detail = j.detail || detail; } catch (_) {}
            _practiceStatus(`Save failed: ${detail}`, 'error');
        }
    } catch (e) {
        _practiceStatus(`Network error: ${e.message}`, 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

async function _clearSavedPractice() {
    if (!confirm('Clear the saved practice for this lesson? Students will see nothing until you generate and save again.')) return;
    const clearBtn = $('practice-clear-btn');
    if (clearBtn) clearBtn.disabled = true;
    try {
        const res = await _adminFetch(
            `/lectures/${_practicalsCurrentClass}/${_practicalsCurrentChapter}/practice`,
            { method: 'DELETE' }
        );
        if (res.ok || res.status === 204) {
            _practiceWorkingSet = [];
            _practiceSavedExists = false;
            showToast('Saved practice cleared.');
            _practiceStatus('Cleared. Click "Generate Practice" to create new activities.');
            _renderPracticeAdminCards();
        } else {
            _practiceStatus(`Clear failed (HTTP ${res.status}).`, 'error');
        }
    } catch (e) {
        _practiceStatus(`Network error: ${e.message}`, 'error');
    } finally {
        if (clearBtn) clearBtn.disabled = false;
    }
}

(function _initPracticalsAdminUI() {
    const bindWhenReady = () => {
        const closeBtn = $('practicals-close');
        const backBtn = $('practicals-back');
        const genBtn = $('practice-generate-btn');
        const saveBtn = $('practice-save-btn');
        const clearBtn = $('practice-clear-btn');
        const dlBtn = $('practice-download-btn');

        if (closeBtn) closeBtn.addEventListener('click', () => _closePracticalsAdminPanel(true));
        if (backBtn) backBtn.addEventListener('click', () => _closePracticalsAdminPanel(false));
        if (genBtn) genBtn.addEventListener('click', _generatePractice);
        if (saveBtn) saveBtn.addEventListener('click', _savePractice);
        if (clearBtn) clearBtn.addEventListener('click', _clearSavedPractice);
        if (dlBtn) dlBtn.addEventListener('click', _downloadPracticePdf);
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