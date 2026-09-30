# Oculo implementation backlog

Current scope authority: [Version 1.0 PRD](PRD.md), [MVP checklist](MVP.md), and [implementation alignment](PRD_ALIGNMENT.md). Older backlog descriptions below are historical where they call local SPZ import or MP4 previews future work; both are now implemented with physical-iPhone acceptance outstanding.


Updated: 2026-09-10. Based on the product evaluation and current source inspection.
Physical-device acceptance is still open. The last complete automated checkpoint
passed 381 tests in 29 files and full lint/typecheck/build/Capacitor sync after
the keyboard viewport fix, saved-tray image fix, library, preview, accessibility,
font, account-deletion and camera-ownership changes. Both latest native debug
builds, unsigned iOS Release archive/Android AAB, and updated simulator saved-sheet
reopen/regeneration/readable-zoom checks pass. No physical phone is connected for
the remaining iPhone/Android matrix (`xctrace`: Mac only; Android emulator only).
See [SHOT_SHEET_PLAN.md](SHOT_SHEET_PLAN.md) for the active five-step completion gate.

Additional source work includes bundled OFL fonts, accessible guarded dialogs,
16px phone modal fields, four visible aspect choices, purchase detachment during
account deletion, and a tested server-only RevenueCat cleanup trigger. The worker
is not deployed or provider-verified. The iOS simulator also delivered four pages
with mixed aspects and long-note continuation; every received PNG was visually
inspected and byte-verified after preview closure. Android emulator startup passes;
its full UI workflow remains unverified.
The current preview also supplies each PNG page's exact painted text as a
selectable disclosure; native opening/page switching and automated coverage pass.
Backend checks pass on Node 22.23.2. Native manifest inspection found no additional
sensitive permission/tracking blocker in the unconfigured-account build, and
confirmed iPhone+iPad support: iPad QA/screenshots are part of release acceptance.
The preceding 348-test build passes a one-shot iPad Pro/iPadOS 18.6 simulator workflow:
capture/edit/generate, native Save to Files with exact received-byte verification,
and force-terminate/library reopen/regeneration. The subsequent 377-test build also
shows retained iPad tray images and restores 35/52 mm shots correctly; an 8-second
lens move passes inspected playback/pause/scrub/end checks. The current 381-test
iPhone 16 Pro Max/iOS 26.3.1 retest keeps sheet header/title/notes/Preview accessible
with the hardware-keyboard accessory and software keyboard, preserves list position
on dismissal, and passes Arrow Down scrolling/readable page text. A fresh two-shot
sheet with an 8-second move regenerates after install-over and opens in Files after
preview closure: 941,628 bytes, 1440 × 2036; the full receipt is in the shot-sheet plan.
The current iPad Pro 13-inch (M4, 8 GB)/iPadOS 18.6 retest also passes install-over,
direct two-shot sheet reopen, lower-notes visibility with accessory/software
keyboards, dismissal and regeneration with full notes, exact page text and the
8-second move summary. This iPad retest does not repeat the Files handoff.
Physical tablet acceptance, Android screenshots
and final configured-release approval remain open; these results do not close the
physical phone workflow matrix.

## Product outcome

Help independent directors and small creative teams turn a location into a
repeatable camera idea they can share or use in another filmmaking tool.

First-release promise: **Explore a location, compose your shots, and share a visual
shot plan using your phone as a virtual cinema camera.**

Preserve the existing core loop:

**Open scene → navigate → configure cinematic camera → save shot → create camera path → replay → persist project**

Import is a later proposed way to open a scene. A shot sheet is an optional branch after
one saved shot; it does not require creating or replaying a camera move.
Accounts, payment, scanning, and generation must not become mandatory steps in
the first successful experience.

## How to use this backlog

- **P0:** correctness and trust; complete before relying on the output.
- **P1:** finish the useful first-release workflow.
- **P2:** paid-release readiness and validation; start operational work early.
- **P3:** improvements after the first useful workflow is validated.
- **Current:** completes or fixes behavior already covered by the MVP.
- **Proposed:** extends the current MVP and needs to be reflected in the scope
  documents when that implementation work is taken on.

This file records implemented progress and remaining work without replacing
[MVP.md](MVP.md). Task dependencies refer to the IDs below. A task stays open if
its acceptance includes missing physical/runtime evidence, even when its source
implementation is finished. Later proposals are not prerequisites for completing
the current one-shot PNG workflow.

## Existing foundation

These capabilities exist in source and should be extended rather than rebuilt:

- Spark/Three.js scene rendering, touch navigation, loading progress, and retry.
- Camera pose, focal length, sensor controls, saved shots, notes, thumbnails,
  path keyframes, and interpolated replay.
- iOS Magic Window pose tracking, permission handling, recenter, and a tracking
  quality indicator; uncertain-pose freezing, recovered-pose rebaselining and
  cancellation of pending startup are implemented with regression coverage.
- Local IndexedDB persistence and optional Firebase accounts/project sync.
- RevenueCat purchase/restore adapters and account-linked `oculo_pro` identity.
- Renderer performance sampling that can support device profiling.
- Free one-shot sheet review, persistent organization, immutable multipage PNGs,
  exact-byte preview, browser/native delivery, and saved-camera recapture.
- IndexedDB v3 durable media, revision/account guards, selected-project backup,
  keep-both conflict recovery, and visible failures/retry.
- A bundled CC BY 4.0 Small Garden starter, plus separately labeled online demos.
- Two-endpoint saved-shot moves free; Pro adds intermediate waypoints up to 24.

Remaining first-release gaps are native/runtime and physical received-file QA,
device compatibility/performance, configured services/purchases, and team
inputs. The previously reported UI recovery/account integration defects are fixed;
Share/Filesystem are linked in both native projects and native binaries have built.
The rebuilt iPhone 16/iOS 26.3.1 simulator launches without the Firebase crash,
renders Small Garden upright, and completes one-shot native sharing to Files.
The received PNG is visually verified and byte-identical to the generated file.
iOS minimum version 17 and SOG API preflight are implemented/tested; a main-thread
probe does not certify worker/GPU/decoder behavior on physical hardware. See the
[shot-sheet completion plan and status](SHOT_SHEET_PLAN.md#current-status-audit--2026-09-10).
Customer scene import, standalone high-resolution stills, PDF, and movie export
remain later proposals. Focus/aperture simulation is explicitly deferred in the
MVP; these are not missing requirements for the first digital-reference sheet.

## P0 — Correct camera behavior and durable work

- [x] **F01 — Align the release scope and product promises.** Current.
      MVP/architecture/provider/Firebase docs now distinguish implemented PNG
      reference sheets and Pro waypoints from deferred import, video, high-resolution
      stills, calibrated optics, world generation, and full editing. Unsupported
      paywall claims were removed; physical/store verification is tracked separately.
      **Done when:** documentation distinguishes shipped behavior from planned work,
      and every advertised paid benefit maps to a working capability.

- [ ] **F02 — Make composition and output framing agree.** Current.
      Define output aspect separately from sensor size, with an explicit crop/fit
      rule. Use the same projection and frame rectangle for the viewer, guides,
      saved thumbnails, stills, and subsequent video exports. Remove the hardcoded
      16:9 label. Preserve framing through viewport resize and device rotation.
      **Done when:** recognizable scene landmarks occupy matching positions in the
      preview and captured frame for supported aspects; changing lens or sensor has
      the intended field-of-view effect. Version and migrate changed camera data.
      **Progress (2026-09-09):** implemented independent output aspect, centered
      sensor crop, shared preview/guide bounds, aspect-correct capture and thumbnail
      display, stable projection on resize, and version 2 migration for cameras,
      shots, and paths. Math/capture/migration and additional framing regressions
      pass in the 377-test checkpoint. Saved-tray image elements now display
      retained frames correctly, with App hydration/restore coverage and iPad
      visual verification. Simulator keyboard panning is verified;
      physical panning checks remain open. Verify actual
      splat landmarks in preview versus thumbnail at 16:9, 4:3, 1:1, and 9:16 on
      device before and after rotation. Video export remains separate V02/V04 work.

- [ ] **F03 — Save a coherent shot immediately and report persistence state.** Current.
      Capture pose, lens settings, and thumbnail from the same camera state; avoid
      stale throttled UI poses during phone movement. Await durable writes for shot
      and move actions; show saving, saved, and failed/retry states. Handle backgrounding
      and navigation without relying solely on the current 350 ms debounce.
      **Done when:** an acknowledged save survives immediate force-quit/relaunch;
      write failures never display “Auto-saved” or silently discard work.
      **Progress (2026-09-09):** implemented atomic live-camera/image capture,
      serialized immutable saves, immediate shot/path writes, strict local
      transaction acknowledgment, saving/saved/error and retry UI, awaited Back
      navigation, and background/page-exit flush attempts. Automated tests cover
      stale UI poses, concurrent edits, failure/retry, and reading committed work
      from a reopened database. On device, save a shot and keyframe, wait for
      “Saved on device,” immediately force-quit, and verify both after relaunch;
      also test backgrounding during movement. These checks remain pending.

- [x] **F04 — Create moves directly from saved shots.** Current.
      Start/end selectors copy saved cameras into a move without depending on the
      live camera. Replacing a move preserves saved shots; later shot changes do
      not silently mutate copied keyframes. Mixed scenes/aspects are rejected.
      **Done when:** a user selects two saved shots, sets duration, and replays from
      the exact saved endpoints without restoring each shot and adding it again.
      **Evidence:** camera-move tests and App integration cover selected endpoints,
      lens/sensor metadata, duration shortening, and exact final camera state.
      Physical playback acceptance remains F05/R06.

- [ ] **F05 — Make replay and duration edits predictable.** Current.
      Validate finite positive duration and strictly ordered keyframe times. Define
      how changing duration retimes existing frames and keeps the final endpoint
      reachable. Prevent live tracking, touch navigation, scrubbing, and replay from
      driving the camera simultaneously; handle loading failures and app interruption.
      **Done when:** play/stop/replay, shortened durations, invalid inputs, and mode
      changes cannot cause jumps, unreachable endpoints, or invalid persisted paths.
      **Progress:** duration validation/full retiming, play/pause/scrub/replay,
      saved metadata restoration, and free/Pro waypoint gates are implemented.
      Tests cover duration shortening, retained moves after Pro loss, and
      legacy-duration/identity regressions. Playback now takes explicit engine
      ownership before its first frame; touch and device poses cannot compete.
      Pause/end/leave/unmount release ownership after preserving the camera;
      backgrounding pauses and saves without an automatic resume jump. Engine/App
      tests cover ownership, pending orbit motion, exact pause/end and backgrounding.
      Verify tracking/touch handoff and background interruption on the device.

- [ ] **F06 — Recover safely from tracking loss.** Current.
      Freeze the virtual camera when tracking is unavailable, explain recovery, and
      resume from a fresh baseline without a jump. Preserve touch fallback, explicit
      camera permission, recenter, and clean shutdown on exit/backgrounding.
      **Done when:** permission denial, temporary loss, recovery, and repeated mode
      changes work on a physical supported iPhone without losing saved work.
      **Progress:** all uncertain poses are ignored, the status explains the held
      frame, and recovery/recenter use the next good pose as a fresh baseline.
      Playback, exit, backgrounding and unmount stop tracking even during pending
      startup. Source instances serialize native ownership and clean partial
      listeners; native stop cancels pending permission/start calls. ARKit sends
      only finite, current-session, normally tracked poses and signals rotation
      before using the new orientation. Deterministic tests cover JS lifecycle,
      stale callbacks, failure/retry and rebaselining; physical ARKit tests remain.

- [x] **F07 — Make spatial units and optics claims accurate.** Current.
      The editor labels Y as uncalibrated scene units; sheets use supported saved
      lens/sensor/aspect metadata. Focus/aperture simulation is explicitly deferred
      in the MVP and is not implied by the reference export.
      **Done when:** the app never presents uncalibrated coordinates as measured
      meters or implies that absent controls affect the rendered image.

- [x] **F08 — Protect local projects across sync and account changes.** Current.
      Distinguish unavailable, invalid, or newer-schema cloud records from confirmed
      deletions so they cannot trigger deletion of good local copies. Preserve edits
      that race with sync and discard stale results after account changes. Require an
      informed adoption action or isolate ownership when switching accounts instead
      of uploading all retained local projects into the next account automatically.
      **Done when:** regression cases for invalid cloud records, offline edits,
      sign-out, account switching, and deletion preserve the intended local data and
      never transfer a previous account's work without an explicit user action.
      This gates any configured, signed-in beta as well as the paid release.
      **Progress:** implemented local revision/CAS and session guards, whole-list
      cloud validation, durable ownership/images, selected unowned/legacy backup,
      keep-both conflict recovery, and failed-sign-out rebind. Store/Account/App
      regressions cover these boundaries. Configured two-account and two-device
      release acceptance is tracked separately in R02, including omitted images
      on a fresh device.

## P1 — Complete a useful first release

- [ ] **V01 — Bundle a reliable starter scene.** Current.
      Select one licensed, small splat with a useful starting camera, attribution,
      stable orientation, and documented regions where camera movement looks good.
      Show accurate local/remote availability for every scene.
      **Done when:** a fresh installed build can open the starter scene and complete
      the core loop in airplane mode, without World Labs credentials.
      **Progress:** Small Garden by scbenoit is bundled as a 13,081,550-byte CC BY
      4.0 SOG, with attribution/source/license/modification provenance and starting
      pose. Catalog labels local/online availability. The rebuilt iOS simulator
      renders it upright and captures a shareable reference frame. iOS minimum
      version 17 and tested SOG API preflight are implemented. Fresh native
      airplane-mode entry and physical performance remain open; simulator library
      reopen/regeneration from retained images pass; the main-thread API probe does not prove worker/GPU support.

- [ ] **V02 — Prove native preview-video export feasibility.** Proposed.
      Later feature; not a prerequisite for V03 or the current shot-sheet release.
      Depends on F02/F05. Prototype the existing Spark renderer → frame capture →
      encoder → saved file path on a physical iPhone before building export UI.
      Target a 5–10 second, 1080p, 30 fps MP4 reference clip; measure memory,
      processing time, storage, and interruption behavior. Use a supported native
      adapter if WebView codecs cannot meet the requirement. Sample the saved path
      at deterministic times rather than tying output speed to preview frame rate.
      **Done when:** the file plays in Photos and an external editor, matches the
      saved framing/timing, and the supported devices/output limits are documented.
      This is a feasibility gate for V04, not a promise of production rendering.

- [ ] **V03 — Complete acceptance of the visual shot sheet.** Current.
      Depends on F02/F03. Deliver ordered PNG pages with saved reference images,
      names, complete notes, lens/sensor/aspect labels, attribution, and an optional
      valid-move summary. No move, import, or purchase is required. Standalone clean
      stills, higher-resolution recapture, PDF, and movie export are later features.
      **Done when:** a recipient can understand the camera idea without installing
      Oculo, and cancellation or failed sharing leaves the project intact.
      **Progress (2026-09-10):** the working tree includes editor/library entry,
      shot selection/order/title/notes, immutable saved-camera snapshots, multipage
      PNGs, exact-byte preview, native/browser delivery adapters, and missing-frame
      exclusion/recapture. The sheet works independently of a camera move. Its
      images come from captures with a maximum edge of 480 px. Slow-close races,
      stale exclusions after deletion, preview loss on preparation failure, and
      missing sequence numbers are fixed. Account consent/recovery is connected.
      DOM tests cover App, workspace, Account, and recapture; the checkpoint suite
      passed 381 tests in 29 files, plus lint/typecheck/build/Capacitor sync. Native
      debug builds succeeded with the latest assets. The
      earlier iPhone 16/iOS 26.3.1 simulator build completed one-shot
      native Share → Save to Files with visual and byte-verified PNG receipt:
      513,832 bytes, 1440 × 2036. The full hash and temporary artifact path are in
      [the received-file evidence](SHOT_SHEET_PLAN.md#received-file-evidence--ios-simulator).
      The current 381-test iPhone 16 Pro Max build also receives and opens a fresh
      two-shot/8-second-move sheet in Files after preview closure: 941,628 bytes,
      1440 × 2036. Its separate hash and build identity are recorded at the same link.
      iOS minimum version 17 and tested SOG API preflight are implemented; main-thread
      API availability does not prove worker/GPU/decoder behavior.

  **Remaining tasks, in order:**

  - [ ] Verify physical preview panning, VoiceOver, and Android runtime.
        The 381-test source checkpoint, latest native builds, and simulator
        retained-sheet reopen/regeneration, Enlarge/Fit, native Share cancellation,
        saved-scene SOG rendering, keyboard scrolling and software-keyboard editing
        pass within the documented limits. The iPhone 381 viewport retest passes
        header/title/notes/Preview access and dismissal scroll preservation; keyboard
        Next/Page Down remain uncertain, not a confirmed general regression.
        Native Unicode glyphs still need actual
        device verification; the simulator emoji picker itself shows placeholders.
  - [ ] On physical iPhone and Android, capture → organize → generate → share
        → inspect all received pages → force-quit/reopen → regenerate offline.
        Include one shot, mixed aspects, long notes, large text, rotation, missing
        images, cancelled/failed sharing, storage and interruption cases.
  - [ ] Confirm usefulness with a new creator: complete the first shared sheet
        without coaching, targeting under three minutes, and inspect whether the
        480-pixel reference frames and full notes communicate the intended shots.
        Treat image quality, page density and discoverability as observations to
        validate before expanding export formats. Link results to V07/R05.
  - [ ] Complete configured cross-device/account and purchase checks plus
        team inputs under R02/R04/R06. Keep feature evidence separate from
        store publication. Detailed acceptance is SS01–SS15 in
        [SHOT_SHEET_PLAN.md](SHOT_SHEET_PLAN.md).

- [ ] **V04 — Ship short preview-movie export.** Proposed.
      Later feature; not part of the first PNG shot-sheet completion gate.
      Depends on V02 and the sharing adapter from V03. Add export progress, cancel,
      retry, low-storage feedback, temporary-file cleanup, and save/share actions.
      Export the camera image without UI overlays; retain a fixed output aspect and
      offer only the resolution/frame-rate combinations validated on target devices.
      **Done when:** the exported movie contains the intended first and last frames,
      has correct duration and framing, and survives sharing to another app.

- [ ] **V05 — Import one supported local splat format.** Proposed.
      Later feature; not part of the first PNG shot-sheet completion gate.
      Start with SPZ, already used by the demos, and publish the tested version and
      file-size limits. Use an explicit file picker, validate content, show progress
      and cancellation, and copy accepted files to durable app-managed storage.
      Introduce an Oculo-owned asset locator with an additive schema migration;
      do not persist temporary picker URLs or blob URLs as durable references.
      **Done when:** a supported user-owned scene can be imported, oriented/reset,
      saved, and reopened offline after restart; malformed/oversized files fail
      clearly without damaging existing projects. Add PLY after this route is stable.

- [ ] **V06 — Handle imported assets across projects and synced devices.** Proposed.
      Depends on V05/F08. Ship V05/V06 together whenever Firebase is enabled. Keep
      splat bytes local and separate from Firestore project
      documents. Preserve stable asset references and provide relink/remove actions.
      Explain when another device has project metadata but lacks the source scene;
      avoid syncing device paths or implying the scene itself is backed up.
      **Done when:** relinking restores the project without shifting its shots, and
      deleting one project cannot remove an asset still used by another project.

- [ ] **V07 — Finish phone composition and first-use guidance.** Current + proposed.
      Support landscape editing intentionally while keeping portrait project browsing
      and touch fallback. Keep Save Shot, saved-shot selection, replay, and export
      reachable with a large viewfinder. Add contextual instructions and actionable
      empty states; implement the stored reduce-motion preference and accessible
      labels, focus order, and touch targets.
      **Done when:** a new user completes a demo-scene export without coaching;
      target under three minutes, measured in user sessions. Rotation, safe areas,
      permission denial, and large text do not hide essential controls.
      **Progress:** sheet empty states, focus/labels, selected sequence numbers,
      accessible reorder controls, and reduce-motion styles are implemented.
      The sheet follows the visible keyboard viewport and reveals focused fields
      without resetting the list on dismissal. Four new regressions and an iPhone
      16 Pro Max/iOS 26.3.1 simulator retest cover the confirmed header/field defect.
      Remaining: actual phone layout/accessibility and novice-use sessions.

- [ ] **V08 — Make all saved projects accessible.** Current + proposed.
      **Implemented:** full searchable library, direct scene/sheet reopen, visible
      load/retry errors, and project rename through the sheet. **Remaining:** general
      duplicate/delete actions with clear cloud/local deletion scope and recovery.
      **Done when:** users can find and reopen older work, create a variation without
      modifying the original, and understand whether a deletion affects cloud data.

## P2 — Validate, monetize, and release

Start user recruitment and store/configuration work while P0/P1 are in progress.

- [ ] **R01 — Validate the saved-project Pro offer.** Current.
      [Purchase definition](PURCHASE_DEFINITION.md): one free saved project; one-time
      `oculo_pro` removes the project limit. Import, shots, all implemented movement
      editing, PNG sheets and supported video exports are free. Existing work remains
      accessible regardless of entitlement. Atomic local writes enforce new-project
      capacity for demo saves, imports and duplicates. Subscription products are rejected.
      Remaining: price/currency, dashboard catalog, legal URLs and native sandbox
      purchase/cancel/restore/identity tests. See [PRD alignment](PRD_ALIGNMENT.md).

- [ ] **R02 — Validate existing accounts and sync for real use.** Current.
      Depends on F08. Follow [FIREBASE.md](FIREBASE.md); configure providers, native credentials, and
      rules in the intended environments. Verify sign-in, email verification/reset,
      reauthentication, account deletion, RevenueCat identity, and offline recovery.
      Selected local-project backup, destination/image disclosures, refresh/retry,
      resume, keep-both conflicts, durable ownership, and failed-sign-out recovery
      are implemented and documented. Validate newer remote work while a project
      is open, unknown legacy ownership, and any native provider configuration.
      **Done when:** two-device and two-account checks show no unintended transfers,
      stale views, or silent overwrites; sync failure preserves local edits, and
      thumbnail omission near the document-size limit has a usable fallback.

- [ ] **R03 — Profile and set supported device/scene limits.** Current.
      Use existing performance sampling to measure time to first frame, sustained
      rendering, memory, export, and repeated scene changes. Test a minimum supported
      iPhone and a representative newer device; cover Android when it remains a
      release target. Tune supported Spark quality options and communicate limits.
      **Done when:** nominated demo scenes target at least 30 fps during a five-minute
      session, with no crash or escalating memory after repeated loads; record actual
      results and a lower-quality fallback where needed. These are targets, not
      currently measured performance claims.

- [ ] **R04 — Complete store and purchase configuration.** Current.
      Finalize the app ID before
      binding production Firebase, Apple/Google sign-in, store products, and RevenueCat.
      Verify serialized purchase initialization/account linkage and customer-info
      refresh on resume against configured services. Validate sandbox purchase/restore,
      offline cached entitlement, identity changes, and entitlement revocation. Restrict simulated browser purchases to explicit
      development/demo builds; production must report billing unavailable unless
      real web billing is implemented. Complete signing, icons,
      screenshots, privacy/support pages, disclosures, and camera-permission copy.
      **Done when:** the production candidate installs from the intended distribution
      channel and all implemented paid capabilities can be tested by reviewers.
      **Progress:** serialized identity/initialization, refresh, exact product
      selection, cancellation/errors, restoration, development-only mock, store
      billing metadata, and legal-link gating exist. Native plugins/configuration
      and generated icons are present. Static preflight currently identifies final
      app ID, published privacy/terms/support URLs, four catalog IDs, and two public
      SDK keys as missing inputs. Team confirmation, configured auth if
      enabled, sandbox transactions, screenshots/privacy answers, signing/archive,
      and store test distribution remain open.
      The server-only Firebase
      Auth → RevenueCat deletion worker and guarded SDK detachment are implemented
      with regression tests. Deploy with the confirmed server secret, configure
      alerts/reconciliation, and verify asynchronous cleanup, aliases and stale
      second-device behavior before accounts ship. Unsigned iOS Release archive
      and Android AAB compile; signing and store validation remain open.
      Store screenshots and approval against
      the final configured release remain outstanding. The ten preflight inputs
      above are still missing.

- [ ] **R05 — Validate usefulness and willingness to pay.** Proposed research.
      Recruit ten directors/creators with an upcoming project, starting now. Compare
      the same shot task with their current workflow. Observe completion time,
      exports actually used in another tool or conversation, second-project use,
      and purchases; record results without automatically uploading customer content.
      **Done when:** results support a focused audience and the next product decision.
      Proposed go/no-go signals: 8/10 complete without coaching, 4/10 return for a
      second project within two weeks, and 3/10 pay. These are hypotheses for this
      pilot, not market benchmarks. Diagnose failures before adding broad features.

- [ ] **R06 — Run release verification and submit the working product.** Current.
      Complete the runbook's physical-device loop, force-quit recovery, offline demo,
      share/export, permission, interruption, and billing checks. Run `pnpm lint`,
      `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm cap:sync` for native handoff.
      Capture a concise demo showing phone movement → saved shots → revised move →
      usable output → reopened project. Refresh the official submission requirements
      and provide the applicable store link and judge access.
      **Done when:** the selected category's submission is complete and its depicted
      features work in the submitted build. Verify the current official category
      deadlines and release requirements before submission; allow store-review and
      correction time.
      **Progress:** checkpoint lint/typecheck/build/sync and 381 tests in 29 files
      passed after the keyboard viewport fix; both latest native debug builds and
      unsigned iOS archive/Android release bundle pass. On iPhone 16/iOS 26.3.1
      simulator, Small Garden capture → sheet → native Share → Files completed,
      with visual and byte verification of the received PNG. Launch after
      terminate/install-over-existing-data/relaunch retains the shot, and direct
      library reopen/regeneration/readable zoom pass in the updated iOS simulator.
      Enlarge (100%)/Fit, native Share cancellation with preview retention, and
      saved-scene SOG rendering pass; simulator keyboard panning is now verified.
      The current 381-test iPhone 16 Pro Max run adds the keyboard/accessory retest
      and a fresh two-shot/8-second-move native Files receipt opened after preview
      closure; historical receipts retain their original build identity in the plan.
      Physical panning and received-file/restart,
      multi-page/offline/storage/purchase/signing and submission gates remain open.

## P3 — Differentiate after the useful workflow works

- [ ] **D01 — Add camera handling controls.** Proposed; depends on F06.
      Add horizon lock, adjustable stabilization, movement sensitivity, and hold-to-
      reposition. **Done when:** users can reframe their physical stance without
      changing the virtual shot; settings behave consistently after recenter/replay.

- [ ] **D02 — Add simple rigs and editable move presets.** Proposed; depends on F04/F05.
      Start with pan, dolly, rise, and push-in, plus a small set of easing choices.
      Add a subject target for look-at moves before orbit presets. **Done when:**
      presets produce editable, saved moves with predictable endpoints and timing;
      they do not require a curve editor.

- [ ] **D03 — Add subject blocking for narrative shots.** Proposed.
      Introduce simple actor stand-ins, eyeline targets, and position markers with
      dependable placement and occlusion in splat scenes. **Done when:** a director
      can compose matching coverage around a subject and include it in exports.
      Evaluate simple subject motion only after static blocking is useful.

- [ ] **D04 — Add an explicitly approximate focus/aperture preview.** Proposed
      future scope, explicitly deferred in the current MVP; depends on F02/F07.
      Validate supported Spark depth-of-field behavior and the mapping from user
      controls to render parameters. Persist settings with migration and replay them.
      **Done when:** controls visibly affect preview/export consistently and the UI
      clearly states the limits of lens matching. Do not claim calibrated f-stop,
      focus-distance, or production optics accuracy without validation.

- [ ] **D05 — Record, revise, and compare physical camera takes.** Proposed.
      Depends on D01 and V04. Capture timestamped device motion into a versioned path;
      support retakes and non-destructive smoothing with before/after comparison.
      **Done when:** a recorded move replays/exports consistently and adjustments
      preserve the original take.

- [ ] **D06 — Export reusable references for AI and editing workflows.** Proposed.
      Depends on V03/V04. Package a reference clip, selected frames, camera metadata,
      and notes; test one named downstream workflow with creators before adding
      proprietary plugins or APIs. **Done when:** the package demonstrably reduces
      revision work, and original camera intent remains available if AI output drifts.

- [ ] **D07 — Add calibrated placement when users need on-set planning.** Proposed.
      Support a known-distance/floor calibration and optional collider or permitted-
      region metadata. **Done when:** height and travel distances use validated units
      and users can distinguish an executable physical path from a virtual-only move.

## Deliberately deferred

- Building a scanner, reconstruction service, custom world model, or renderer.
- In-app world generation, relighting, or generative-video finishing before
  external handoffs and unit costs have been validated.
- Full character animation, production lighting simulation, sound, grading,
  compositing, or a multi-scene nonlinear editor.
- Real-time collaboration, teams, public galleries, feeds, and marketplaces.
- Full camera/lens databases, motion-control hardware integration, and DCC plugins.
- Automatic cloud scene storage, arbitrary offline caching, and unsupported
  import formats. Local imported assets are limited to V05/V06.
- Multiple paid tiers, consumable AI credits, ads, and paywall experimentation
  infrastructure before one paid offer demonstrates value.

## Recommended execution sequence

1. **Finish device interaction acceptance:** verify preview panning, VoiceOver,
   and Android runtime. The 381-test source checkpoint, latest native builds, and
   simulator retained-sheet reopen/regeneration, Enlarge/Fit, native Share
   cancellation, and saved-scene SOG rendering are verified. Source work,
   iOS minimum/API-preflight handling, simulator Files delivery, and the current
   iPhone keyboard-viewport correction are implemented and verified within the
   documented limits.
2. **Prove physical delivery and persistence:** complete F02/F03/F05/F06 and
   V01/V03/V07 acceptance on iPhone and Android. Inspect actual files received by
   another app and repeat after force-quit/offline reopen; measure R03 performance.
3. **Prepare the release in parallel:** collect R04 team/service inputs,
   validate R01/R02 against configured native services, and run the R05 creator
   pilot. Complete R06 only with the device/build/submission evidence recorded.
4. **Choose the next product slice from use:** general library management in V08,
   import in V05/V06, video feasibility in V02/V04, or a P3 improvement. None is a
   prerequisite for the first usable one-shot PNG sheet.

Recommended platform sequence is iPhone first because Magic Window already uses
ARKit. The current MVP still requires an iPhone and Android walkthrough; changing
that release requirement must be recorded in `MVP.md`.

For each implementation slice, run the narrow relevant checks. Add meaningful
regression coverage for framing, coherent shot snapshots, path timing, migrations,
asset lifetime, sync boundaries, and entitlement behavior. Record physical-device
results for tracking, rendering, file sharing, encoding, and native purchases.

## References

- [MVP scope](MVP.md), [architecture](ARCHITECTURE.md),
  [world-provider boundaries](WORLD_LABS_INTEGRATION.md),
  [Firebase setup and semantics](FIREBASE.md).
- [Shipaton 2026 official rules](https://revenuecat-shipaton-2026.devpost.com/rules)
  — recheck category-specific requirements before submission.
- [KIRI Maker](https://www.kiriengine.app/blog/kiri-maker-3dgs-animation-tool) and
  [Previs Pro](https://www.previspro.com/) — reference workflows for R05 comparisons.
