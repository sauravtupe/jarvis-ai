# Feature 6 — Animated AI Avatar (Frontend Only)

## Status
Not built yet.

## What It Does
Adds an animated 3D AI avatar (VRM model) in the hero section alongside the existing orb. The avatar reacts to mic input and TTS playback with 3 distinct animation states.

## ⚠️ Zero Backend Changes
This is a **frontend-only** feature. Do not modify any `.py` files.

## Avatar States

| State | Trigger | Animation |
|---|---|---|
| `idle` | Default / no activity | Gentle floating loop |
| `listening` | Mic is active | Alert posture, reactive motion |
| `talking` | TTS audio is playing | Lip sync movement |

## Lip Sync
- Use **Web Audio API** to detect amplitude from the TTS audio stream in real time
- Drive mouth/jaw blend shapes on the VRM model based on amplitude

## Libraries

- `Three.js` — already added in Feature 5
- `three-vrm` — VRM model loader for Three.js

## Fallback
If `three-vrm` fails to load or the VRM model fails to parse:
- Fall back to a **CSS/JS animated SVG character** instead
- The fallback must also support the 3 states (idle, listening, talking)

## Files to Modify

- `frontend/index.html` — add avatar container in hero section, load three-vrm via CDN
- `frontend/script.js` — VRM model load, state machine (idle/listening/talking), Web Audio amplitude detection, fallback SVG logic

## Do NOT touch

- `frontend/orb.js` — ever
- Any backend file

## Notes

- Avatar sits **alongside** the orb — does not replace it
- VRM model file should be a lightweight free model (e.g. from VRoid Hub) — include the path in the HTML or load from a URL
- State transitions should be smooth (use GSAP from Feature 5 for crossfades)
- Test that existing chat, voice, camera, and TTS still work correctly after adding the avatar
