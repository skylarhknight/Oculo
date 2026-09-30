# Oculo MVP checklist

Authority: [Version 1.0 PRD](PRD.md). Purchase decisions: [PURCHASE_DEFINITION.md](PURCHASE_DEFINITION.md). Implementation audit: [PRD_ALIGNMENT.md](PRD_ALIGNMENT.md).

A filmmaker imports a relevant scene, saves annotated shots, and shares a readable PNG shot sheet. A planned camera move and video preview are optional additions. Initial release is iPhone; Android compatibility is retained and iPad release is deferred.

Checked items below describe repository implementation or explicitly owner-reported progress. They do not certify physical-device or store acceptance.

## Phases 1–3 — Foundation

- [x] Web app, repository, Capacitor and initial physical-iPhone rendering spike (owner-reported complete).

## Phase 4A — Durable scene and camera contracts

- [x] Stable scene and immutable asset-version references, content fingerprints and runtime URL resolution.
- [x] Versioned persistence/export schemas and additive legacy migration without clearing projects.
- [x] Canonical coordinates, asset transform, camera pose/lens/sensor/framing/clipping/timing persistence.
- [x] Explicit unknown metric scale; Magic Window gain is not calibration.
- [x] Explicit provenance and private-locator/credential sanitization for shared source metadata.
- [x] Preserve validated SPZ encoding version and record import date for new imports.
- [ ] Verify save/reopen/framing/export and legacy project migration on physical iPhone.

## Phase 4B — Composition, shots and movement

- [x] Scene navigation, reset/recenter, camera and sensor controls, framing guides (thumb sticks since Phase 4E).
- [x] Optional Magic Window with tracking status, recenter and touch fallback.
- [x] Ordered named shots, notes, framed thumbnails, open, rename, duplicate, reorder and deletion. Shots without an image get one rendered from their first keyframe when the scene opens.
- [x] Durable project/scene/shot saving with failure and retry states.
- [x] Free movement editing inside each shot: up to 25 keyframes, length, per-segment speed, playback, stop, scrub and undo/redo (Phase 4E replaced the scene-level move).
- [x] A static shot needs no movement to appear on a shot sheet; preserve existing projects regardless of entitlement.
- [ ] Verify three annotated shots, force-quit/relaunch, optical-effect labeling, safe areas, portrait and both landscape orientations on physical iPhone.

## Phase 4D — Mobile flow restructure (implemented 2026-09-25)

Navigation follows Splash → Project gallery → Project → Scene workspace. Since Phase 4H, New project and New scene open the scene gallery first (Project gallery → Scene gallery → Project → Scene workspace). There is no login wall; account and backup live in Settings.

- [x] Multi-scene projects (project schema v3): add scenes from a local SPZ import or the scene gallery; rename, duplicate, and delete scenes (a project keeps at least one).
- [x] Project gallery: search, sort (recent, name, shot count; remembered on the device), overflow and long-press menu with rename, duplicate, and delete.
- [x] Tutorial project on the bundled offline scene: added on first launch, pinned first, excluded from the free project limit, and restorable from Settings. Its copies count as ordinary projects.
- [x] Scene workspace stages: **Shots** (storyboard/list, annotate, reorder, include in export, open), **Compose** (New shot / Add keyframe, camera settings, presets, framing, handheld), **Export** (shot plan default, shot preview video, camera data JSON).
- [x] Device-local camera/lens presets (up to 24) and camera defaults for new scenes.
- [x] Settings screen: camera defaults, reduce motion, haptics, storage, account and backup, Oculo Pro and restore, support and legal.
- [x] Saved shots drawn as markers in the scene, plus the path of the moving shot being edited; tapping a marker opens that shot. Markers are never included in captured shots or exports.
- [x] Versioned camera-data JSON export (OculoShotPlan) per scene, shared through the native share sheet.
- [ ] Planned: a single shot plan that spans every scene in a project (today the plan is exported per scene).
- [x] Apple-style visual redesign (2026-09-26): system font, system colors with light and dark appearance following the device (the scene workspace stays dark), inset grouped lists, iOS switches/segmented controls/sliders, frosted-glass bars and scene controls, and spring-based interaction motion (press feedback, sliding tab and segment indicators, sheet depth effect, badge and keyframe pop-ins). Reduce motion removes the travel. No scope change.
- [ ] Verify the new flow, sheets, and edge-swipe back on physical iPhone.
- [ ] Verify Magic Window permission denial, tracking recovery and explicit touch fallback on physical iPhone.

## Phase 4E — Shots own their movement; thumb-stick navigation (implemented 2026-09-25)

A shot is created once and is either **static** (one keyframe) or **moving** (two or more). Moving shots replace the scene-level camera move built from two saved shots.

- [x] Project schema v4: each shot stores what stays fixed while rolling (lens type — a prime or a zoom with its range — sensor, aspect, near/far, length) and keyframes with what an operator changes while rolling (position, rotation including dutch angle, zoom, focus distance, aperture, and the speed of the segment that follows).
- [x] Older projects migrate on read: every saved still becomes a static shot on a prime, and a scene move with two or more keyframes becomes one moving shot named "Camera move" (a zoom lens when its focal length changes).
- [x] New shot sheet: name, prime or zoom lens, sensor and aspect; the current camera becomes keyframe 1 and its thumbnail.
- [x] Add keyframe records the camera after the last keyframe (or at the playhead between keyframes); Update keyframe re-records the keyframe under the playhead once the camera has moved.
- [x] Shot length (0.5–60 s) retimes keyframes proportionally; per-segment speed presets and the speed-curve editor.
- [x] Zoom is clamped to the shot's lens and locked on a prime. Focus is set by tapping the scene (a ray cast against the splats) or with a distance slider; aperture steps through full stops; dutch angle has its own slider. Focus eases in diopters and aperture in stops between keyframes.
- [x] Focus and aperture are shown as a readout and reticle and exported; they are not rendered as depth of field.
- [x] Thumb sticks over the scene: the left stick walks and strafes level with the ground, the right stick pans and tilts, and two buttons raise and lower the camera. One-finger drag looks around, a two-finger pinch dollies. Walking speed scales with the scene and has slow/normal/fast. The sticks can be hidden.
- [x] Keyboard navigation when the scene has focus (WASD/arrows, Q/E, I/J/K/L, Shift for fast) and press-and-hold "Move camera" buttons for switch and screen reader users.
- [x] Shot sheets list each shot's lens, timing, focus and aperture (with ranges for moving shots); the video preview renders one chosen shot, or a **sequence**: the chosen shots cut together in shot-list order into one MP4 (hard cuts, up to 120 s, following the shot plan selection by default); camera data JSON (OculoShotPlan v3) carries every shot's setup and keyframes.
- [x] The separate "pick up camera and re-frame" screen is removed; opening a shot and updating its first keyframe replaces it.
- [ ] Verify two-thumb ergonomics, tap-to-focus on imported scenes, and stick speed on physical iPhone.
- [ ] Planned: rendered depth of field (out of MVP scope).

## Phase 4C — Portable output

- [x] PNG shot sheets from selected shots, with numbering, names, notes, camera settings, provenance/scale status and available attribution.
- [x] Multi-page preview and native share/Save to Files adapters with browser download fallback.
- [x] Optional MP4 camera-move preview workflow, capability checks and failure/cancel recovery.
- [ ] Verify actual PNG/MP4 received files and offline generation on supported iPhones.
- [ ] Publish measured video resolution/duration/encoding limits; do not imply desktop timeline interchange.

**Gate:** a collaborator understands the exported plan without Oculo or its source scene.

## Phase 4.5 — Import and measured device limits

- [x] Files-compatible SPZ v2/v3 import, content validation, progress/cancellation and immutable app-managed bytes.
- [x] Unknown/captured/generated provenance, optional provider/attribution, orientation correction and unknown physical scale.
- [x] Atomic project/asset commit and reference-aware duplicate/delete cleanup.
- [x] Licensed offline starter scene.
- [ ] Validate representative exports from named providers on the oldest supported iPhone and a newer iPhone.
- [ ] Measure cold import/load, first useful frame, FPS/spikes, peak memory where measurable, storage overhead, background/recovery and 20–30 minute thermal behavior.
- [ ] Confirm the current provisional 64 MiB compressed / 128 MiB decompressed / one-million-splat guards against measurements; revise if justified. Free and Pro use identical technical limits.
- [ ] Verify offline relaunch after moving/deleting the original Files document, low-storage failures and unsupported-file recovery.
- [ ] Optional teammate-owned World Labs connection: validate supported authorization and account/world access without shipping a provider secret. Files import must stay independent.

## Phase 4F — Map view and cinematographer teleport (implemented 2026-09-27)

User-requested scope addition: a fast way to move across a large scene.

- [x] **Map** chip in Compose opens an isometric overview. The camera cranes up and back out of the composed frame while the letterbox irises open to full screen; the composed camera itself does not move.
- [x] Drag to rotate (with inertia and vertical tilt), pinch or wheel to zoom, and ⟲/⟳/compass buttons in 45° steps.
- [x] A minimal clay cinematographer with a red scarf (authored in Blender, `tools/blender/cinematographer.py`) stands where the camera stands, with a "you are here" ring. Drag it from the dock or from the scene: it lifts, dangles, leans into the drag and its scarf trails; over empty space it turns into a red ghost and springs home if released there. Dropped on the scene it lands with a squash and a dust ring.
- [x] After landing, swipe on the scene to aim (a yellow arc shows the heading), then tap **Go**, or wait for the 1.5 s countdown ring. The camera dives into the figure's eyes at eye level (1.6 m when the scene's scale is known, otherwise the camera's current height) and the frame closes back to the output aspect. The landing is one undoable camera edit; when editing a shot it shows **Update keyframe**.
- [x] Accessibility: the dock figure is a button that places the cinematographer at the centre; arrow keys move it, `[`/`]` turn it, Enter goes, Escape closes. Phases are announced. Reduce motion makes the flights instant and removes the countdown, bob and dust.
- [ ] Verify two-finger rotate/zoom comfort and frame rate during the flights on physical iPhone.

## Phase 4G — Shots overview, playback bar and appearance (implemented 2026-09-27)

User-requested additions to the Shots and Compose tabs and to Settings.

- [x] **Shots tab overview:** while the Shots tab is open the scene rises to the same isometric view as the map (no cinematographer), framed to include every saved camera. Each shot's frustum is drawn larger and a numbered pin marks its camera (accent blue for the shot open in Compose, a yellow badge for moving shots). Pins that share a spot stack in rows and pins never overlap. Drag to orbit, pinch to zoom. Tapping a pin opens the shot in Compose and the camera flies down into it; pointing at or focusing a card in the list lifts its pin.
- [x] **Compose playback bar:** while a shot is open a glass bar over the scene has play/stop, a scrubbable track and a diamond per keyframe (tap to jump; the keyframe under the playhead is highlighted).
- [x] **Smaller shot actions:** Add keyframe is a small capsule, with a **New shot** capsule beside it (stacked between the thumbs when the sticks are shown).
- [x] **Appearance setting:** System, Light or Dark in Settings. The scene workspace stays dark in every case.
- [ ] Verify the overview's frame rate with many shots on physical iPhone.

## Phase 4H — Scene gallery (implemented 2026-09-27)

User-requested: a local gallery of ready-made 3DGS scenes, replacing the plain list in the old scene picker sheet. The "scene gallery" source named in Phase 4D is now a full screen.

- [x] **Flow:** New project (after the free-project gate) and a project's New scene open the scene gallery. An "Import your own" card keeps the local SPZ import. Picking a scene creates the project (named after the scene) or adds the scene, then opens Compose.
- [x] **Preview:** tapping a card shows a live isometric preview of that scene in the top half of the screen. It spins slowly, and you can drag to turn it and pinch to zoom; turn buttons serve VoiceOver. The chosen card lifts and shows **Select scene**, and **Select** in the top-right corner also confirms.
- [x] **Scenes:** 10 SuperSplat scenes shared under CC BY 4.0, plus the existing Small Garden starter. Each was reduced to at most 0.8M splats with one SH band (about 11 MB each) by `pnpm scenes:build` (`tools/scenes/`). Tokyo_02 was left out because its creator offers no license or download.
- [x] **Bundled:** Small Garden, LA Night and The Pantheon Interior ship in the app and work offline (about 35 MB in total).
- [x] **Downloaded on tap:** the other 8 download only when tapped, with a progress ring, Cancel and Retry, and a check against their pinned SHA-256. They are then kept on the device for offline use, and Settings → Downloaded scenes can remove them. Nothing is uploaded.
- [x] **Credits:** each card, the preview's info sheet and Settings → Scene credits name the creator, the source, the license and the changes Oculo made. The descriptor attribution carries the same credit into shot sheets and video export.
- [x] **Hosting:** `pnpm scenes:upload` publishes every scene (all 11 `.sog` files, thumbnails, credits and a dataset card) to a public Hugging Face dataset, which is both a git-backed copy and a free host that answers cross-origin requests. It pins the app to that upload's commit in `config/sceneHosting.json`; `VITE_SCENE_GALLERY_BASE_URL` still overrides it.
- [ ] Run the first upload (it needs the owner's Hugging Face account and token), commit the pinned `sceneHosting.json`, and check a download on device. Until then the 8 download cards show "isn't available in this build".
- [ ] Verify preview memory and frame rate while switching scenes on a physical iPhone.

## Phase 4I — Apple-style polish, Compose rework, cutaway map (implemented 2026-09-28)

User-requested: an apple.com look with purposeful motion, a clearer Compose tab, and a readable map for scenes with a sky or ceiling.

- [x] **Cutaway map:** the Map view, the Shots overview and the gallery preview hide a scene's sky dome or ceiling. `scene-core/cutaway.ts` finds the dense core of the scene and any ceiling layer that spans it, and the engine fades everything outside that box with one Spark `SplatEdit`. The roof lifts off during the fly-in and settles back when the map closes. Hidden splats never catch the figure or a tap. A **Roof** toggle in the Map shows it again.
- [x] **Compose:** one top row (Back, a shot menu in the title, Undo/Redo, Map, and a ⋯ menu for aspect, walking speed, thumb sticks, shot markers and reset). A camera-style capture bar: last shot (library) on the left, the shutter in the middle, New shot on the right. With no shot open the shutter saves a shot at once on the current lens (no sheet), and a toast offers **Add notes**. With a shot open it adds a keyframe. The panel has one section at a time: **Lens** (focal length, focus, aperture, dutch; Lens setup opens a sheet), **Move** (keyframe detail with reasons for disabled controls, length, speed, precise moves) and **Notes** (name and notes, saved as you type). Playback lives only on the bar over the scene. A tapped shot marker asks before switching shots, and Tap to focus shows a banner with Cancel. Main controls are at least 44 pt.
- [x] **Look and motion:** display-size titles in SF Pro Display that recede as you scroll, capsule buttons, apple.com-style link buttons, scroll reveals (`ui/useReveal.ts`), a lens-iris splash, a Projects hero with fanned scene prints, a card-to-stage flight in the scene gallery (`ui/flip.ts`), a frosted gallery bar and a product-page paywall. Reduce Motion turns all of it off and never leaves content hidden.
- [x] **Sequence video:** Export → Video → Sequence stitches the chosen shots into one MP4 with hard cuts, in shot-list order, each at its own length and speed. The video takes the first shot's frame; other aspect ratios fit inside it with black bars. Encoder keyframes land on every cut.
- [ ] Check the cutaway on every gallery scene and the capture bar with the sticks on a physical iPhone.

## Phase 5 — iPhone release readiness

- [x] Capacitor/Xcode use `org.example.oculo.student`; Xcode targets iPhone.
- [x] Default release checks target iPhone; independently owned Android checks use `--android`.
- [ ] Confirm the bundle ID against App Store Connect, signing and RevenueCat records.
- [ ] Verify the installed signed build, orientations, safe areas, local privacy manifests, permissions and native share/export behavior.

## Phase 6 — One paid boundary

- [x] Free: one saved project, multiple annotated shots, import, navigation, expanded movement, PNG sheets and supported video previews.
- [x] Oculo Pro: one-time non-consumable for additional projects; no product-imposed count limit, subject to storage.
- [x] Gate new projects (demo scene or import) and duplicates; adding scenes to an existing project is never gated. Retain existing work after entitlement loss/unavailability. Explicit deletion frees capacity; never overwrite automatically.
- [x] Use `oculo_pro`; reject subscription/consumable offers; show store-localized one-time price and account-independent Restore Purchases.
- [x] Existing remote/conflict recovery preserves prior work even when the free capacity is exceeded.
- [x] Select launch pricing: **US$9.99 one-time**, **USD**, **United States** base storefront; app download remains free. See the purchase definition.
- [ ] Confirm the proposed catalog identifiers and configure the approved price and regional prices in App Store Connect / RevenueCat.
- [ ] Complete paid-app agreements, banking/tax, availability and team/contact details.
- [ ] Create/configure the non-consumable in App Store Connect and matching RevenueCat product, entitlement, offering/package and public iOS SDK key.
- [ ] Verify native purchase, cancellation, pending payment, restore without app login, offline entitlement recovery, account changes and revocation.

## Phase 7 — Accounts, disclosures and submission

- [x] Local core workflow works without an Oculo account; imported source files are not advertised as cloud-synced.
- [ ] If accounts ship, validate sign-in/backup/conflicts, account deletion and asynchronous provider cleanup with accurate disclosure.
- [ ] Publish privacy, terms and support pages and configure their URLs.
- [ ] Finalize screenshots and reviewer instructions from the actual integrated iPhone build.
- [ ] Complete beta testing with filmmakers and the PRD's full release acceptance workflow.
- [ ] Archive, submit and handle review findings.

Scanning, actor/prop placement, lighting simulation, AI copilot, location marketplace, DCC/desktop editing, cloud collaboration, and iPad/Android releases remain deferred opportunities.
