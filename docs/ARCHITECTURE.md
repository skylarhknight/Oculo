# Architecture

This document describes implemented source boundaries.

## Principles

1. Oculo owns product concepts; vendors provide capabilities.
2. Dependencies point inward: infrastructure and UI depend on application/domain contracts.
3. Domain data is serializable, provider-neutral, and testable without a browser or native runtime.
4. Projects are local-first. Network features are explicit and recoverable.
5. The native app is a Capacitor shell around a TypeScript web application, with native plugins isolated behind ports.

## Repository layout

```text
.
├── apps/
│   ├── account-functions/       # server-only Firebase Auth → RevenueCat cleanup
│   └── mobile/
│       ├── src/
│       │   ├── app/             # composition root context (AppServices) and creation flows
│       │   ├── navigation/      # typed route stack, transitions, leave guards, swipe-back
│       │   ├── screens/         # gallery, project, settings, scene workspace stages
│       │   ├── theme/           # design tokens (tokens.css) and motion helpers
│       │   ├── ui/              # shared sheets, controls, long-press
│       │   ├── components/      # viewer, sheet review, account UI, dialog styles
│       │   ├── config/          # isolated demo scene descriptors
│       │   ├── services/        # save queues, sheets, sharing, purchase/auth ports
│       │   ├── store/           # local project persistence, cloud repository, sync layer
│       │   └── types/           # app-local project model
│       ├── public/scenes/       # licensed offline starter and attribution
│       ├── ios/                 # generated/maintained Capacitor iOS project
│       ├── android/             # generated/maintained Capacitor Android project
│       └── capacitor.config.ts
├── packages/
│   ├── scene-schema/            # versioned provider-neutral persisted schemas
│   ├── camera-core/             # camera math and path interpolation
│   └── scene-core/              # imperative Three.js + Spark scene engine
└── docs/
```

## Boundaries

### Schemas and camera domain

`scene-schema` owns `SceneDescriptor`, `CameraPose`, `CinematicCamera`, `SavedShot`, and `CameraPath`. It contains no React, provider SDK, storage, or native imports. `camera-core` owns sensor presets, projection math, and the replaceable `CameraPathInterpolator`.

`SceneDescriptor.attribution` is optional additive metadata containing credit,
source URL, license, and license URL. Small Garden supplies it; the catalog and
sheet model carry the credit forward. Scene positions remain scene units unless
calibrated. The product does not present unsupported focus/aperture simulation
or claim that uncalibrated Y coordinates are metric camera height.

Camera/domain envelopes and project records now use version 2. Reading version
0/1 cameras migrates their output aspect from the stored sensor width/height;
sensor geometry, shot metadata, and path keyframes are retained. Subsequent writes
persist the migrated record without resetting IndexedDB. Existing thumbnail
images are retained; older images may reflect the previous viewport framing.
`output.aspectRatio` is
independent of sensor dimensions: `getCameraFraming` computes the largest centered
sensor crop and its vertical field of view. The renderer keeps that projection
through viewport changes. `fitOutputFrame` fits the preview canvas and guides
inside the available display area; `captureShot` synchronously returns live camera
state and the matching image at that aspect. UI camera notifications are never
fed back into the renderer as navigation commands.

A shot owns its movement (project schema 4). `ShotSetup` holds what stays fixed
while rolling: a `ShotLens` (a prime with one focal length, or a zoom with a range),
sensor, output aspect, near and far. Each `ShotKeyframe` holds what an operator
changes while rolling: pose (dutch angle lives in the quaternion), focal length,
focus distance in scene units, and aperture as an f-number, plus the speed curve
of the segment it starts. A shot with one keyframe is static; the schema requires
the first keyframe at 0, increasing times, the last keyframe within the shot's
length, and every focal length inside the lens.

`camera-core/shot.ts` edits shots immutably: `appendKeyframe`, `setKeyframeAt`
(replace at an existing time, otherwise insert and drop the split segment's curve),
`updateKeyframe`, `removeKeyframe`, `setKeyframeTime`, `retimeShot` (proportional),
`setSegmentSpeed` and `setShotLens` (clamps keyframes). `shotCameraAt` samples a
shot through the existing path interpolator, keeps the gate fixed, clamps zoom to
the lens, eases focus in diopters and aperture in stops, and holds after the last
keyframe. `lens.ts` adds lens labels, aperture stops and dutch-angle helpers.
Playback, scrubbing, the plan overlay and video export all sample `shotCameraAt`.

`camera-core` detects two-shot orbits when both saved camera viewing rays meet
at a shared point in front of the cameras. It keeps that point framed as camera
orientation and subject distance interpolate, avoiding a straight chord that
moves closer to the subject halfway through an orbit. Parallel (including exactly
opposing), nearly parallel, divergent, and skew viewing rays cannot establish a
unique shared subject and retain straight position interpolation. Paths with
intermediate waypoints retain their Catmull–Rom curve. Saved endpoints and optics
are unchanged.

Each camera keyframe may carry a version-1 `speedCurve` describing its outgoing
segment. Points store normalized time, nonnegative relative speed, and curve
intensity. `scene-schema` validates point bounds/order, exact time endpoints, and
a positive speed somewhere in the curve. This optional nested extension retains
project/envelope version 2 and needs no IndexedDB migration. Old projects without
curves keep their existing timing; unsupported curve versions are rejected.

`camera-core` interpolates the speed graph with bounded cubic Hermite segments and
integrates their area analytically. Normalizing by the total area maps elapsed
segment time to interpolation progress without changing waypoint arrival times.
That progress drives position, rotation, and optics together. Curve intensity
varies each point's tangent from a straight speed ramp to a flat tangent; it does
not change the spatial path. Relative speed concerns interpolation progress, not
calibrated scene-units per second. Speed curves can contain holds but cannot be
zero for the entire segment.

`SpeedCurveEditor` owns graph selection and pointer/keyboard editing on a shot
viewed as a path (`shotAsPath`); the workspace writes the curves back onto the
shot's keyframes through `ProjectSaveCoordinator` and resamples the playhead. Continuous edits use the existing debounced save path.
Retiming preserves normalized curves; inserting/removing camera waypoints resets
only the affected outgoing curves. Cloud validation retains the nested data.
Older app builds reject curve-bearing paths rather than overwriting them.

`CameraEditHistory` retains at most 100 immutable before/after pairs of the live
camera, the shot being edited, and the playhead per editor session. Pointer, numeric, and held-key gestures coalesce into
one entry. Restore writes through the same save coordinator; playback and live
navigation do not add history entries. Saved shot images and unrelated settings
are not copied into camera history. Updating a keyframe preserves its time and
outgoing curve.

Navigation is first-person. `scene-core/navigation.ts` `FlyController` replaces
OrbitControls: stick input (walk and strafe level with the ground, crane, pan and
tilt rates) is integrated each frame in `renderFrame` for at most 100 ms per frame,
with a quadratic response for fine adjustment; a one-finger drag looks and a pinch
dollies along the view; the keyboard works while the canvas has focus. Yaw and
pitch are applied in YXZ order so a dutch angle survives navigation, and pitch is
clamped to ±85°. The engine disables navigation during playback, handheld mode and
frame capture, and the app pauses it (`setNavigationEnabled`) while sheets or
focus picking own the view. Walking speed scales with the loaded splat bounds,
since imported scenes rarely know their physical scale. `pickFocusDistance`
ray-casts the active `SplatMesh` and returns the distance along the view axis.
React draws the thumb sticks and nudge buttons and only calls
`engine.navigation.setInput`.

### Adapters/infrastructure

Adapters translate external capabilities into Oculo contracts:

- `BundledSceneSource` and `UrlSceneSource` supply scene descriptors today.
- A future `WorldLabsSceneSource` will translate World Labs APIs.
- `scene-core` integrates Spark as the renderer without exposing Spark types to product state.
- `scene-core` defines the `CameraPoseSource` port (6DoF device poses plus
  tracking quality) for Magic Window navigation. The iOS implementation is a
  local Capacitor plugin (`ArPose`, `apps/mobile/ios/App/App/ArPosePlugin.swift`)
  that runs ARKit world tracking strictly as a pose sensor; the web adapter in
  `apps/mobile/src/services/DevicePoseService.ts` keeps all Capacitor and
  plugin event types out of domain and UI code. The engine composes device
  pose deltas onto the virtual camera (`composeHandheldPose`), so no platform
  coordinate conventions leak past `scene-core`.
- Playback explicitly owns the scene camera while running; disabled orbit
  controls alone never authorize device poses. Pause, completion, departure and
  backgrounding release ownership at the last displayed camera. Handheld mode
  must be started again after playback/backgrounding. Uncertain tracking holds
  the frame and the first recovered pose establishes a fresh baseline. Native
  orientation changes use the same recovery boundary. The pose adapter serializes
  native ownership across viewer instances, cancels pending starts and invalidates
  stale callbacks; the native plugin checks session identity on its main queue.
  Tracking remains a pose sensor: these changes add no image capture or upload.
- IndexedDB implements project persistence and a separate durable local-image
  store, with transactional revision and ownership metadata.
- `SharingService` owns prepared-file delivery. Capacitor Share and Filesystem
  implement native ports; browser ports provide file sharing or per-page
  downloads. Native filesystem URIs never enter project/domain records.
- `PurchaseService` maps RevenueCat entitlement, availability, billing metadata,
  cancellation, errors, and account identity into app-owned values.
- `apps/account-functions` is a separate Node 22 server package. A trusted
  Firebase Auth deletion event requests RevenueCat cleanup with a Secret Manager
  key. No server secret or Firebase Functions dependency enters the mobile bundle.
  HTTP acceptance is distinct from provider erasure; deployment, retries,
  monitoring, and reconciliation are documented in its README and remain
  configured-release gates.
- Firebase Authentication implements the `AuthService` port
  (`apps/mobile/src/services/AuthService.ts`). The web adapter uses the
  Firebase JS SDK; the native adapter performs sign-in through
  `@capacitor-firebase/authentication` and bridges the credential into the same
  JS SDK auth state. Oculo owns `AuthUser`, `AuthState`, and `AuthError`
  codes; Firebase auth types never leave the adapter.
- Firestore implements the `CloudProjectRepository` port
  (`apps/mobile/src/store/CloudProjectRepository.ts`) at
  `users/{uid}/projects/{projectId}`. Documents are the versioned `Project`
  payload, validated with the same schemas as local persistence. Firestore
  types and error codes are mapped at the boundary.
- `SyncedProjectStore` (`apps/mobile/src/store/SyncedProjectStore.ts`) wraps
  the IndexedDB store behind the same `ProjectStore` port. A local transaction
  completes before cloud propagation is queued. Dirty flags, revisions,
  tombstones, durable account ownership, and session guards protect concurrent
  edits. Local storage failures remain visible; network operations do not block
  the local write queue. Newer cloud conflicts require explicit recovery.

Each adapter owns external types and maps them at its public boundary. External types must not leak into application state, domain entities, component props, persisted records, or cross-package exports.

### UI

React renders application state and sends user intent to the imperative `SceneEngine`. It mounts one canvas and subscribes to throttled camera events; React never drives animation-frame rendering.

Navigation is a typed stack (`navigation/routes.ts`, a pure reducer in
`navigation/stack.ts`) rather than a router library: gallery, settings, project,
scene (with its `shots | compose | export` stage, optionally opening a shot), and
shot plan. One
orchestrated push/pop transition runs from design tokens; iOS-style edge swipe
pops non-viewport screens. The screen below the top one stays mounted (scroll and
state survive) unless it owns a renderer, so at most one `SceneEngine` is alive.
The scene gallery (`scenes`) is also a
renderer-owning route: `ScenePreview` keeps one figure-free `SceneEngine` for the
screen, loads each chosen scene in place, and calls `showPreview()` (the map view's
isometric orbit with a turntable spin, `MapView.setAutoRotate`). The engine is
disposed when the gallery is replaced by the new scene, so two engines never
coexist. Figure-free views (this preview and the Shots overview) frame the scene's
core, meaning the per-axis percentiles of sampled splat centres. A background sky
shell or stray floaters would otherwise stretch the framing past the subject.
While any map view is open the engine also cuts the scene away: `cutaway.ts` (pure,
no three.js) estimates a box from sampled centres (the densest voxel cells, and a
ceiling layer that spans the footprint), and `SceneEngine` adds one global Spark
`SplatEdit` holding an inverted box SDF, so splats outside the box fade to nothing.
The edit animates with the fly-in, is removed when the map closes or the scene
changes, and map raycasts ignore hits outside the box. `setMapCutaway("off")` shows
the whole scene. The mannequin map frames the cutaway core when there is one. A screen can register a leave guard; the scene workspace uses it to stop playback
and flush its save queue before Back or a covering route, and stays put on failure.
Every modal renders as a bottom sheet built on `ModalDialog`, keeping its focus
trap and inert background.

`AppServicesProvider` is the composition root: it creates the stores, auth,
purchases, and preferences once and exposes them through context. Screens edit one
scene at a time through a `SceneWorkspace` view (below) and never touch IndexedDB.

`SceneEngine.setPlanOverlay` draws each shot's first keyframe as a frustum and the
path of the moving shot being edited as a line. The engine hides the overlay for `captureShot` and every video frame, so it
never appears in thumbnails or exports. `pickShotMarker` does screen-space picking
for tap-to-teleport. Overlay colors are read from design tokens by the app.

The map view (`scene-core/src/mapView.ts`) renders through its own camera, so the
rig camera the user composes is untouched until a teleport, which sets it once and
emits one camera change. `MapView` owns the orbit (azimuth, isometric elevation,
fitted distance), gestures, and "crane" tweens that arc along a lifted Bézier while
aiming at a gliding focus point. The app passes the output frame's share of the
full-bleed canvas so the map starts and ends with a matched field of view and the
hand-off to the letterboxed rig is seamless. While a flight is in progress Spark's
LOD driving is paused (its re-mapping never settles during fast moves). The
cinematographer (`mannequin.ts`) is a glTF authored by
`tools/blender/cinematographer.py` with named joint nodes, loaded lazily through a
dynamic `GLTFLoader` import; a procedural figure with the same nodes is the fallback
and the test double. All of its motion is springs (`motion.ts`), not baked clips.
Captures refuse to run while the map is open.

The Shots tab reuses the map session without the figure
(`enterMapView({ figure: false })`): the orbit is fitted to the scene and every shot
camera (`encloseBounds`), shot frustums are drawn at a share of the scene radius,
and `projectShotMarkers()` reports each marker's viewport position through the
camera being displayed so `ShotsOverview.tsx` can place numbered pins every frame.
The workspace opens and closes the overview one transition at a time as the tab
changes; opening a shot while it is up flies from the overview into that shot.

`SceneEngine.captureStillsAt` renders stills at given poses through the exclusive
frame capture and then restores the live camera. When a scene opens, the workspace
uses it to render images for shots that have none (the tutorial's, or images lost
from storage), saves them without changing `updatedAt`, and blocks Save shot, move
playback, and video export until it finishes. On failure the placeholders stay and
the next open retries.

Compose (`screens/scene/SceneWorkspaceView.tsx` with `ComposePanel.tsx`) keeps one
control for each job. The overlay `SceneProgress` bar is the only scrubber and Play.
The capture bar's shutter creates a shot straight from the rig (the free camera's
focal length as a prime, its sensor and aspect) or adds a keyframe to the open
shot. The panel shows one of Lens, Move or Notes at a time; lens-model changes live
in a Lens setup sheet, and Notes edits the shot through the same undo-free project
update the Shots tab's edit sheet uses.

All spacing, color, radius, type, and motion values come from
`theme/tokens.css`; `theme/tokens.test.ts` fails on raw values in any stylesheet
and checks that every appearance-dependent color has a light value. The tokens
follow Apple's Human Interface Guidelines: the system font stack (no bundled
fonts), system colors and semantic label/fill/separator colors, materials
(translucent backgrounds under a saturating blur), Dynamic Type sizes, and spring
curves expressed with CSS `linear()` (cubic-bezier fallbacks). Dark values are the
default and light values apply to `:root[data-theme="light"]`. `theme/appearance.ts`
resolves the Appearance preference (System, Light or Dark; System follows
`prefers-color-scheme` live) to `data-theme`, and an inline script in `index.html`
applies the last choice before first paint. Any element
marked `data-appearance="dark"` (the scene workspace) redeclares the dark palette
so its subtree stays dark. Display type (`--font-display`, `--text-display-*`),
capsule buttons (`--radius-button`) and reveal timing (`--dur-reveal`,
`--ease-reveal`) give the apple.com look; `ui/useReveal.ts` reveals content as it
scrolls in (hiding it only while an observer watches it) and `ui/flip.ts` flies a
copy of an element between two places. Reduce Motion zeroes these durations and
skips both helpers. `NavigationStack` reports the top route so
`services/statusBar.ts` (Capacitor Status Bar, no-op on the web) can switch to
light status-bar content over the dark workspace. While a sheet is open the
screen behind recedes (scale and corner radius), except over the workspace so its
canvas never scales. Reduced motion zeroes every duration token.

The library can open `ShotSheetWorkspace` without constructing `SceneEngine`.
The workspace edits saved metadata, order, and selection; replacing a missing
frame opens the scene workspace with that shot, where the thumbnail backfill
renders it again.

### Composition root

`apps/mobile` chooses concrete scene, persistence, purchase, and auth adapters.
Without Firebase web configuration it selects plain IndexedDB and unavailable
auth. Capacitor's per-platform `includePlugins` excludes Firebase Authentication
when the corresponding native plist/JSON file is absent, because the plugin
otherwise configures Firebase during startup. The JS auth factory also reports
unavailable on a native build missing that plugin. Changes to these files require
another Capacitor sync/build; source guards do not prove successful device launch.

## Core data flow

```text
User input
  -> feature/controller
  -> application use case
  -> domain operation
  -> provider or repository port
  -> selected adapter
  -> Oculo result
  -> UI state
```

Provider callbacks follow the reverse path through their adapter; they never mutate UI state directly.

## Local persistence with IndexedDB

IndexedDB is the MVP persistence mechanism because the project data is structured, can exceed safe `localStorage` limits, benefits from indexes and transactions, and must survive app restarts while working offline. It is available inside the Capacitor WebView without requiring a backend or silently transferring customer data.

Store only Oculo-owned, structured records:

- projects and schema version
- references to worlds, not opaque provider SDK objects
- shots containing their fixed setup and their keyframes (pose, zoom, focus, aperture, timing)
- one or more scenes per project (project schema 4), each with its own shots
- optional `shotSheet: { version: 1, excludedShotIds: string[] }` at project level;
  order follows each scene's `shots`, and deleting a shot or scene removes its exclusion
- device preferences and camera presets (never synced)
- downloaded scene-gallery files (`galleryAssets`, keyed by asset version and
  verified against the pinned SHA-256; a cache that never syncs and that removing
  never touches a project)
- local reference images and per-project revision/ownership metadata

Large provider assets should remain provider-managed or be represented by explicit local file references. Do not place secrets in IndexedDB.

The persistence adapter must:

- expose a repository interface rather than raw database handles;
- use versioned, additive migrations;
- perform related writes in one transaction;
- validate/deserialise records at the boundary;
- reject unsupported/newer records without erasing them or treating them as deletions;
- report quota, corruption, and migration failures visibly;
- avoid destructive recovery as the default; sheet export is not a complete
  project/scene backup format.

IndexedDB version 3 adds `shotImages` without replacing existing `projects` or
`syncMeta` stores. Legacy embedded images migrate during reads/writes; outward
project reads retain `thumbnailDataUrl` for UI consumers. Images are associated
with project ID, shot ID, and an exact scene/camera signature. Metadata-only
remote replacements retain matching local frames; changed cameras/scenes never
reuse an old frame. Intentional deletion and replacement clean unreferenced media
in the same transaction. Database version and domain version are separate concerns.

Project schema 3 (`Project.scenes[]`) supersedes version 2. A stored v2 record is
migrated on read into one scene with the deterministic ID `scene-<projectId>`, so
routes stay stable before the first write; it is rewritten as v3 on the next save.
Shot IDs are unique across the whole project, which keeps image keys and export
selection unambiguous. Image signatures are unchanged, so existing frames survive
the migration. Older app builds reject v3 cloud records as "requires a newer app
version" and keep local work; nothing is overwritten.

Project schema 4 moves movement into shots. A v3 (or older) record migrates on
read: each saved still becomes a static shot on a prime at its focal length, with
focus 3 and f/2.8 as defaults, and a scene path with two or more keyframes becomes
one moving shot with the deterministic ID `move-<pathId>`, starting at 0 and
keeping its keyframe timing and speed curves. The first keyframe keeps the still's
exact camera, so existing image signatures still match. Older app builds reject v4
records the same way. The legacy `SavedShot` and `CameraPath` shapes remain only to
read old records and envelopes; new code uses `Shot`.

`SceneWorkspace` is the editing view of one scene (the former single-scene project
shape plus `projectSceneId`/`projectSceneName`). `sceneWorkspace()` reads it and
`applySceneWorkspace()` writes it back without touching other scenes or their
export choices. `WorkspaceStore` persists a workspace by reading the project,
applying the workspace, and saving it through the normal project store.

IndexedDB version 6 adds `preferences` (one versioned record) and `cameraPresets`
stores, again additively. The tutorial project carries `tutorial: true` and is not
counted by the saved-project limit; duplicating it produces an ordinary project.

IndexedDB version 7 adds the `galleryAssets` store for downloaded gallery scenes,
also additively.

Sync captures local revisions before network reads and uses conditional
transactions to apply remote records or acknowledge pushes. A racing local edit
cannot be replaced or marked clean by an older response; an account change
invalidates pending work. Entire cloud lists are validated before deletions are
considered. A newer cloud record conflicting with dirty local work is retained
remotely and reported; **Keep both projects** atomically makes a local copy before
accepting the cloud original, then backs up the copy under explicit consent.

Signing in resumes already-owned project sync. Existing unowned projects require
selection and a backup action; legacy unknown ownership is disclosed, and known
other-account projects are excluded. New projects created while signed in are
linked automatically as disclosed by the account UI. Sign-out retains ownership,
dirty work, tombstones, and images. Failed sign-out rebinds the still-current
account. See [FIREBASE.md](FIREBASE.md) for deletion and cloud-size behavior.

`ProjectSaveCoordinator` (generic over the saved value) owns the workspace's serialized write queue. It copies each
snapshot, coalesces navigation edits with a 350 ms debounce and 1 second maximum
wait, and drains newer edits before reporting saved. Shot/path actions, manual
save, and Back flush the queue immediately; Back waits for success. Errors retain
the latest in-memory snapshot and expose retry. IndexedDB project writes request
strict durability and await transaction completion. “Saved on device” describes
local persistence, independently of cloud sync. Visibility/page-exit handlers
attempt to flush the latest live pose, but cannot make asynchronous writes finish
after the operating system has terminated the process.

## Local scene assets and preview video

`sceneImport` streams bounded SPZ v2/v3 gzip validation, verifies the complete
payload, computes framing bounds, and maps orientation to a scene quaternion.
`SceneDescriptor.localAsset` is a nested version-1 reference; persisted URLs use
an asset locator plus `localAsset` media key, never temporary Blob URLs. IndexedDB version 4 originally added
`sceneAssets` without replacing version-3 data. `putImportedProject` commits the
project and bytes atomically. Duplicate/delete and remote scene replacement
maintain references and garbage-collect only the final unused asset.

The composition root supplies a stable `resolveScene` function to the scene
workspace. It resolves a stored Blob to a temporary URL, and the viewer
releases that URL on failure or teardown. SceneEngine fetches bytes abortably,
constructs a candidate Spark mesh, and activates it only after successful decode;
failed replacement preserves the old scene. Late completion of a canceled load
is disposed and cannot reactivate it. Hidden viewers suspend rendering and device
tracking; visibility recovery preserves camera state.

`services/videoExport` separates frame timing, an encoder-session port, and the
WebCodecs/Mediabunny H.264 MP4 adapter. `SceneEngine.beginFrameCapture` owns the
renderer while it steps saved cameras, waits for Spark sorting, and restores
camera, dimensions, pixel ratio, and sorting/LOD settings. It uses Spark's public
rendering APIs rather than implementing a splat renderer. The application maps
camera domain values to camera-state frames; output is limited to short 720p
previews. The last frame samples the final camera at the saved duration while
its PTS remains on the fixed frame schedule. All other frames sample at their PTS.

The video dialog cancels on background/unmount and prepares delivery through the
same SharingService as sheets. While capture owns the renderer, App background
saving flushes the last editor snapshot rather than a temporary exported frame.
Imported scene assets are never sent through Firebase or file sharing. Imported
projects remain unowned/local and cannot be selected for backup.

## Shot-sheet generation and delivery

`services/shotSheet` creates an immutable provider-independent model exclusively
from saved shots. It validates cameras/selections/images, derives labels without
inventing focus, aperture, metric distances, or per-shot duration, and propagates
scene attribution. Layout contains mixed-aspect images and paginates full notes.
PNG generation produces 1440 × 2036 pages, bounded to 100 selected shots, 40 pages,
32 MiB source-image representation, and 64 MiB output. Missing/corrupt images or
limit failures never return a partial successful document.

The real workspace awaits its save coordinator before generation. It previews
the resulting Blob bytes, cancels stale work on edits, and exposes generation
and preparation progress, cancellation, retry, and actionable errors. Current
captures and recaptures have a maximum edge of 480 pixels: large page dimensions
do not imply high-resolution source frames. PDF export remains deferred; camera-move MP4 previews use the separate video-export service below.

Each generated page also carries an immutable text equivalent assembled from the
same ordered text elements painted into its canvas. The preview's **Read text for
page N** disclosure presents that page's names, notes, continuation markers,
camera metadata and credits as selectable text for screen readers. It follows
the same page snapshot and cancellation/invalidation lifecycle without decoding
another image or changing PNG bytes. Tests compare the text with actual canvas
`fillText` calls; native VoiceOver and supported-device glyph checks remain gates.

`SharingService.prepare` validates PNG or MP4 artifacts, creates files, and checks
delivery capabilities before the explicit Share click. Browser sharing starts
directly within that click's activation; unsupported file sharing falls back to
one download per page. Native preparation writes only temporary app cache files;
Share passes their URIs to the OS. Cancellation is distinct from failure, and a
handoff result does not prove recipient receipt.

After a native handoff attempt, files are retained for 24 hours from the latest
attempt so recipients can read them. Expired inactive batches are cleaned on
later preparation; this is not a guaranteed deletion timer and OS cache eviction
can still occur. Unshared disposed batches are removed. The cache has a 256 MiB
budget and reports capacity errors instead of deleting recent recipient files.
Browser downloads release object URLs after a 60-second grace period; preview
URLs are released on page change/unmount. Recipient apps control their own copies.

## Native and entitlement boundary

The app asks an entitlement port whether `oculo_pro` is active. The native
adapter selects exactly the configured offering ID, package ID, and platform
product ID; missing/ambiguous/unsupported offers disable purchases. Only non-consumable products are purchasable. The localized one-time price feeds the paywall; team privacy/terms
links gate real purchases. Account changes serialize RevenueCat identity work;
refresh retries initialization and runs on foreground/focus. Existing entitlement
lookup/restoration can work even when no new offer is configured. Customer-info
types stay inside the adapter.

Browser production builds report purchases unavailable. Only a development build
with `VITE_REVENUECAT_MOCK=true` selects the labeled no-charge mock. Actual store
products, final app identifiers, sandbox purchase/restore tests, and native
runtime evidence remain release requirements.

Mapping configuration uses `VITE_REVENUECAT_OFFERING_ID`,
`VITE_REVENUECAT_PRO_PACKAGE_ID`, and the platform's
`VITE_REVENUECAT_IOS_PRO_PRODUCT_ID` or
`VITE_REVENUECAT_ANDROID_PRO_PRODUCT_ID`, alongside its public SDK key. The
adapter never purchases the first returned package as a fallback. Team
links use `VITE_PRIVACY_POLICY_URL`, `VITE_TERMS_URL`, and `VITE_SUPPORT_URL`.

The placeholder application ID is `org.example.oculo.student`. Capacitor's `appId`, the iOS bundle identifier, Android `applicationId`, store app records, and RevenueCat app records must match the final identifier.

## Privacy and trust

Saving is local by default. Authorized Firebase backup sends project metadata and
available reference images under the selected user's UID; it never uploads scene
assets. Larger project documents omit images, so new devices may have metadata
without frames. Cloud serialization whitelists fields and blocks device-local
asset paths, with an exception for known bundled starter references. Ownership
and media-store keys stay local.

Sheet generation and file preparation are local. Sharing sends generated PNGs or MP4 previews
only through an explicit user-selected destination; it does not publish or back
up the original scene. No additional scene upload, provider generation, or
telemetry transfer is authorized by sign-in or sharing. Future transfers need
their own destination, consent, progress, and failure behavior.

Oculo will not implement a custom replacement for World Labs Spark. The world boundary exists to integrate supported provider capabilities while keeping product behavior independent of a particular SDK.

## Testing seams

- Unit-test domain rules with plain objects.
- Test application use cases against in-memory ports.
- Contract-test every world adapter against the same provider suite.
- Test IndexedDB migrations and transactions with an IndexedDB-compatible test runtime.
- Test full app transitions with fake provider ports and real editor, sheet,
  model, account UI, and save coordinator; test canvas output and delivery ports
  separately. These tests do not substitute for native recipient/device checks.
- Keep a small native smoke suite for launch, persistence after restart, share, and `oculo_pro` restoration.

## Combined asset contracts and storage migration

The canonical persisted contracts live in `packages/scene-schema/src/contracts.ts`.
Within each project scene, the scene descriptor, shots, and path bind to the same
scene ID and immutable asset-version ID. Scenes record canonical coordinates, an asset-to-scene transform, provenance,
and an explicit known/unknown metric scale. Cameras persist `output.aspectRatio`
and the centered crop policy. New imports and the bundled starter have SHA-256
fingerprints; original imported bytes are verified before storage and rendering.
Legacy identities and missing fingerprints remain explicitly unverified.

Both historical branches used project schema 2. The reader distinguishes the
asset-contract shape by its asset-version reference and explicitly migrates the
older URL-based shape, including local asset references, speed curves, output
crops, attribution, and shot-sheet selection. Version 0/1 records remain readable.

IndexedDB version 5 creates any missing `sceneBindings`, `shotImages`, and
`sceneAssets` stores by name, preserving either historical version-3 layout and
the feature branch's version-4 layout. Binding checks, project saves, image saves,
and sync revision updates share a transaction. Legacy separately stored images
are recovered only through their exact original scene/camera signature. Changes
to an established scene's geometry or calibration require a new scene (a project
may now hold several).

The portable shot-plan JSON schema (`OculoShotPlan`, one scene per file) omits
local asset keys, locators, and thumbnails. The Export stage shares it as "camera data".
Imported projects remain local; cloud writes validate immutable bindings and
retain revision/conflict protections. Product scope remains defined in MVP.md.

## Version 1.0 capacity

See [PRD](PRD.md) and [purchase definition](PURCHASE_DEFINITION.md). The composition root supplies a live project-capacity policy to IndexedDBProjectStore. New local owned writes check existence and count within the same readwrite transaction as the project/asset commit. Free capacity is one; Pro has no product-imposed limit. Updates to existing projects are always allowed. Imports roll back their bytes if capacity is exceeded; duplicates share existing immutable assets. Sync/recovery preserves pre-existing user work. Moving shots are free for all users, with the same 25-keyframe technical limit per shot.
