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
const SPEECH_RESTART_DELAY_MS = 80;  // gap between listening sessions; kept as small as Chrome allows so the mic is deaf for the least time possible (a soft "Jarvis" spoken in this gap is otherwise lost). InvalidStateError from restarting too soon is now swallowed in startListening(), so this can stay tiny. (was 700→250→150→80)
let speechSendTimeout = null;
let pendingSendTranscript = null;
// Chrome with continuous+interimResults often shows interim text ("what is") but
// NEVER emits a final result if you pause — leaving the command captured on screen
// yet never sent. We remember the latest interim command and, if no final arrives
// within INTERIM_SETTLE_MS of silence, treat that interim as the command and send it.
// Tuned to 2200ms (up from 1800) so a natural pause MID-command ("open class
// five … chapter three") doesn't fire early and split the utterance into two messages.
const INTERIM_SETTLE_MS = 2200;
let _lastInterimCommand = '';
let _lastInterimAt = 0;          // Date.now() when _lastInterimCommand was captured
let _interimSettleTimer = null;
// A kept interim (held across an isStreaming bail) is retried from onend — but onend
// can fire much later (long stream, returning from a video). Drop anything older than
// this so a command spoken ages ago and abandoned isn't sent out of the blue.
const INTERIM_MAX_AGE_MS = 6000;
// De-dupe identical voice commands fired within this window. Chrome can emit a late
// "final" for an utterance we already flushed as interim (see _flushInterimCommand),
// which would send the same command twice (duplicate message + TTS over itself).
// Short tokens (≤3 chars: quiz answers "a"/"b", "yes", "no", "ok") are exempt so a
// genuine quick repeat isn't swallowed.
const VOICE_DEDUP_MS = 2500;
let _lastVoiceSent = '';
let _lastVoiceSentAt = 0;
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

// [Phase 4] Speech/wake-word subsystem (_onJarvisSpeechStart/End, video-watch mode,
// wake-word state machine + watchdog, _maybeStartWakeWord) moved to voice.js — loaded before this file.

let _ttsAudio = null;   // dedicated pre-unlocked element for inline TTS playback
const SETTINGS_KEY = 'jarvis_settings';
const DEFAULT_SETTINGS = { autoOpenActivity: false, autoOpenSearchResults: false, thinkingSounds: true, voiceInterrupt: true, wakeWord: true, hideChat: false };
const PRE_STARTER_FILES = ['starter_1', 'starter_2', 'starter_3', 'starter_4', 'starter_5', 'starter_6', 'starter_7', 'starter_8', 'starter_9', 'starter_10'];
let PRE_STARTER_CACHE = {};
let settings = { ...DEFAULT_SETTINGS };
// [Phase 4] const $ = id => document.getElementById(id) moved to core.js (loaded
// FIRST, before all feature modules) so feature files can use $ at load time.
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
const toggleHideChat       = $('toggle-hide-chat');
const toastContainer     = $('toast-container');
const uploadBtn          = $('upload-btn');
const uploadInput        = $('upload-input');
const attachmentChips    = $('attachment-chips');

// [Phase 4] AUTH (Feature 7) subsystem — _authToken/getAuthHeaders, _initAuth,
// _signInWithGoogle/_signOut, login overlay + user pill — moved to auth.js
// (loaded before this file). init() still calls _initAuthUI() + _initAuth().

// [Phase 4] TTS subsystem (PreStarterPlayer, TTSPlayer, _browserSpeak, speakMessageButton,
// addSpeakButton, speakText, _cancelQuizSpeech) moved to tts.js — loaded before this file.

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

// ─── Error reporting ─────────────────────────────────────────────────────────
// Uncaught JS errors and unhandled promise rejections are posted to the backend
// ring buffer (/client-errors) so the owner sees breakage in the admin Errors
// view without needing the student's console. Throttled client-side; identical
// consecutive errors are dropped so a render loop can't spam the server.
let _errReportTimes = [];
let _errLastMessage = '';

function _reportClientError(message, stack, url, line) {
    try {
        const msg = String(message || '').slice(0, 500);
        if (!msg || msg === _errLastMessage) return;
        const now = Date.now();
        _errReportTimes = _errReportTimes.filter(t => now - t < 60000);
        if (_errReportTimes.length >= 5) return;   // max 5 reports/min
        _errReportTimes.push(now);
        _errLastMessage = msg;
        fetch(`${API}/client-errors`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: msg,
                stack: String(stack || '').slice(0, 2000),
                url: String(url || location.pathname).slice(0, 200),
                line: line || 0,
            }),
        }).catch(() => {});
    } catch (_) { /* error reporting must never throw */ }
}

function _initErrorReporting() {
    window.addEventListener('error', (e) => {
        _reportClientError(e.message, e.error && e.error.stack, e.filename, e.lineno);
    });
    window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        _reportClientError(
            (r && r.message) ? `Unhandled rejection: ${r.message}` : `Unhandled rejection: ${String(r).slice(0, 200)}`,
            r && r.stack
        );
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
    _initCardDismiss();
    _initErrorReporting();
}

// [Phase 4] _initAuthUI() moved to auth.js (binds Google/logout buttons).

// ─── Dismissible cards (✕) ───────────────────────────────────────────────────
// Every generated rich card (image, blog/content, MCQ question + result, practice
// sheet, notes, practice files) gets a small ✕ in its top-right corner. Clicking it
// fades out and removes the whole containing message bubble, so the screen reclaims
// the space the card occupied. A MutationObserver tags cards as they appear (no
// per-render wiring needed), and a single delegated click handler does the removal.
// Purely visual — nothing is deleted server-side; the user can regenerate any card.
const _DISMISSIBLE_CARD_SELECTOR = [
    '.quiz-card', '.quiz-result-card', '.notes-card',
    '.practice-files-wrap', '.practical-bundle',
    '.msg-actions-images', '.msg-actions-contents', '.bg-task-card',
    '.yt-choice-wrap'
].join(', ');

function _addCardCloseBtn(card) {
    if (!card || !card.classList) return;
    // The lecture action buttons (.yt-choice-wrap) live inside a bubble that also
    // holds the "Sir, I've analysed the video" line — anchor the ✕ to that whole
    // bubble content so it sits at the card's top-right corner, above the buttons.
    let host = card;
    if (card.classList.contains('yt-choice-wrap')) {
        host = card.closest('.msg-content') || card;
    }
    if (host.dataset.cardCloseAdded) return;
    host.dataset.cardCloseAdded = '1';
    host.classList.add('has-card-close');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jarvis-card-close';
    btn.title = 'Dismiss';
    btn.setAttribute('aria-label', 'Dismiss this card');
    btn.innerHTML = '&times;';
    host.appendChild(btn);
}

function _initCardDismiss() {
    if (!chatMessages) return;
    // Delegated click — fade out and remove the whole message bubble (reclaims space).
    chatMessages.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.jarvis-card-close');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const target = btn.closest('.message') || btn.closest(_DISMISSIBLE_CARD_SELECTOR);
        if (!target) return;
        if (typeof gsap !== 'undefined') {
            gsap.to(target, { opacity: 0, y: -6, duration: 0.2, ease: 'power1.in',
                onComplete: () => target.remove() });
        } else {
            target.remove();
        }
    });
    // Add a ✕ to cards as they're inserted (and any already present).
    const tagAll = (root) => {
        if (!root || root.nodeType !== 1) return;
        if (root.matches && root.matches(_DISMISSIBLE_CARD_SELECTOR)) _addCardCloseBtn(root);
        if (root.querySelectorAll) root.querySelectorAll(_DISMISSIBLE_CARD_SELECTOR).forEach(_addCardCloseBtn);
    };
    try {
        new MutationObserver((muts) => {
            for (const m of muts) {
                for (const node of m.addedNodes) tagAll(node);
            }
        }).observe(chatMessages, { childList: true, subtree: true });
    } catch (_) {}
    tagAll(chatMessages);
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
            // One-time migration: these panels used to default ON, so existing
            // users have `true` saved. Force them OFF once, then never again —
            // after this the user's own toggle choice (on or off) is respected.
            if (!parsed.autoOpenDefaultsMigrated) {
                settings.autoOpenActivity = false;
                settings.autoOpenSearchResults = false;
                settings.autoOpenDefaultsMigrated = true;
                saveSettings();
            }
        } else {
            // Brand-new user: defaults are already OFF; mark migrated so the
            // reset above never runs against their future choices.
            settings.autoOpenDefaultsMigrated = true;
        }
        if (toggleAutoActivity) toggleAutoActivity.checked = settings.autoOpenActivity;
        if (toggleAutoSearch) toggleAutoSearch.checked = settings.autoOpenSearchResults;
        if (toggleThinkingSounds) toggleThinkingSounds.checked = settings.thinkingSounds;
        if (toggleVoiceInterrupt) toggleVoiceInterrupt.checked = settings.voiceInterrupt;
        if (toggleWakeWord) toggleWakeWord.checked = settings.wakeWord;
        if (toggleHideChat) toggleHideChat.checked = settings.hideChat;
        applyHideChat();
    } catch (_) {}
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {}
}

// Hide-chat (voice-only) mode: toggles a body class that hides conversational
// chat bubbles via CSS, while rich outputs (quizzes, summaries, practice sheets,
// notes, images, generated content) stay visible. Purely visual — TTS, brain
// routing, and all rendering are untouched, so it's safe to flip on/off anytime.
function applyHideChat() {
    try {
        document.body.classList.toggle('hide-chat', !!settings.hideChat);
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

// [Phase 4] initSpeech / startListening / stopListening / maybeRestartListening moved to voice.js.

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

// [Phase 4] Camera fns (isCameraQuery, startCamera, stopCamera, initCameraPanel)
// moved to media.js (loaded before this file). Cam DOM consts + camStream stay here.

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

// [Phase 4] Frame capture (captureFrameAsBase64, captureFrameAsBase64Safe) moved
// to media.js (loaded before this file).

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
    if (toggleHideChat) {
        toggleHideChat.addEventListener('change', () => {
            settings.hideChat = toggleHideChat.checked;
            saveSettings();
            applyHideChat();
            showToast(settings.hideChat
                ? 'Chat hidden. You\'ll still hear Jarvis and see quizzes, summaries and practice.'
                : 'Chat visible again.', 3500);
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
                        // Open in our own full-bleed fullscreen player (no YouTube
                        // sidebar/recommendations) when we have the video id; the player
                        // auto-falls back to youtube.com if the video can't be embedded.
                        const _ytPlayerUrl = data.youtube_detected.video_id
                            ? `${window.location.origin}/app/player.html?v=${encodeURIComponent(data.youtube_detected.video_id)}`
                            : data.youtube_detected.url;
                        window.open(_ytPlayerUrl, '_blank');
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

// [Phase 4] YouTube Quiz & Summary + Notes + Practice (renderYouTubeChoiceButtons,
// startQuiz/renderQuestion/submitAnswer/renderQuizResult, startSummary, startNotes/
// renderNotesCard, renderPracticeFiles, startPracticals/renderPracticalBundle/
// buildPracticePdf, _renderAITaskCard, renderMarkdown) moved to learning.js
// (loaded before this file). Shared state currentQuiz/pendingYouTube stays here.

// [Phase 4] Admin surface (Feature 8 lecture catalog + admin auth + lectures
// drawer + recent-errors viewer + Feature 9 practicals admin panel, incl. the
// two DOMContentLoaded-deferred init IIFEs) moved to admin.js (loaded before
// this file). ADMIN_TOKEN_KEY/_YT_RE/practicals state moved with it.

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