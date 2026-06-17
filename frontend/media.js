// ============================================================================
// media.js — camera/vision + Classroom Attention AI. Phase 4 Step F extraction.
// Loaded BEFORE script.js (ordered classic <script>), AFTER core.js (which
// defines $, used at load time by the classroom DOM consts below).
//
// Camera: isCameraQuery/startCamera/stopCamera/initCameraPanel + frame capture.
// Camera DOM consts (camBtn, camVideo, camPanel...) and camStream stay in
// script.js's foundation and are referenced here only at runtime (same pattern
// as voice.js). All camera callers (handleActions, bindEvents, sendMessage) are
// in script.js and call these at runtime.
//
// Classroom (Feature 4): self-contained — brings its own DOM consts, state,
// startClassroomMode/stopClassroomMode/runClassroomScan, the visibilitychange
// listener, and renderClassroomData.
// ============================================================================

// ─── Camera / Vision ────────────────────────────────────────

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
