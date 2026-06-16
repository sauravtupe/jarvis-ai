// tts.js — audio playback + TTS subsystem, extracted from script.js (Phase 4 Step A).
// Classic <script>, loaded BEFORE script.js so it shares the same global scope.
// Defines: PreStarterPlayer, TTSPlayer, _browserSpeak, speakMessageButton,
// addSpeakButton, speakText, _cancelQuizSpeech. No behavior change.

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

let _quizAudio = null;
let _speakSeq = 0;          // newest speakText() wins; supersedes any pending/playing one
let _speakResolve = null;   // resolves the in-flight speak's await so its cleanup runs

// Cancel any quiz/summary speech that's in flight — a question read still LOADING
// (so it bails before it ever plays) or one already PLAYING (stop it now). This is
// what makes an early answer-click work: bumping the token makes a pending read bail
// at its next checkpoint, and resolving the stored promise lets that call's finally
// run so _onJarvisSpeechEnd stays balanced (mic state never gets stuck).
function _cancelQuizSpeech() {
    _speakSeq++;
    if (_quizAudio) { try { _quizAudio.pause(); } catch (_) {} _quizAudio = null; }
    if (_speakResolve) { const r = _speakResolve; _speakResolve = null; r(); }
}

async function speakText(text) {
    if (!ttsPlayer || !ttsPlayer.enabled || !text) return;
    // Newest speak wins. If the user answers before/while a question is being read,
    // this cancels that read so the late audio can't trample the correct/wrong feedback.
    _cancelQuizSpeech();
    const mySeq = _speakSeq;
    const audio = _speakAudio || document.createElement('audio');
    let spoke = false;
    let url = null;
    try {
        const res = await fetch(`${API}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });
        // Answered (or another speak started) while the audio was loading → don't play.
        if (mySeq !== _speakSeq || !res.ok) return;
        const blob = await res.blob();
        if (mySeq !== _speakSeq) return;
        url = URL.createObjectURL(blob);
        audio.src = url;
        _quizAudio = audio;
        _onJarvisSpeechStart();
        spoke = true;
        await new Promise((resolve) => {
            _speakResolve = resolve;
            const done = () => {
                if (url) { URL.revokeObjectURL(url); url = null; }
                if (_quizAudio === audio) _quizAudio = null;
                if (_speakResolve === resolve) _speakResolve = null;
                resolve();
            };
            audio.onended = done;
            audio.onerror = done;
            audio.play().catch(e => { console.warn('speakText play error:', e); done(); });
        });
    } catch (e) {
        console.warn('speakText error:', e);
    } finally {
        if (spoke) _onJarvisSpeechEnd();
    }
}
