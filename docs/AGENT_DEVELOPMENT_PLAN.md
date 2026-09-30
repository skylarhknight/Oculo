# Agent-verifiable development acceptance

All five development goals are implemented in source. Acceptance is determined
by the current candidate's actual checks, screenshots, and artifacts. The latest
completed run is indexed by `artifacts/release-candidate/latest.json`; each run
retains its source fingerprint, logs, and explicit technical/coverage results.
This document describes the requirements and their evidence, not a substitute
for a passing technical report.

## 1. Camera playback and saved projects

The editor preserves exact saved endpoints, owns the camera through playback and
scrubbing, pauses on backgrounding, and flushes the latest editor state through a
serialized save coordinator. Failed navigation saves remain recoverable. Scene
loading is abortable and atomic; viewer failures release local URLs immediately.
Readiness waits for Spark's first prepared frame before enabling capture.

Evidence:

- `App.test.tsx`: endpoint playback, pause/resume, scrub cancellation and keyboard
  endpoints, shortened duration, reopen, failed navigation saves, export camera
  ownership and background persistence.
- `SceneEngine.test.ts` / `SceneViewer.test.tsx`: projection and resize invariants,
  interrupted/replaced loads, stale callbacks, retry, background suspension,
  first-frame readiness, and resource restoration.
- `TrackingPersistence.test.tsx`: real camera math and simulated tracking loss,
  relocalization, exact rolled endpoint recall, resize, offline saving through
  `ProjectSaveCoordinator` and IndexedDB, then new-store/new-engine reopen with
  the same camera and speed curve.
- Browser report: first-ready-shot pixels, exact playback endpoint, imported
  project reopen offline, and a full browser restart with external networking
  blocked. A browser still needs its app shell served; native assets are bundled.

## 2. Reversible camera editing

Undo/redo includes camera optics/recall/reset, paths, waypoint replacement,
arrival times, duration, curves, and matching playhead position. Continuous
pointer drags and held arrow keys are one action. History is bounded to 100
in-memory actions per editor session; resulting edits are saved, while the
history stack resets on reopen. Saved-shot metadata/thumbnail editing and display
settings are outside this camera-history stack.

Waypoint selection previews the exact camera; replacement retains arrival times
and curves. Insert/delete/move replacement clears selection when identities
change. Segment looping and the expanded graph share segment selection. The
expanded graph measures both dimensions so handles and text retain their shape.

Evidence: `CameraEditHistory.test.ts`, `cameraMoveEditing.test.ts`,
`SpeedCurveEditor.test.tsx`, `SpeedCurveHistory.test.tsx`, and `App.test.tsx` cover
coalescing, cancellation, redo invalidation, selection, looping, duration undo,
and keyboard behavior. `verify-editor.mjs` exercises actual mouse/touch drags,
keyboard shortcuts, playback, saving/reopen, and phone/tablet screenshots. The
screenshots are reviewed visually, not accepted merely because files exist.

## 3. Local scene import and project management

SPZ gzip versions 2 and 3 are supported, with bounded streaming validation,
progress, cancellation, orientation, and initial camera fitting including
Gaussian extent and large-scene clipping. Limits are 64 MiB compressed, 128 MiB
decoded, and one million splats. Version 4 and other formats are rejected clearly.

IndexedDB version 4 adds immutable scene Blobs through an additive migration.
Import commits bytes and project together. Copies share scene bytes and have
independent shot-image records; deletion and reference replacement collect only
the final unused asset. Imported projects stay local even when signed in and are
excluded from Firebase backup selection.

Evidence: `sceneImport.test.ts`, `ImportSceneModal.test.tsx`,
`ProjectAssets.test.ts`, schema/store/sync tests, and `importedFixture.test.ts`
cover real SPZ decoding, malformed/truncated/oversized payloads, bounds,
orientation, migration, quota rollback, cancellation, input mutation, and shared
asset protection. The browser report proves actual file-picker import, Spark
rendering, offline duplication/deletion, and retained bytes after restart.

## 4. Deterministic preview-video export

The application has a replaceable encoder-session port and a capability-checked
WebCodecs/Mediabunny H.264 MP4 adapter, independently exercised in Chrome. Native
and browser delivery use the existing sharing adapters. Unsupported encoders
leave editing usable and offer PNG shot sheets as the alternative.

Frames use saved motion, curves, lens/sensor/clipping, aspect, and duration.
Output is a short 720p preview at nominal 30 fps without audio. The final frame
samples the exact endpoint at the saved duration while retaining its scheduled
PTS (at most one frame early); other frames sample their PTS. This convention
includes both endpoints without extending the clip. Source attribution and
rendering modifications are embedded in MP4 metadata. Mediabunny's license and
pinned source provenance are bundled and accessible from the app.

Evidence: export/dialog/sharing tests cover startup/render/finalize cancellation,
late encoder cleanup, failures, retry, camera restoration, and temporary-file
cleanup. `verify-video-export.mjs` renders a real SPZ, encodes a five-second,
150-frame H.264 MP4, decodes every frame with FFmpeg, checks timestamps and
attribution with ffprobe, and compares five frames (including endpoints, interior
waypoint, changing lenses/aspects/curves) against independent PNG references.
See `services/videoExport/README.md` for timing and adapter details.

## 5. Reproducible release-candidate pipeline

Run `corepack pnpm release:candidate` (or the direct Node fallback documented in
[RELEASE_CANDIDATE.md](RELEASE_CANDIDATE.md)). The command installs frozen
lockfile dependencies, runs lint/type checks/all tests/builds, synchronizes
Capacitor, runs browser and real-codec checks, and builds available unsigned native
artifacts. It creates disposable simulators/emulators for available-platform
launch/relaunch screenshots and cleans up only its own processes/devices.

The report records technical failures, unavailable tooling, and required
team configuration separately. It inventories packaged iOS privacy/permission
manifests and checks that the archive is unsigned. Source changes during a run
fail provenance rather than being treated as a tested candidate.

Implementation-based
permissions, network destinations, retention, and deletion behavior are in
[DATA_FLOWS.md](DATA_FLOWS.md). A report with a failed technical check requires
follow-up. Missing Android tooling is explicitly unavailable, never a pass.

External signing, configured account/billing services, physical-device
certification, user/market validation, and store submission remain later
milestones. They are reported explicitly and are not required user testing for
these agent-verifiable development goals.
