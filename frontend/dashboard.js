// ============================================================================
// dashboard.js — AI Teacher Phase 4: admin/teacher analytics dashboard.
// Loaded AFTER admin.js (uses _adminFetch at call time) and BEFORE script.js.
// Vanilla JS + inline SVG charts (no libraries — self-contained). Renders KPI
// cards, an overall-completion donut, an open-doubts bar chart, and a sortable
// per-division table from the single GET /admin/dashboard aggregation.
// ============================================================================

const _DASH_LANG = { en: 'EN', hi: 'HI', mr: 'MR' };
let _dashRows = [];
let _dashSort = { key: 'completion_pct', dir: 'desc' };

function _dashEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _dashNum(n) { return (n == null ? 0 : n).toLocaleString(); }

// Relative "last active" — accessible plain text, not colour-only.
function _dashAgo(iso) {
    if (!iso) return '—';
    const then = new Date(iso).getTime();
    if (isNaN(then)) return '—';
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
}

// ---- Open / close -----------------------------------------------------------
function _openDashboard() {
    const ov = $('dashboard-overlay');
    if (!ov) return;
    ov.style.display = 'flex';
    ov.setAttribute('aria-hidden', 'false');
    _loadDashboard();
}
function _closeDashboard() {
    const ov = $('dashboard-overlay');
    if (ov) { ov.style.display = 'none'; ov.setAttribute('aria-hidden', 'true'); }
}

// ---- Data load --------------------------------------------------------------
async function _loadDashboard() {
    const body = $('dashboard-body');
    if (body) body.innerHTML = '<div class="dash-loading">Loading dashboard…</div>';
    try {
        const res = await _adminFetch('/admin/dashboard');
        if (!res.ok) {
            if (body) body.innerHTML = `<div class="dash-empty">Couldn't load dashboard (HTTP ${res.status}).</div>`;
            return;
        }
        const data = await res.json();
        _dashRows = Array.isArray(data.divisions) ? data.divisions : [];
        _renderDashboard(data.totals || {}, data.generated_at);
    } catch (e) {
        if (body) body.innerHTML = `<div class="dash-empty">Network error: ${_dashEsc(e.message)}</div>`;
    }
}

// ---- Render -----------------------------------------------------------------
function _renderDashboard(totals, generatedAt) {
    const body = $('dashboard-body');
    if (!body) return;
    if (!_dashRows.length) {
        body.innerHTML = `
          <div class="dash-empty">
            <p>No classrooms yet.</p>
            <p class="dash-empty-sub">Open <strong>Manage Classrooms</strong> to add a School → Class → Division,
            then start teaching — this dashboard fills in as classes make progress.</p>
          </div>`;
        return;
    }
    const stamp = generatedAt ? new Date(generatedAt).toLocaleString() : '';
    body.innerHTML = `
      ${_renderKpis(totals)}
      <div class="dash-charts">
        ${_renderDonut(totals.avg_completion_pct || 0)}
        ${_renderDoubtsChart()}
      </div>
      ${_renderTable()}
      <p class="dash-stamp">Snapshot generated ${_dashEsc(stamp)}</p>`;
    _bindTableSort();
}

function _kpiCard(iconSvg, value, label, tone) {
    return `
      <div class="dash-kpi dash-kpi--${tone}">
        <div class="dash-kpi-ico">${iconSvg}</div>
        <div class="dash-kpi-meta">
          <div class="dash-kpi-value">${value}</div>
          <div class="dash-kpi-label">${label}</div>
        </div>
      </div>`;
}

function _renderKpis(t) {
    const I = {
        cls: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/></svg>',
        pct: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 2v10l6 3"/></svg>',
        doubt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.09 9a3 3 0 1 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12" y2="17"/><circle cx="12" cy="12" r="10"/></svg>',
        assess: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
        active: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    };
    return `
      <div class="dash-kpis">
        ${_kpiCard(I.cls, _dashNum(t.divisions), 'Divisions', 'violet')}
        ${_kpiCard(I.pct, (t.avg_completion_pct || 0) + '<span class="dash-unit">%</span>', 'Avg completion', 'blue')}
        ${_kpiCard(I.doubt, _dashNum(t.total_open_doubts), 'Open doubts', (t.total_open_doubts ? 'amber' : 'green'))}
        ${_kpiCard(I.assess, _dashNum(t.total_assessments), 'Assessments run', 'teal')}
        ${_kpiCard(I.active, _dashNum(t.active_7d), 'Active this week', 'green')}
      </div>`;
}

// Overall completion donut (SVG). Center shows %, legend gives completed/remaining.
function _renderDonut(pct) {
    pct = Math.max(0, Math.min(100, pct));
    const r = 52, C = 2 * Math.PI * r, filled = (pct / 100) * C;
    return `
      <div class="dash-card">
        <h4 class="dash-card-title">Overall curriculum completion</h4>
        <div class="dash-donut-wrap">
          <svg class="dash-donut" viewBox="0 0 140 140" role="img" aria-label="Overall completion ${pct} percent">
            <circle cx="70" cy="70" r="${r}" class="dash-donut-track"/>
            <circle cx="70" cy="70" r="${r}" class="dash-donut-value"
              stroke-dasharray="${filled.toFixed(2)} ${(C - filled).toFixed(2)}"
              transform="rotate(-90 70 70)"/>
            <text x="70" y="66" class="dash-donut-pct">${pct}%</text>
            <text x="70" y="86" class="dash-donut-cap">complete</text>
          </svg>
          <div class="dash-legend">
            <span class="dash-legend-item"><i class="dash-dot dash-dot--on"></i>Completed</span>
            <span class="dash-legend-item"><i class="dash-dot dash-dot--off"></i>Remaining</span>
          </div>
        </div>
      </div>`;
}

// Open doubts by division — horizontal bars, direct value labels (not colour-only).
function _renderDoubtsChart() {
    const withDoubts = _dashRows.filter(r => (r.open_doubts || 0) > 0)
        .sort((a, b) => b.open_doubts - a.open_doubts).slice(0, 6);
    if (!withDoubts.length) {
        return `
          <div class="dash-card">
            <h4 class="dash-card-title">Open doubts by division</h4>
            <div class="dash-chart-empty">🎉 No open doubts — every question has been addressed.</div>
          </div>`;
    }
    const max = Math.max(...withDoubts.map(r => r.open_doubts));
    const bars = withDoubts.map(r => {
        const w = Math.round((r.open_doubts / max) * 100);
        const name = `${_dashEsc(r.grade_label)} ${_dashEsc(r.division_name)}`;
        return `
          <div class="dash-bar-row">
            <span class="dash-bar-name" title="${_dashEsc(r.school_name)}">${name}</span>
            <span class="dash-bar-track"><span class="dash-bar-fill" style="width:${w}%"></span></span>
            <span class="dash-bar-val">${r.open_doubts}</span>
          </div>`;
    }).join('');
    return `
      <div class="dash-card">
        <h4 class="dash-card-title">Open doubts by division <span class="dash-card-sub">(top ${withDoubts.length})</span></h4>
        <div class="dash-bars">${bars}</div>
      </div>`;
}

// ---- Sortable table (accessible alternative to the charts) ------------------
function _sortRows() {
    const { key, dir } = _dashSort;
    const mul = dir === 'asc' ? 1 : -1;
    return _dashRows.slice().sort((a, b) => {
        let av = a[key], bv = b[key];
        if (key === 'classroom') {
            av = `${a.school_name} ${a.grade_label} ${a.division_name}`.toLowerCase();
            bv = `${b.school_name} ${b.grade_label} ${b.division_name}`.toLowerCase();
            return av < bv ? -1 * mul : av > bv ? 1 * mul : 0;
        }
        av = av == null ? -1 : av; bv = bv == null ? -1 : bv;
        return (av - bv) * mul;
    });
}

function _renderTable() {
    const rows = _sortRows();
    const arrow = k => _dashSort.key === k ? (_dashSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const body = rows.map(r => {
        const pct = r.completion_pct || 0;
        const langChip = `<span class="dash-lang">${_DASH_LANG[r.preferred_language] || 'EN'}</span>`;
        const cur = r.current_chapter ? `Ch ${r.current_chapter}` : '<span class="dash-dim">—</span>';
        const doubtBadge = r.open_doubts
            ? `<span class="dash-badge dash-badge--amber">${r.open_doubts}</span>`
            : '<span class="dash-dim">0</span>';
        return `
          <tr${r.open_doubts ? ' class="dash-row-flag"' : ''}>
            <td>
              <div class="dash-cls">${_dashEsc(r.grade_label)} ${_dashEsc(r.division_name)} ${langChip}</div>
              <div class="dash-cls-sub">${_dashEsc(r.school_name)}</div>
            </td>
            <td class="dash-prog-cell">
              <span class="dash-prog"><span class="dash-prog-fill" style="width:${pct}%"></span></span>
              <span class="dash-prog-txt">${r.completed_count}/${r.total_chapters} · ${pct}%</span>
            </td>
            <td class="dash-mono">${cur}</td>
            <td class="dash-center">${doubtBadge}</td>
            <td class="dash-mono dash-center">${_dashNum(r.assessments_count)}</td>
            <td class="dash-dim">${_dashAgo(r.last_active_at)}</td>
          </tr>`;
    }).join('');
    return `
      <div class="dash-table-wrap">
        <table class="dash-table">
          <thead><tr>
            <th data-sort="classroom" class="dash-th">Classroom${arrow('classroom')}</th>
            <th data-sort="completion_pct" class="dash-th">Progress${arrow('completion_pct')}</th>
            <th data-sort="current_chapter" class="dash-th">Current${arrow('current_chapter')}</th>
            <th data-sort="open_doubts" class="dash-th dash-center">Doubts${arrow('open_doubts')}</th>
            <th data-sort="assessments_count" class="dash-th dash-center">Assess.${arrow('assessments_count')}</th>
            <th data-sort="last_active_at" class="dash-th">Last active${arrow('last_active_at')}</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
}

function _bindTableSort() {
    document.querySelectorAll('#dashboard-body .dash-th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.getAttribute('data-sort');
            if (_dashSort.key === key) _dashSort.dir = _dashSort.dir === 'asc' ? 'desc' : 'asc';
            else _dashSort = { key, dir: key === 'classroom' ? 'asc' : 'desc' };
            const body = $('dashboard-body');
            // Re-render only the table to keep charts steady.
            const wrap = body.querySelector('.dash-table-wrap');
            if (wrap) { wrap.outerHTML = _renderTable(); _bindTableSort(); }
        });
    });
}

function _initDashboardUI() {
    const openBtn = $('dashboard-btn');
    const closeBtn = $('dashboard-close');
    const refreshBtn = $('dashboard-refresh');
    if (openBtn) openBtn.addEventListener('click', _openDashboard);
    if (closeBtn) closeBtn.addEventListener('click', _closeDashboard);
    if (refreshBtn) refreshBtn.addEventListener('click', _loadDashboard);
}
