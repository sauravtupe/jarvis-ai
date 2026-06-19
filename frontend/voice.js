// voice.js — speech recognition + wake-word subsystem, extracted from script.js (Phase 4 Step B).
// Classic <script>, loaded BEFORE script.js so it shares the same global scope.
// Shared state it uses (isListening, recognition, autoListenMode, _jarvisSpeaking, settings, the
// SPEECH_* timing consts, ...) stays declared in script.js and is referenced here only at runtime.
// Defines: _onJarvisSpeechStart/End, video-watch mode, the wake-word state machine + watchdog,
// initSpeech, startListening, stopListening, maybeRestartListening. No behavior change.

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
    _clearInterimSettle();   // don't let a half-heard interim fire while a video is open
    if (isListening) {
        try { recognition && recognition.stop(); } catch (_) {}
    }
    if (typeof micBtn !== 'undefined' && micBtn) {
        micBtn.classList.remove('auto-listen', 'listening');
        micBtn.title = 'Voice paused while a video is open — say "done" or click to resume';
    }
    if (typeof showToast === 'function') {
        showToast('🎬 Voice paused while you watch. Switch back to this tab and voice resumes automatically — or click the mic to talk now.', 7000);
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

// Auto-resume voice when the user returns to the JARVIS tab/window after watching
// a video. The video opens in a NEW TAB, so this tab is backgrounded and the mic is
// paused (and Chrome suspends recognition for hidden tabs anyway). Previously the
// only way back was a manual mic click — the user couldn't say "done" because nothing
// was listening. Coming back to this tab IS the "I want to talk again" signal, so we
// exit video-watch mode and restart listening automatically. No-op unless a video is
// currently being watched, so ordinary tab switches are unaffected.
function _resumeVoiceOnReturn() {
    if (!_videoWatchMode) return;
    // Recognition was stopped on video-open and this tab was backgrounded, which can
    // leave Chrome's SpeechRecognition engine wedged (start() then silently does
    // nothing). Rebuild a fresh recognizer before resuming so detection is immediate
    // and reliable again — there is no live session to lose, it was already stopped.
    try {
        if (recognition) {
            // Detach handlers BEFORE abort/null. abort() fires `end` asynchronously;
            // if those handlers stayed attached, the dying recognizer's late onend
            // would run against the GLOBAL `recognition` (now the fresh one we build
            // below) and its `if (isListening) stopListening()` / maybeRestartListening()
            // could stop or double-restart the new session — making the mic flap right
            // after you return to the tab, the opposite of this feature's goal.
            recognition.onend = recognition.onresult = recognition.onerror = recognition.onstart = null;
            if (recognition.abort) recognition.abort();
            else recognition.stop();
        }
    } catch (_) {}
    isListening = false;
    speechErrorRetryCount = 0;
    recognition = null;
    initSpeech();
    _exitVideoWatchMode();
    // Coming back to this tab IS the "done watching" signal — auto-offer the post-video
    // choice card (MCQ/summary/practice/notes) so the student never has to say "done"
    // for the quiz to appear. Gated once per video inside the helper. Reliable across
    // English/Hindi/Marathi because it doesn't depend on recognizing a spoken phrase.
    if (typeof _offerPostVideoChoices === 'function') _offerPostVideoChoices();
}
if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') _resumeVoiceOnReturn();
    });
    window.addEventListener('focus', _resumeVoiceOnReturn);
}

// ─── Wake-word state machine ("Jarvis" hands-free activation) ───────────────
// PASSIVE  : mic running, only acts on the "Jarvis" wake word
// ACTIVE   : wake word heard, command capture window open (stays open up to 30 min
//            so a long pause before speaking never drops the command; resets on
//            any speech, then returns to PASSIVE once a command is handled)
// BLOCKED  : Jarvis is speaking / video is playing / response streaming
// OFF      : wake word disabled or mic permission not yet granted
const MIC_STATE_OFF = 'off';
const MIC_STATE_PASSIVE = 'passive';
const MIC_STATE_ACTIVE = 'active';
const MIC_STATE_BLOCKED = 'blocked';
let _micState = MIC_STATE_OFF;
let _wakeActiveTimer = null;
let _wakeWatchdog = null;   // keeps Web Speech alive so the wake word isn't missed (see _startWakeWatchdog)
// Liveness proof for the recognizer. A HEALTHY SpeechRecognition session emits
// events constantly even in total silence (no-speech errors every ~8s, session
// end/restart cycles, audiostart, ...). Chrome's engine can also die WITHOUT
// firing onend/onerror — typically after the machine/tab idles a few minutes —
// leaving isListening stuck true so the watchdog thinks all is well while
// nothing is listening ("say Jarvis after 5 min idle → no response" bug).
// Every recognition event stamps this; if we believe we're listening but get
// zero events for WAKE_ZOMBIE_MS, the engine is a zombie and gets rebuilt.
let _lastSpeechEvidence = 0;
const WAKE_ZOMBIE_MS = 30000;
// Command-capture window after the wake word. NOT an "off switch" — passive
// wake-word listening is always-on (kept alive by the watchdog). This only bounds
// how long Jarvis waits for your COMMAND after hearing "Jarvis". It's a very
// generous 30-minute safety cap (was 10s, which dropped commands when the user
// paused before speaking); it resets on any speech and only self-heals back to
// wake-word mode if nobody speaks at all for the full 30 minutes, so a
// stray/accidental wake can't leave the mic hot literally forever.
const WAKE_ACTIVE_WINDOW_MS = 1800000;  // 30 min
// Substring matcher for the wake word. The SpeechRecognition engine mis-hears
// "Jarvis" constantly, so we accept a broad set of look-alikes/sound-alikes —
// recall matters more than precision here (a stray match just opens the command
// window). Add more variants here if a real misread keeps slipping through.
// Two alternations: (1) Latin variants, \b-anchored as usual; (2) Devanagari
// renderings the hi-IN / mr-IN recognizer returns once the conversation language
// is switched — these MUST stay un-anchored because JS \b is ASCII-only (it asserts
// a \w/\W transition and never matches around all-non-word Devanagari, so a
// \b-wrapped Devanagari variant would never fire). _matchWakeWord uses m[0]/m.index,
// which work for either branch.
const _WAKE_WORD_RE = /\b(jarvis|jarviss|jarvis's|jarvi|jarviz|jarvice|jarvees|javis|javies|javiss|jervis|jervice|jarwis|jarwiss|jaravis|jarvas|jaris|jarius|travis|charvis|harvis|garvis|marvis|narvis|sarvis|darvis|larvis|yarvis|service)\b|(जार्विस|जार्वीस|जारविस|जारवीस|जॉर्विस|जर्विस|जर्व्हिस|जाविस|जरविस|जार्व्हिस|जरबेस|जारबेस|जरबीस|जरवेस|जरबस|जर्बेस)/i;

// ─── Manual conversation-language → Web Speech recognizer tag ────────────────
// The user can switch the conversation language by voice/text ("speak in Marathi",
// "हिंदी में बात करो", "मराठीत बोल"). The backend (app/services/chat_service.py
// match_language_command) sets the LLM reply + Azure TTS voice; here we mirror the
// SAME detection so the mic listens in the matching language. recognition.lang only
// applies on the next start(); sendMessage already stops the mic for the send, and
// the post-reply/TTS re-arm starts it in the new language — so we just update state.
// Keep this matcher in sync with chat_service.match_language_command.
const _LANG_TO_RECO = { en: 'en-IN', hi: 'hi-IN', mr: 'mr-IN' };
const _LANG_NAME_RE = {
    en: /english|इंग्लिश|इंग्रजी|अंग्रेज़ी|अंग्रेजी/i,
    hi: /hindi|हिंदी|हिन्दी/i,
    mr: /marathi|मराठी/i,
};
const _LANG_SWITCH_INTENT_RE = /speak|talk|switch|reply|respond|answer|converse|change|baat\s*kar|बात\s*कर|बोल|मध्ये|में\s*बात/i;
let conversationRecoLang = 'en-IN';   // default = today's exact behavior

function _matchLanguageCommand(text) {
    if (!text) return null;
    const t = text.trim();
    if (t.length > 120) return null;
    if (!_LANG_SWITCH_INTENT_RE.test(t)) return null;
    for (const lang of ['mr', 'hi', 'en']) {       // mr before hi (both Devanagari)
        if (_LANG_NAME_RE[lang].test(t)) return lang;
    }
    return null;
}

function maybeSwitchRecognitionLang(text) {
    const lang = _matchLanguageCommand(text);
    if (!lang) return;
    const tag = _LANG_TO_RECO[lang];
    if (!tag || tag === conversationRecoLang) return;
    conversationRecoLang = tag;
    if (recognition) recognition.lang = tag;
}

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

function _clearInterimSettle() {
    if (_interimSettleTimer) { clearTimeout(_interimSettleTimer); _interimSettleTimer = null; }
    _lastInterimCommand = '';
}

// Remember the latest interim command and arm the settle timer. If a real final
// result arrives first it cancels this (via _clearInterimSettle); if not, the
// timer fires and sends what we heard so the command is never silently dropped.
function _noteInterimCommand(text) {
    const t = (text || '').trim();
    if (t.length < 2) return;
    _lastInterimCommand = t;
    _lastInterimAt = Date.now();
    if (_interimSettleTimer) clearTimeout(_interimSettleTimer);
    _interimSettleTimer = setTimeout(_flushInterimCommand, INTERIM_SETTLE_MS);
}

// Route every voice-initiated send through here so the same command fired twice in
// quick succession is de-duped (Chrome emitting a late "final" for an utterance we
// already flushed as interim). Short tokens are exempt — see VOICE_DEDUP_MS.
function _sendVoiceCommand(cmd) {
    const c = (cmd || '').trim();
    if (!c) return;
    const now = Date.now();
    if (c.length > 3 && c === _lastVoiceSent && (now - _lastVoiceSentAt) < VOICE_DEDUP_MS) return;
    _lastVoiceSent = c;
    _lastVoiceSentAt = now;
    sendMessage(c);
}

// Send the last interim command (Chrome never produced a final). Strips a leading
// wake word, ignores stop-commands, and won't fire while a request is already
// streaming (the interim is retried from onend in that case).
function _flushInterimCommand() {
    if (_interimSettleTimer) { clearTimeout(_interimSettleTimer); _interimSettleTimer = null; }
    let cmd = (_lastInterimCommand || '').trim();
    if (cmd.length < 2) return;
    // Drop a stale capture. This runs from onend too, which can fire long after the
    // words were spoken; without the age check an abandoned command would suddenly
    // send. A fresh interim kept across an isStreaming bail is still well within range.
    if (_lastInterimAt && (Date.now() - _lastInterimAt) > INTERIM_MAX_AGE_MS) {
        _lastInterimCommand = '';
        return;
    }
    if (isStreaming) return;            // keep _lastInterimCommand; onend will retry
    // Strip a leading wake word. If nothing meaningful is left (the utterance was just
    // "Jarvis"), there's no command — bail instead of sending a bare "jarvis". The
    // length check must run AFTER stripping, since "jarvis" alone is 6 chars.
    const w = _matchWakeWord(cmd);
    if (w) {
        if (!w.remaining || w.remaining.length < 2) { _lastInterimCommand = ''; return; }
        cmd = w.remaining;
    }
    _lastInterimCommand = '';
    if (typeof VOICE_STOP_COMMANDS !== 'undefined' && VOICE_STOP_COMMANDS.test(cmd)) return;
    pendingSendTranscript = null;
    clearTimeout(speechSendTimeout);
    speechSendTimeout = null;
    _clearWakeActiveTimer();
    _sendVoiceCommand(cmd);
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
    _startWakeWatchdog();
    if (!isListening) startListening();
}

function _enterActiveListening() {
    if (_jarvisSpeaking || _videoWatchMode) {
        _setMicState(MIC_STATE_BLOCKED);
        return;
    }
    autoListenMode = true;
    _startWakeWatchdog();
    if (!isListening) startListening();
    _startActiveWindow();
}

function _disableMic() {
    _clearWakeActiveTimer();
    _clearInterimSettle();
    _stopWakeWatchdog();
    _setMicState(MIC_STATE_OFF);
    autoListenMode = false;
    if (isListening) stopListening();
}

// ─── Wake-word watchdog ─────────────────────────────────────────────────────
// Chrome's SpeechRecognition stops on its own sometimes — after a no-speech
// timeout, after ~60s, when the tab backgrounds, or when a restart is dropped in
// the tiny gap between sessions. When that happens nothing is actually listening,
// so the user has to say "Jarvis" several times. This watchdog notices a dead
// recognizer (we think we're listening but aren't) and re-arms it within ~0.7s, so
// passive wake-word listening stays effectively continuous.
function _startWakeWatchdog() {
    if (_wakeWatchdog) return;
    _wakeWatchdog = setInterval(() => {
        if (!recognition || !autoListenMode) return;
        if (isStreaming || _jarvisSpeaking || _videoWatchMode) return;
        if (isListening) {
            // ZOMBIE CHECK — isListening can lie. Chrome's engine sometimes dies
            // after a few minutes of idle WITHOUT firing onend/onerror, so the
            // flag stays true and the revive below never runs ("Jarvis" ignored
            // until the user toggles wake word off/on). A healthy quiet session
            // emits events every few seconds (no-speech, end/restart cycles);
            // total silence for WAKE_ZOMBIE_MS means the engine is dead — rebuild
            // it from scratch, the same recipe as _resumeVoiceOnReturn.
            if (Date.now() - _lastSpeechEvidence > WAKE_ZOMBIE_MS) {
                console.warn('[WAKE] recognizer silent for %ds — rebuilding (zombie session)',
                             Math.round((Date.now() - _lastSpeechEvidence) / 1000));
                try {
                    // Detach handlers BEFORE abort so the dying recognizer's late
                    // onend can't stop/double-restart the fresh one we build next.
                    recognition.onend = recognition.onresult = recognition.onerror = recognition.onstart = null;
                    if (recognition.abort) recognition.abort();
                    else recognition.stop();
                } catch (_) {}
                isListening = false;
                speechErrorRetryCount = 0;
                recognition = null;
                initSpeech();
                if (settings && settings.wakeWord && _micState !== MIC_STATE_ACTIVE) _enterPassiveListening();
                else startListening();
            }
            return;                                                    // running (and proven alive)
        }
        if (speechErrorRetryCount >= SPEECH_ERROR_MAX_RETRIES) return; // gave up (e.g. mic permission denied)
        // Should be listening but isn't — revive it.
        if (settings && settings.wakeWord && _micState !== MIC_STATE_ACTIVE) _enterPassiveListening();
        else startListening();
    }, 700);
}

function _stopWakeWatchdog() {
    if (_wakeWatchdog) { clearInterval(_wakeWatchdog); _wakeWatchdog = null; }
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

function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { micBtn.title = 'Speech not supported in this browser'; return; }
    recognition = new SR();
    const safariMode = isSafariOrIOS();
    recognition.continuous = true;
    recognition.interimResults = !safariMode;
    recognition.maxAlternatives = 5;  // more guesses for the wake-word scanner to find "Jarvis" in
    recognition.lang = conversationRecoLang;   // en-IN by default; tracks manual language switch
    // Liveness stamps — any event from the engine proves it's alive (see
    // _lastSpeechEvidence). audiostart/soundstart fire even without speech.
    recognition.onaudiostart = () => { _lastSpeechEvidence = Date.now(); };
    recognition.onsoundstart = () => { _lastSpeechEvidence = Date.now(); };
    recognition.onspeechstart = () => { _lastSpeechEvidence = Date.now(); };

    recognition.onresult = e => {
        _lastSpeechEvidence = Date.now();
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
        // Capture what the recognizer ACTUALLY returns (esp. Devanagari mis-hears in
        // hi-IN/mr-IN mode like जरबेस / चाएर) so multilingual matchers can be hardened
        // against real transcripts instead of guesses. Final results only, one line.
        if (isFinal && alts.length) console.log('[VOICE-RAW]', recognition.lang, JSON.stringify(alts));

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
                    _clearInterimSettle();
                    pendingSendTranscript = null;
                    clearTimeout(speechSendTimeout);
                    speechSendTimeout = null;
                    _sendVoiceCommand(wake.remaining);
                } else {
                    // Interim — open the active window so the user has time to finish,
                    // and remember it so it still sends if Chrome never finalizes.
                    if (_micState !== MIC_STATE_ACTIVE) _startActiveWindow();
                    _noteInterimCommand(wake.remaining);
                }
            } else {
                // Bare wake word — open the command window (up to 30 min, resets on speech)
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
            // A real final arrived — cancel the interim-settle fallback so it can't double-send.
            _clearInterimSettle();
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
                    _sendVoiceCommand(pendingSendTranscript);
                    pendingSendTranscript = null;
                }
                speechSendTimeout = null;
                // In wake-word mode, the BLOCKED→PASSIVE transition happens via
                // _onJarvisSpeechEnd or maybeRestartListening. Without wake word,
                // stop the mic the way the legacy click-toggle expects.
                if (!settings.wakeWord) stopListening();
            }, SPEECH_SEND_DELAY_MS);
        } else if (!isFinal) {
            // Interim activity in ACTIVE — extend the command window and remember the
            // text so it still sends if Chrome never produces a final result.
            _resetActiveWindow();
            _noteInterimCommand(transcript);
            pendingSendTranscript = null;
            clearTimeout(speechSendTimeout);
            speechSendTimeout = null;
        }
    };

    recognition.onstart = () => { _lastSpeechEvidence = Date.now(); speechErrorRetryCount = 0; };
    recognition.onerror = e => {
        _lastSpeechEvidence = Date.now();
        const msg = (e && e.error) ? String(e.error) : '';
        // "no-speech" is completely normal — user was quiet. Restart silently without counting retries.
        if (msg === 'no-speech') {
            // Normal — you were just quiet. Restart immediately via maybeRestartListening()
            // (it has its own minimal gap) instead of STACKING another delay on top. The old
            // double setTimeout left the mic deaf ~300ms every few seconds — exactly when a
            // softly-spoken "Jarvis" got dropped and you had to say it again.
            stopListening();
            if (autoListenMode && !isStreaming) maybeRestartListening();
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
        _lastSpeechEvidence = Date.now();
        if (pendingSendTranscript) {
            clearTimeout(speechSendTimeout);
            speechSendTimeout = null;
            _sendVoiceCommand(pendingSendTranscript);
            pendingSendTranscript = null;
        } else if (_lastInterimCommand) {
            // Session ended with captured interim text but Chrome never finalized it —
            // send it now instead of silently dropping the command.
            clearTimeout(speechSendTimeout);
            speechSendTimeout = null;
            _flushInterimCommand();
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
    // Refuse to start the mic while Jarvis is speaking (or has audio queued).
    // Starting now would capture his own voice through the speakers and create a
    // feedback loop. The mic click handler is supposed to stop TTS before calling
    // this; the gate here catches code paths that don't (auto-restart, races).
    const ttsActive = _jarvisSpeaking ||
        (ttsPlayer && (ttsPlayer.playing || ttsPlayer.queue.length > 0));
    if (ttsActive) return;
    if (isSafariOrIOS() && !safariVoiceHintShown) {
        showToast('Voice works best in Chrome. Safari has limited support.');
        safariVoiceHintShown = true;
    }
    isListening = true;
    _lastSpeechEvidence = Date.now();   // fresh session gets a full liveness window
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
        // InvalidStateError just means the previous session hasn't fully ended yet — the
        // recognizer is effectively already (re)starting, so it IS listening. Keep
        // isListening = true and let the pending onend/onstart settle. The old code rebuilt
        // `recognition` on every such race, throwing away a live session right when you might
        // have been saying "Jarvis". Only a genuinely broken recognizer (any OTHER error)
        // gets nuked and recreated.
        if (err && err.name === 'InvalidStateError') return;
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
    // Never restart while a YouTube lecture is open — _exitVideoWatchMode() calls
    // this function again once the user signals "done".
    if (_videoWatchMode) return;
    const ttsActive = ttsPlayer && (ttsPlayer.playing || ttsPlayer.queue.length > 0);
    if (ttsActive) return;
    if (!autoListenMode) return;
    setTimeout(() => {
        if (autoListenMode && !isStreaming && !isListening && recognition && !_jarvisSpeaking && !_videoWatchMode) {
            // Wake-word mode: never auto-restart into ACTIVE. The command
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
