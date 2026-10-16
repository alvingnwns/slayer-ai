# Research report & implementation plan

*Nichirin AR — an unofficial, fan-made, Demon Slayer-inspired AR katana. Not affiliated with or endorsed by the rights holders of* Demon Slayer: Kimetsu no Yaiba. *No official artwork, logos, audio or models are used; every visual and sound is procedurally generated.*

How to read this: each claim is tagged **[verified]** (read from the source during this project), **[search]** (seen in a search snippet, not read in full), or **[knowledge]** (my background knowledge, not re-checked here). Anything I designed myself is under *Creative interpretation*.

---

## 1. Canonical series details vs. creative interpretation

| Topic | Canonical / sourced | Creative interpretation (this project) |
|---|---|---|
| Nichirin blades | Demon-slaying swords are made of an alloy called "Nichirin" **[verified — Wikipedia]**. Blade colour is tied to the wielder's Breathing Style and skill, and changes when first gripped **[search — Dafunda, Beebom, Den of Geek]**. | Steel-grey blade that "washes" into the style colour while materialising. Each style gets its own tsuba silhouette and a slightly different blade width. The exact tsuba shapes are mine, not copies of any character's guard. |
| Flame Breathing | Wielders imagine "orange-and-goldish yellow flames" on weapon/body; heavy single strikes from high stances **[search — Kimetsu no Yaiba wiki]**. Red blade, flame-patterned guard for its best-known user **[search]**. | Red → orange → gold → warm-white ramp, rising embers, curved fire trail, heat haze. |
| Water Breathing | Blue style, 11 forms **[search — wiki table]**; blue blade **[search]**. Water is drawn as flowing ribbons/waves in the anime **[knowledge]**. | Spiral water ribbons, wave-shaded sweep trail, droplets, crescent arc slash, dispersal on recovery. |
| Insect Breathing | Listed as "lavender-blue", 5 forms, used by Shinobu Kocho **[search — wiki table]**. Thrust-based, butterfly motif **[knowledge]**. | Violet / magenta / lavender with cyan accents (per the brief; the wiki's "lavender-blue" sits inside this range), butterflies, hair-fine trails, needle thrust. |
| Thunder Breathing | Yellow style, 7 forms; users' movements are fast enough to produce thunder-like sound **[search — wiki]**; gold/yellow blade with lightning pattern **[search]**. | Procedural forked lightning, zig-zag trail, short wind-up → dash, one controlled flash. |
| Breathing effects in-world | The wiki notes the elemental visuals are what observers *perceive*, not literal elements, with Thunder as an exception **[search]**. | We render them literally, as a stylised homage. |
| Japanese names | 炎の呼吸 *Honō no Kokyū*, 水の呼吸 *Mizu no Kokyū*, 蟲の呼吸 *Mushi no Kokyū*, 雷の呼吸 *Kaminari no Kokyū* **[knowledge]**. | Shown in the style selector. |
| Production | Anime produced by Ufotable **[verified — Wikipedia]**. | Visual language (clean glow, ribbon-like elemental trails) is inspired by the general look; no frame-for-frame imitation. |

Sources
- Wikipedia, *Demon Slayer: Kimetsu no Yaiba* — https://en.wikipedia.org/wiki/Demon_Slayer:_Kimetsu_no_Yaiba
- Kimetsu no Yaiba wiki, *Breathing Style* (+ style pages as shown in search excerpts) — https://kimetsu-no-yaiba.fandom.com/wiki/Breathing_Style (individual pages returned HTTP 402 to automated fetches, so only search excerpts were available)
- Nichirin colour explainers — https://dafunda.com/en/otakus/meanings-of-nichirin-sword-colors-in-demon-slayer/ · https://beebom.com/demon-slayer-swords-names-colors-complete-list/amp/ · https://www.denofgeek.com/?p=657396
- Official anime site (not consulted in this session; recommended for anyone wanting more accurate design reference): https://kimetsu.com

**Honest gap:** I could not read the official site or individual wiki pages, so exact guard designs and the on-screen effect palettes per form are not verified. The palettes above follow your brief and the colour words found in search results.

## 2. Technical research

### MediaPipe Hand Landmarker (web) — **[verified]** from the official guide
Source: https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js
- Package `@mediapipe/tasks-vision`; `FilesetResolver.forVisionTasks(wasmRoot)` then `HandLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath }, runningMode, numHands, … })`.
- Options: `runningMode` IMAGE|VIDEO, `numHands` (default 1), `minHandDetectionConfidence` / `minHandPresenceConfidence` / `minTrackingConfidence` (default 0.5).
- Video: `detectForVideo(video, timestampMs)` in a render loop; the call is synchronous and blocks the UI thread (the guide suggests workers for heavy use).
- Output: 21 landmarks per hand — `x`,`y` normalised to the image, `z` relative depth with the wrist as origin; `worldLandmarks` in metres with the origin at the hand's geometric centre; handedness categories.
- What we do with it: **only** read the landmarks. Gesture classification, smoothing, mapping, rendering and VFX are all ours (`src/tracking/*`, `src/sword/*`, `src/vfx/*`).
- Observed in this project: the GPU delegate loads and runs in Chromium/Edge; a local WASM + model copy works offline.

### Three.js techniques used — **[knowledge]**, API names not re-fetched this session
Docs root: https://threejs.org/docs/
- `EffectComposer` + `RenderPass` + `UnrealBloomPass` + `OutputPass` for HDR bloom and tone mapping.
- Custom `ShaderMaterial`s with additive blending for trails, auras, slashes, point sprites.
- `BufferGeometry` with dynamic attributes for ribbons/sweeps/lightning (no per-frame allocations).
- `PMREMGenerator` + `RoomEnvironment` for steel reflections without an HDR file.
- `onBeforeCompile` to inject a dissolve/materialise effect into standard PBR materials.
- `GLTFLoader` for the optional GLB override.

### Browser camera, performance, coordinates — **[knowledge]**
- `getUserMedia` needs a secure context (HTTPS or `localhost`); the permission prompt must be triggered from a user gesture to be reliable → the start screen button.
- Selfie view is mirrored: mirroring is applied once, when converting video coordinates to scene coordinates (`Stage.videoToNdc`) and in the background shader, so landmarks, preview and sword agree.
- Cover-fit background: video-to-screen mapping accounts for the crop so the sword lands on the visible hand, not on the un-cropped video.

## 3. Assets and licences

| Asset | Decision | Licence |
|---|---|---|
| Katana model | **Procedural** (`src/sword/katana.js`): swept blade with hamon emissive map, wrapped tsuka, per-style tsuba, habaki, kashira. Optional override: drop a GLB at `public/models/katana.glb`. | Own work — no third-party licence. |
| Third-party CC0 katana | A CC0 PSX-style katana (≈464 tris, GLB) was seen on itch.io in a search result; it was **not** downloaded or checked, and a 464-tri model would look weak next to the VFX. Not used. | n/a |
| MediaPipe runtime + hand model | Copied/downloaded locally by `scripts/fetch-assets.mjs`. | Apache-2.0 (MediaPipe) — check the model card at https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker before redistributing the `.task` file. |
| three.js | npm dependency | MIT |
| Audio | Generated live with the Web Audio API — no samples. | Own work |
| Fonts | System fonts only (no downloads). | n/a |

## 4. Architecture

```
webcam ─► HandTracker (MediaPipe, landmarks only)
              │ landmarks + world landmarks
              ▼
        analyzeHand ─► {palm pos, size, up, across, normal, fist, open}
              │                       │
              ▼                       ▼
        FistDetector            SwordRig (One-Euro smoothing,
   (hysteresis, grace,           calibration, depth cue)
    dropout hold, cooldown)            │ pose
              │ close/open             ▼
              ▼                  Katana (procedural/GLB)
        SwordController ──► frame description ──► StyleFx × 4
   hidden→summoning→ready⇄          (Flame / Water / Insect / Thunder:
   charging→attack→recover          trails, particles, bolts, slashes)
                                          │
                              Stage: bloom, heat haze, flash, shake
        mouse / keyboard ─► same HandSample interface (fallback)
```

Design rules
- Tracking, gesture logic and the sword state machine are framework-free and unit-tested (`test/`).
- One interface (`HandSample`) feeds the rig; the mouse fallback produces the same object, so every feature works without a camera.
- No allocations in the frame loop for particles/trails/lightning: typed arrays, ring buffers, preallocated meshes. The four styles share a few geometry/material patterns (`vfx/common.js`, `vfx/particles.js`).
- Switching style never reloads anything: each style's effect set is built once; `weight` cross-fades them.

## 5. Checkpoints (as executed)

1. Research + plan — this document.
2. Layout + webcam hand tracking — `index.html`, `ui/`, `tracking/handTracker.js`.
3. Fist detection + coordinate mapping — `tracking/gestures.js`, `handPose.js`, `scene/stage.js`, `sword/rig.js` (+ unit tests).
4. Katana + summoning — `sword/katana.js` (dissolve reveal), `sword/controller.js`.
5. Selector + activation logic — `ui/ui.js`, `main.js` (keys/mouse fallback, charge → attack).
6. VFX, one style at a time — `vfx/flame.js`, `water.js`, `insect.js`, `thunder.js`.
7. Performance & errors — adaptive quality, pooled buffers, permission/model/GL failure paths, tab-hidden camera release.
8. Test + docs — see `README.md` § Verification.

## 6. Known limitations

- **No true 3D / no finger occlusion.** A single RGB webcam gives reliable 2D position and in-plane angle, only rough tilt and depth. The sword is drawn *over* the hand; fingers never wrap in front of the handle. Depth is an approximation from apparent palm size (toggleable).
- **Grip is an approximation.** The blade is anchored at the palm centre and aimed along the forearm direction (or the knuckle line). It is not physically constrained to the fist.
- **Gesture thresholds were derived from hand geometry, and unit-tested on synthetic hands, but not tuned on real hands in this environment.** Use the live FIST meter / debug overlay (`D`) and the settings sliders to tune for your lighting and camera.
- **Hold-mode trade-off.** Swinging hard can partially open the hand; the grace period (default 450 ms) hides this, but a very loose fist will sheathe the sword. Latch mode avoids it.
- **MediaPipe runs on the main thread** (synchronous API). On slow GPUs the tracker self-throttles to ~half the frame budget, so tracking rate drops before rendering does.
- Heat distortion is a local screen-space warp, not true refraction.
- Audio is synthesised; it has not been auditioned by a human in this build, so levels may need taste-tuning (volume slider provided).
