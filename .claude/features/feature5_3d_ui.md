# Feature 5 — 3D UI Redesign (Frontend Only)

## Status
Not built yet.

## What It Does
Redesigns the frontend with a glassmorphism dark theme, 3D particle effects, and smooth animations — all on top of the existing UI without touching any backend code.

## ⚠️ Zero Backend Changes
This is a **frontend-only** feature. Do not modify any `.py` files.

## Design Language

- Dark theme background
- Glassmorphism panels (frosted glass effect with backdrop-filter)
- Electric blue / cyan accent colors
- Depth shadows and glow effects on interactive elements
- CSS 3D transforms for panel depth

## Libraries (CDN only — no npm, no bundler)

| Library | Version | Purpose |
|---|---|---|
| Three.js | r128 | Particle background / ambient 3D effects |
| GSAP | 3 | Smooth animations, transitions, entrance effects |

## Critical Rule
- Build **ON TOP of** `orb.js` — never replace, remove, or modify it
- `orb.js` is the WebGL GLSL shader that powers the central orb — it is the visual identity of the app

## Files to Modify

- `frontend/index.html` — add CDN script tags for Three.js + GSAP, restructure layout for 3D depth
- `frontend/style.css` — full redesign with glassmorphism, dark theme, glow effects, CSS 3D
- `frontend/script.js` — add Three.js particle scene init, GSAP animation triggers on UI events

## Do NOT touch

- `frontend/orb.js` — ever
- Any backend file

## Notes

- All Three.js + GSAP loaded via CDN — no package.json changes
- Test that existing chat, voice, camera, and TTS all still work after the redesign
- Particles should be ambient background — subtle, not distracting
