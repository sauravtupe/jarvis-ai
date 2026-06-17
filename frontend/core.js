// ============================================================================
// core.js — universal micro-helpers loaded FIRST (right after orb.js), before
// every feature module. Phase 4.
//
// Why this file exists: the feature modules (and media.js's classroom DOM
// consts) reference `$` at LOAD time (top-level `const x = $('id')`). Classic
// <script> tags don't share a binding until each script executes, so `$` must
// be defined by an earlier-loading script than any file that uses it at load
// time. script.js (the foundation) loads LAST, so `$` cannot live there.
// Keep this file tiny — only put helpers here that are needed at module load.
// ============================================================================

const $ = id => document.getElementById(id);
