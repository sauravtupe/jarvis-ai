// ============================================================================
// admin.js — owner-only admin surface (Feature 8 + 9): admin token auth,
// lectures drawer + CRUD form, recent-errors viewer, and the practicals admin
// panel (generate/save/clear/download practice). Phase 4 Step E extraction.
// Loaded BEFORE script.js (ordered classic <script>). The two init IIFEs only
// register a DOMContentLoaded listener at load time, so $/handlers resolve
// post-init. Calls learning.js's _renderAITaskCard + buildPracticePdf at
// runtime (cross-file, order-independent). Shared helpers ($, showToast,
// escapeHtml, API) live in script.js, referenced only at call time.
// ============================================================================

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

// ─── Admin: recent-errors viewer ─────────────────────────────────────────────
// Renders the backend's error ring buffer (GET /admin/errors) inside the
// lectures drawer. Shows backend logger.error()s and reported frontend errors.
async function _toggleErrorsView() {
    const list = $('errors-list');
    const btn = $('lectures-errors-btn');
    if (!list) return;
    if (list.style.display !== 'none') {
        list.style.display = 'none';
        if (btn) btn.classList.remove('active');
        return;
    }
    list.style.display = '';
    if (btn) btn.classList.add('active');
    list.innerHTML = '<p class="errors-empty">Loading…</p>';
    try {
        const res = await _adminFetch('/admin/errors');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const errors = data.errors || [];
        if (!errors.length) {
            list.innerHTML = '<p class="errors-empty">No errors recorded since the last restart. 🎉</p>';
            return;
        }
        list.innerHTML = '';
        for (const err of errors) {
            const row = document.createElement('div');
            row.className = `error-row error-${(err.source || 'backend')}`;
            const head = document.createElement('div');
            head.className = 'error-row-head';
            const ts = (err.ts || '').replace('T', ' ').replace('Z', ' UTC');
            head.innerHTML = `<span class="error-source">${escapeHtml(err.source || '?')}</span>` +
                             `<span class="error-ts">${escapeHtml(ts)}</span>`;
            const msg = document.createElement('div');
            msg.className = 'error-msg';
            msg.textContent = err.message || '';
            row.appendChild(head);
            row.appendChild(msg);
            if (err.detail) {
                const detail = document.createElement('pre');
                detail.className = 'error-detail';
                detail.style.display = 'none';
                detail.textContent = err.detail;
                row.appendChild(detail);
                row.addEventListener('click', () => {
                    detail.style.display = detail.style.display === 'none' ? '' : 'none';
                });
            }
            list.appendChild(row);
        }
    } catch (e) {
        list.innerHTML = `<p class="errors-empty">Couldn't load errors: ${escapeHtml(e.message)}</p>`;
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
        const errorsBtn = $('lectures-errors-btn');
        if (errorsBtn) errorsBtn.addEventListener('click', _toggleErrorsView);
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


// ─── AI Teacher Phase 1: Classrooms admin (School -> Class -> Division) ───────
// A self-contained drawer (above the lectures drawer) for building the classroom
// identity tree. Each division's preferred language flows into the teacher persona
// at chat time, so a Marathi division is greeted/taught in Marathi automatically.

const _CR_GRADES = ['UKG'].concat(Array.from({ length: 12 }, (_, i) => String(i + 1)));
const _CR_LANGS = [['en', 'English'], ['hi', 'Hindi'], ['mr', 'Marathi']];
function _crGradeLabel(g) { return g === 'UKG' ? 'UKG' : 'Class ' + g; }
function _crLangLabel(l) { return ({ en: 'English', hi: 'Hindi', mr: 'Marathi' })[l] || 'English'; }
function _crGradeOptions() { return _CR_GRADES.map(g => `<option value="${g}">${_crGradeLabel(g)}</option>`).join(''); }
function _crLangOptions() { return _CR_LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); }

function _crShowError(msg) {
    const el = $('cr-error');
    if (!el) return;
    if (msg) { el.textContent = msg; el.style.display = 'block'; }
    else { el.style.display = 'none'; }
}

function _openClassroomsPanel() {
    const panel = $('classrooms-panel');
    if (panel) { panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false'); }
    if (typeof updatePanelOverlay === 'function') updatePanelOverlay();
    _crShowError('');
    _refreshClassrooms();
}
function _closeClassroomsPanel() {
    const panel = $('classrooms-panel');
    if (panel) { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); }
    if (typeof updatePanelOverlay === 'function') updatePanelOverlay();
}

async function _refreshClassrooms() {
    const tree = $('classrooms-tree');
    if (!tree) return;
    tree.innerHTML = '<p class="lectures-loading">Loading…</p>';
    try {
        const res = await _adminFetch('/schools');
        if (!res.ok) { tree.innerHTML = `<p class="lectures-error">Failed to load (HTTP ${res.status}).</p>`; return; }
        const data = await res.json();
        const schools = Array.isArray(data.schools) ? data.schools : [];
        tree.innerHTML = schools.length
            ? schools.map(_crRenderSchool).join('')
            : '<p class="lectures-empty">No schools yet. Add one above to get started.</p>';
    } catch (e) {
        tree.innerHTML = `<p class="lectures-error">Network error: ${_esc(e.message)}</p>`;
    }
}

function _crRenderSchool(s) {
    const meta = [s.board, s.city].filter(Boolean).map(_esc).join(' · ');
    const classes = (s.classes || []).map(c => _crRenderClass(s.id, c)).join('');
    return `
      <div class="cr-school">
        <div class="cr-school-head">
          <span class="cr-school-name">${_esc(s.name)}${meta ? ` <small>${meta}</small>` : ''}</span>
          <button class="cr-del" data-cr="del-school" data-school="${s.id}" title="Delete school">✕</button>
        </div>
        <div class="cr-classes">${classes || '<p class="cr-hint">No classes yet.</p>'}</div>
        <div class="cr-add-row cr-add-class">
          <select class="cr-class-grade">${_crGradeOptions()}</select>
          <button class="btn-secondary cr-mini" data-cr="add-class" data-school="${s.id}">+ Add Class</button>
        </div>
      </div>`;
}

function _crRenderClass(schoolId, c) {
    const divs = (c.divisions || []).map(d => `
        <span class="cr-div">${_esc(d.name)} <em>(${_crLangLabel(d.preferred_language)})</em>
          <button class="cr-del" data-cr="del-div" data-school="${schoolId}" data-class="${c.id}" data-div="${d.id}" title="Delete division">✕</button>
        </span>`).join('');
    return `
      <div class="cr-class">
        <div class="cr-class-head">
          <strong>${_crGradeLabel(c.grade)}</strong>
          <button class="cr-del" data-cr="del-class" data-school="${schoolId}" data-class="${c.id}" title="Delete class">✕</button>
        </div>
        <div class="cr-divisions">${divs || '<span class="cr-hint">No divisions yet.</span>'}</div>
        <div class="cr-add-row cr-add-div">
          <input type="text" class="cr-div-name" maxlength="20" placeholder="Division (e.g. A)">
          <select class="cr-div-lang">${_crLangOptions()}</select>
          <button class="btn-secondary cr-mini" data-cr="add-div" data-school="${schoolId}" data-class="${c.id}">+ Add</button>
        </div>
      </div>`;
}

async function _crHandle(res, okMsg) {
    if (res.ok || res.status === 204) { if (okMsg && typeof showToast === 'function') showToast(okMsg); return true; }
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.detail) detail = j.detail; } catch (_) {}
    _crShowError(typeof detail === 'string' ? detail : 'Request failed.');
    return false;
}

async function _crAddSchool() {
    const nameEl = $('cr-school-name'), boardEl = $('cr-school-board'), cityEl = $('cr-school-city');
    const name = (nameEl && nameEl.value || '').trim();
    if (!name) { _crShowError('School name is required.'); return; }
    _crShowError('');
    const res = await _adminFetch('/schools', {
        method: 'POST',
        body: JSON.stringify({ name, board: (boardEl && boardEl.value || '').trim(), city: (cityEl && cityEl.value || '').trim() }),
    });
    if (await _crHandle(res, 'School added.')) {
        if (nameEl) nameEl.value = ''; if (boardEl) boardEl.value = ''; if (cityEl) cityEl.value = '';
        _refreshClassrooms();
    }
}

// One delegated handler for every add/delete button inside the tree.
async function _crTreeClick(e) {
    const btn = e.target.closest('[data-cr]');
    if (!btn) return;
    const action = btn.getAttribute('data-cr');
    const sid = btn.getAttribute('data-school');
    const cid = btn.getAttribute('data-class');
    const did = btn.getAttribute('data-div');
    _crShowError('');

    if (action === 'add-class') {
        const sel = btn.closest('.cr-add-class').querySelector('.cr-class-grade');
        const res = await _adminFetch(`/schools/${sid}/classes`, {
            method: 'POST', body: JSON.stringify({ grade: sel ? sel.value : '' }),
        });
        if (await _crHandle(res, 'Class added.')) _refreshClassrooms();

    } else if (action === 'add-div') {
        const row = btn.closest('.cr-add-div');
        const nameEl = row.querySelector('.cr-div-name');
        const langEl = row.querySelector('.cr-div-lang');
        const name = (nameEl && nameEl.value || '').trim();
        if (!name) { _crShowError('Division name is required.'); return; }
        const res = await _adminFetch(`/schools/${sid}/classes/${cid}/divisions`, {
            method: 'POST', body: JSON.stringify({ name, preferred_language: langEl ? langEl.value : 'en' }),
        });
        if (await _crHandle(res, 'Division added.')) _refreshClassrooms();

    } else if (action === 'del-school') {
        if (!confirm('Delete this school and ALL its classes and divisions?')) return;
        if (await _crHandle(await _adminFetch(`/schools/${sid}`, { method: 'DELETE' }), 'School deleted.')) _refreshClassrooms();

    } else if (action === 'del-class') {
        if (!confirm('Delete this class and its divisions?')) return;
        if (await _crHandle(await _adminFetch(`/schools/${sid}/classes/${cid}`, { method: 'DELETE' }), 'Class deleted.')) _refreshClassrooms();

    } else if (action === 'del-div') {
        if (await _crHandle(await _adminFetch(`/schools/${sid}/classes/${cid}/divisions/${did}`, { method: 'DELETE' }), 'Division deleted.')) _refreshClassrooms();
    }
}

(function _initClassroomsUI() {
    const bind = () => {
        const openBtn = $('classrooms-btn');
        const backBtn = $('classrooms-back');
        const closeBtn = $('classrooms-close');
        const addSchoolBtn = $('cr-add-school-btn');
        const tree = $('classrooms-tree');
        const nameInput = $('cr-school-name');
        if (openBtn) openBtn.addEventListener('click', _openClassroomsPanel);
        if (backBtn) backBtn.addEventListener('click', _closeClassroomsPanel);
        if (closeBtn) closeBtn.addEventListener('click', _closeClassroomsPanel);
        if (addSchoolBtn) addSchoolBtn.addEventListener('click', _crAddSchool);
        if (tree) tree.addEventListener('click', _crTreeClick);
        if (nameInput) nameInput.addEventListener('keydown', ev => {
            if (ev.key === 'Enter') { ev.preventDefault(); _crAddSchool(); }
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
