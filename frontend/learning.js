// ============================================================================
// learning.js — student learning surface: YouTube choice buttons, MCQ quiz,
// summary, notes cards, practice files + AI practical bundle + printable PDF.
// Phase 4 Step D extraction. Loaded BEFORE script.js (ordered classic <script>).
// Shared state (currentQuiz, pendingYouTube, pendingSendTranscript) and helpers
// ($, addMessage, showToast, escapeHtml, API, speakText) live in script.js and
// are referenced here only at call time (post-init). _renderAITaskCard +
// renderMarkdown also live here; admin.js calls them cross-file at runtime.
// ============================================================================

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

// [Phase 4] Classroom Attention AI (Feature 4) moved to media.js (loaded before
// this file). It sat between submitAnswer and renderQuizResult in the monolith;
// learning.js is now purely YouTube/quiz/summary/notes/practice.

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
        // Summary is plain markdown (no card class), so tag its bubble as a rich
        // output — this keeps it visible in hide-chat (voice-only) mode.
        const summaryMsg = summaryEl.closest && summaryEl.closest('.message');
        if (summaryMsg) summaryMsg.classList.add('rich-output');
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
