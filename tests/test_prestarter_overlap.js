// Tests for the "one moment please" filler vs. the real reply (voice overlap fix).
//
// Run: node tests/test_prestarter_overlap.js
//
// Background: the filler used to play immediately on every send. Once the TTS cache
// made canned replies come back in well under a second, the filler was still talking
// when the real answer began — two voices at once. The fix arms the filler on a delay
// and cancels it the moment real speech starts.
//
// The subtle part, and the reason this file exists: `_jarvisSpeaking` (voice.js) is a
// plain BOOLEAN, not a refcount. If cancelling the filler cleared it while the real
// answer was speaking, the mic would reopen mid-sentence and Jarvis would hear himself
// — a feedback loop. So the handover must be silent.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let failures = [];

function check(name, cond, detail) {
    if (cond) {
        console.log(`  [PASS] ${name}`);
    } else {
        console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
        failures.push(name);
    }
}

// Build a sandbox with just enough of the app's globals for tts.js to evaluate.
function makeSandbox() {
    const state = {
        speechStartCalls: 0,
        speechEndCalls: 0,
        jarvisSpeaking: false,
        audioPlayed: 0,
        audioPaused: 0,
    };

    const fakeAudioEl = {
        preload: '', src: '', currentTime: 0, volume: 1,
        onended: null, onerror: null,
        play() { state.audioPlayed += 1; return null; },   // null => no promise branch
        pause() { state.audioPaused += 1; },
    };

    const sandbox = {
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        document: { createElement: () => fakeAudioEl },
        window: {},
        // Globals tts.js reaches for at runtime:
        PRE_STARTER_FILES: ['starter_1'],
        PRE_STARTER_CACHE: { starter_1: 'ZmFrZQ==' },
        _onJarvisSpeechStart() { state.speechStartCalls += 1; state.jarvisSpeaking = true; },
        _onJarvisSpeechEnd() { state.speechEndCalls += 1; state.jarvisSpeaking = false; },
        // Unused by the paths under test, but referenced elsewhere in the file:
        ttsBtn: null, orbContainer: null, orb: null, _ttsAudio: null,
        API: '', getAuthHeaders: () => ({}),
        _state: state, _audioEl: fakeAudioEl,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    const src = fs.readFileSync(path.join(ROOT, 'frontend', 'tts.js'), 'utf8');
    // `class X {}` at top level is a lexical binding, so it never lands on the sandbox
    // object. Export it explicitly so the tests can construct it.
    vm.runInContext(src + '\n;globalThis.PreStarterPlayer = PreStarterPlayer;',
        sandbox, { filename: 'tts.js' });
    return sandbox;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function testFastReplyNeverPlaysFiller() {
    console.log('\nfast reply — filler must never be heard:');
    const s = makeSandbox();
    const p = new s.PreStarterPlayer();

    p.arm(120);                     // filler would start in 120ms
    await sleep(30);                // real answer arrives after 30ms
    p.cancel({ silent: true });
    await sleep(200);               // wait past the original delay

    check('filler never played', s._state.audioPlayed === 0,
        `play() called ${s._state.audioPlayed}x`);
    check('no speech-start fired for filler', s._state.speechStartCalls === 0);
    check('no speech-end fired (nothing to release)', s._state.speechEndCalls === 0);
}

async function testSlowReplyPlaysFillerThenHandsOver() {
    console.log('\nslow reply — filler plays, then real audio takes over:');
    const s = makeSandbox();
    const p = new s.PreStarterPlayer();

    p.arm(50);
    await sleep(120);               // filler has started by now
    check('filler played', s._state.audioPlayed === 1, `played ${s._state.audioPlayed}x`);
    check('mic muted while filler speaks', s._state.jarvisSpeaking === true);

    // Real answer begins — this is the handover TTSPlayer._playLoop performs.
    p.cancel({ silent: true });
    await sleep(250);               // let the fade finish

    check('filler audio was paused', s._state.audioPaused >= 1);
    check('CRITICAL: mic stays muted through handover', s._state.jarvisSpeaking === true,
        'mic reopened mid-answer -> feedback loop');
    check('speech-end NOT fired on silent handover', s._state.speechEndCalls === 0,
        `fired ${s._state.speechEndCalls}x`);
    check('volume restored for next time', s._audioEl.volume === 1,
        `volume left at ${s._audioEl.volume}`);
}

async function testNonSilentCancelReleasesMic() {
    console.log('\nno audio at all — non-silent cancel must release the mic:');
    const s = makeSandbox();
    const p = new s.PreStarterPlayer();

    p.arm(50);
    await sleep(120);               // filler speaking
    p.cancel();                     // stream ended, nothing took over
    await sleep(250);

    check('speech-end fired exactly once', s._state.speechEndCalls === 1,
        `fired ${s._state.speechEndCalls}x`);
    check('mic released', s._state.jarvisSpeaking === false);
}

async function testCancelWhilePendingDoesNotTouchMic() {
    console.log('\ncancel while only armed — must not touch the mic flag:');
    const s = makeSandbox();
    const p = new s.PreStarterPlayer();

    // Simulate the real answer already speaking (TTSPlayer owns the flag).
    s._onJarvisSpeechStart();
    const endsBefore = s._state.speechEndCalls;

    p.arm(500);
    p.cancel();                     // the finally-block cancel, filler never spoke
    await sleep(50);

    check('no speech-end fired', s._state.speechEndCalls === endsBefore,
        'a pending-only cancel released the mic mid-answer');
    check('mic still muted for the real answer', s._state.jarvisSpeaking === true);
    check('filler never played', s._state.audioPlayed === 0);
}

async function testReArmCancelsPrevious() {
    console.log('\nre-arming replaces the previous timer:');
    const s = makeSandbox();
    const p = new s.PreStarterPlayer();

    p.arm(60);
    p.arm(60);                      // second message before the first fired
    await sleep(200);

    check('filler played only once, not twice', s._state.audioPlayed === 1,
        `played ${s._state.audioPlayed}x`);
}

(async () => {
    console.log('Pre-starter overlap tests');
    console.log('='.repeat(52));
    await testFastReplyNeverPlaysFiller();
    await testSlowReplyPlaysFillerThenHandsOver();
    await testNonSilentCancelReleasesMic();
    await testCancelWhilePendingDoesNotTouchMic();
    await testReArmCancelsPrevious();
    console.log('\n' + '='.repeat(52));
    if (failures.length) {
        console.log(`FAILED: ${failures.length} check(s): ${failures.join(', ')}`);
        process.exit(1);
    }
    console.log('All pre-starter overlap checks passed.');
})();
