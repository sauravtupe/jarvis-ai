// ============================================================================
// school.js — AI Teacher Phase 1: classroom (School -> Class -> Division) picker.
// Loaded AFTER auth.js and BEFORE script.js (ordered classic <script>, one global
// scope). It exposes getActiveDivisionId(), which script.js's sendMessage() reads
// at call time to tag each chat request — so the teacher persona speaks the
// division's preferred language automatically. Shared helpers ($, API, showToast)
// live in earlier files and are only referenced here at call time (post-init).
// ============================================================================

const _DIVISION_KEY = 'jarvis_active_division';
let _schoolsTree = [];

const _LANG_LABEL = { en: 'English', hi: 'Hindi', mr: 'Marathi' };
function _gradeLabel(g) { return g === 'UKG' ? 'UKG' : 'Class ' + g; }

// ---- Active-division state (localStorage; survives reloads) -----------------
function getActiveDivision() {
    try { const raw = localStorage.getItem(_DIVISION_KEY); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
}
// Read at call time by script.js sendMessage()/sendMessageWithImage().
function getActiveDivisionId() {
    const d = getActiveDivision();
    return d && d.division_id ? d.division_id : null;
}
function _saveActiveDivision(obj) { try { localStorage.setItem(_DIVISION_KEY, JSON.stringify(obj)); } catch {} }
function clearActiveDivision() { try { localStorage.removeItem(_DIVISION_KEY); } catch {} }

// ---- Header pill ------------------------------------------------------------
function _shEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _renderDivisionPill() {
    const pill = $('division-pill');
    if (!pill) return;
    const d = getActiveDivision();
    if (d && d.division_id) {
        pill.innerHTML = '🏫 ' + _shEsc(d.grade_label || _gradeLabel(d.grade || '')) + ' · ' + _shEsc(d.division_name || '');
        pill.title = (d.school_name || '') + ' — ' + (d.grade_label || '') + ' ' + (d.division_name || '')
            + ' (' + (_LANG_LABEL[d.preferred_language] || 'English') + ')';
        _refreshDivisionProgress();   // append "done/total" once it loads
    } else {
        pill.innerHTML = '🏫 Select classroom';
        pill.title = 'Choose the class you are teaching';
    }
    pill.style.display = '';
}

// Phase 2 — show how far this class has reached ("Class 5 · A  2/8") and what's next.
// Non-fatal: the pill still works if the request fails.
async function _refreshDivisionProgress() {
    const d = getActiveDivision();
    const pill = $('division-pill');
    if (!d || !d.division_id || !pill) return;
    try {
        const res = await fetch(`${API}/divisions/${d.division_id}/progress`);
        if (!res.ok) return;
        const p = await res.json();
        if (!p || !p.total_chapters) return;
        pill.innerHTML = '🏫 ' + _shEsc(d.grade_label || '') + ' · ' + _shEsc(d.division_name || '')
            + ' <span class="dz-count">' + p.completed_count + '/' + p.total_chapters + '</span>';
        pill.title = (d.school_name || '') + ' — ' + (d.grade_label || '') + ' ' + (d.division_name || '')
            + ' (' + (_LANG_LABEL[d.preferred_language] || 'English') + ')'
            + ' · Completed ' + p.completed_count + ' of ' + p.total_chapters + ' lessons'
            + (p.next_title ? ' · Next: Chapter ' + p.next_chapter + ' — ' + p.next_title : '');
    } catch (e) { /* progress is a nicety — never block the UI */ }
}

// ---- Data load --------------------------------------------------------------
async function _loadSchoolsTree() {
    try {
        const res = await fetch(`${API}/schools`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        _schoolsTree = Array.isArray(data.schools) ? data.schools : [];
    } catch (e) {
        console.warn('[CLASSROOM] Failed to load schools', e);
        _schoolsTree = [];
    }
    return _schoolsTree;
}

function _opt(value, label) { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }

function _populateSchoolSelect() {
    const sel = $('dz-school'); if (!sel) return;
    sel.innerHTML = '';
    sel.appendChild(_opt('', '— Select school —'));
    _schoolsTree.forEach(s => sel.appendChild(_opt(s.id, s.name)));
}
function _populateClassSelect(schoolId) {
    const sel = $('dz-class'); if (!sel) return;
    sel.innerHTML = '';
    sel.appendChild(_opt('', '— Select class —'));
    const school = _schoolsTree.find(s => s.id === schoolId);
    const classes = school ? (school.classes || []) : [];
    classes.forEach(c => sel.appendChild(_opt(c.id, _gradeLabel(c.grade))));
    sel.disabled = !classes.length;
}
function _populateDivisionSelect(schoolId, classId) {
    const sel = $('dz-division'); if (!sel) return;
    sel.innerHTML = '';
    sel.appendChild(_opt('', '— Select division —'));
    const school = _schoolsTree.find(s => s.id === schoolId);
    const klass = school ? (school.classes || []).find(c => c.id === classId) : null;
    const divs = klass ? (klass.divisions || []) : [];
    divs.forEach(d => sel.appendChild(
        _opt(d.id, 'Division ' + d.name + ' (' + (_LANG_LABEL[d.preferred_language] || 'English') + ')')
    ));
    sel.disabled = !divs.length;
}

function _updateStartBtn() {
    const btn = $('dz-start-btn'), sel = $('dz-division');
    if (btn) btn.disabled = !(sel && sel.value);
}

// ---- Overlay open/close -----------------------------------------------------
async function openDivisionPicker() {
    const overlay = $('division-overlay'); if (!overlay) return;
    overlay.style.display = 'flex';
    await _loadSchoolsTree();
    const hasAny = _schoolsTree.some(s => (s.classes || []).some(c => (c.divisions || []).length));
    const body = $('division-picker-body'), empty = $('division-empty'), startBtn = $('dz-start-btn');
    if (body) body.style.display = hasAny ? '' : 'none';
    if (empty) empty.style.display = hasAny ? 'none' : '';
    if (startBtn) startBtn.style.display = hasAny ? '' : 'none';
    if (!hasAny) return;

    _populateSchoolSelect();
    const cur = getActiveDivision();
    if ($('dz-class')) $('dz-class').disabled = true;
    if ($('dz-division')) $('dz-division').disabled = true;
    // Pre-select the current classroom (so "change" lands on what's active).
    if (cur && cur.school_id) {
        $('dz-school').value = cur.school_id;
        _populateClassSelect(cur.school_id);
        if (cur.class_id) {
            $('dz-class').value = cur.class_id;
            _populateDivisionSelect(cur.school_id, cur.class_id);
            if (cur.division_id) $('dz-division').value = cur.division_id;
        }
    }
    _updateStartBtn();
}

function _closeDivisionPicker() { const o = $('division-overlay'); if (o) o.style.display = 'none'; }

function _confirmDivision() {
    const schoolId = $('dz-school') && $('dz-school').value;
    const classId = $('dz-class') && $('dz-class').value;
    const divId = $('dz-division') && $('dz-division').value;
    if (!divId) return;
    const school = _schoolsTree.find(s => s.id === schoolId);
    const klass = school ? (school.classes || []).find(c => c.id === classId) : null;
    const div = klass ? (klass.divisions || []).find(d => d.id === divId) : null;
    if (!div) return;
    const record = {
        school_id: schoolId, school_name: school.name,
        class_id: classId, grade: klass.grade, grade_label: _gradeLabel(klass.grade),
        division_id: divId, division_name: div.name,
        preferred_language: div.preferred_language || 'en',
    };
    _saveActiveDivision(record);
    _renderDivisionPill();
    _closeDivisionPicker();
    if (typeof showToast === 'function') {
        showToast('Classroom set: ' + record.grade_label + ' ' + record.division_name
            + ' · ' + (_LANG_LABEL[record.preferred_language] || 'English'), 'success');
    }
}

// Called by auth.js once the user is "in" (signed in OR guest/test mode). Renders
// the pill and, on first entry with no classroom chosen, prompts the picker once.
function _onAuthResolved() {
    _renderDivisionPill();
    if (!getActiveDivisionId()) openDivisionPicker();
}

// Bind picker controls. Called from script.js init() BEFORE _initAuth(), so the
// cascade handlers exist by the time _onAuthResolved() may open the picker.
function _initSchoolUI() {
    const pill = $('division-pill');
    if (pill) pill.addEventListener('click', openDivisionPicker);

    const schoolSel = $('dz-school');
    if (schoolSel) schoolSel.addEventListener('change', () => {
        _populateClassSelect(schoolSel.value);
        const dSel = $('dz-division');
        if (dSel) { dSel.innerHTML = '<option value="">— Select division —</option>'; dSel.disabled = true; }
        _updateStartBtn();
    });
    const classSel = $('dz-class');
    if (classSel) classSel.addEventListener('change', () => {
        _populateDivisionSelect($('dz-school').value, classSel.value);
        _updateStartBtn();
    });
    const divSel = $('dz-division');
    if (divSel) divSel.addEventListener('change', _updateStartBtn);

    const startBtn = $('dz-start-btn');
    if (startBtn) startBtn.addEventListener('click', _confirmDivision);
    const skipBtn = $('dz-skip-btn');
    if (skipBtn) skipBtn.addEventListener('click', _closeDivisionPicker);
}
