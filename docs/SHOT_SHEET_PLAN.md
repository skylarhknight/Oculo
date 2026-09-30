# Scene-to-shot-sheet completion plan

Updated 2026-09-10. Scope: the five completion steps requested by the user,
including native sharing, dependable saved images, and first-release verification.
The feature is implemented across the app, renderer, delivery adapters, and local
storage, including library placement, exact-PNG preview zoom, modal accessibility,
bundled fonts, account-deletion identity guards, and the server cleanup worker.
Playback now owns the camera exclusively; tracking loss freezes the frame and
recovery rebaselines safely. Pending tracking startup and stale native callbacks
are cancelled across viewer changes. Regression tests cover these source fixes.
Full lint, typecheck, 381 tests/29 files, production build and Capacitor sync pass. Latest
iOS/Android debug builds and unsigned iOS device archive/Android release bundle
compile successfully. Updated iOS UI verification covers all four aspect controls,
a saved portrait frame, and the repaired text-field zoom behavior. The four-page
Files handoff and source/recipient byte evidence are recorded below. None of this
closes physical-device, configured-service or signed-distribution gates.
The preceding 348-test build also completes a one-shot capture/edit/generate/Files receipt
and restart/library regeneration on an iPad Pro simulator running iPadOS 18.6.
The 377-test checkpoint fixed blank shot-tray previews with contained image
elements. The current 381-test checkpoint keeps sheet editing within the visible
keyboard viewport and preserves list position on dismissal. An iPhone 16 Pro Max
simulator retest verifies field/header access, readable page text, and a fresh
two-shot/8-second-move sheet received and opened in Files after preview closure.
Current web assets are `index-wUJCYxXD.js` and `index-7jibKmkY.css`. Earlier evidence
below keeps its original build identity. The current iPad Pro/iPadOS 18.6 retest
also passes retained two-shot reopen, keyboard access and regeneration; it does
not repeat the Files handoff.

Checked items below have implemented behavior and recorded automated coverage.
An open item can contain completed source work plus an outstanding native or
release criterion; it does not imply that its implementation is absent. Store
publication is a separate action from preparing a reviewable release candidate.

## Product contract

Keep the existing scene → composition → saved shot → camera move → replay →
persistence loop. The optional **Shot sheet** branch is available after one saved
shot. Neither a camera move, scene reload, account, nor purchase is required to
create and share a sheet. Sheets use an immutable snapshot of saved shots;
preparation and sharing preserve the live camera and saved framing.

The deliverable is one or more PNG pages with project/location name, generation
date, ordered shot numbers, images, names, complete notes, focal length, sensor
format, aspect, and scene attribution where supplied. Current captures and
recaptures have a maximum edge of 480 pixels: the output is a digital planning
reference. A move summary appears only for a valid move; project duration is never
presented as an individual shot's duration. PDF, high-resolution stills, scene
import, and movie export are later work and are not prerequisites for this scope.

## Implementation order and acceptance

### 1. Review and organize

- [x] SS01: Sheet review has explicit close, an empty state, and editor/library
      entry points. One-shot library entry does not initialize the scene renderer.
      Phone layout and accessibility still require the device checks in SS14.
- [x] SS02: Project titles, shot names/notes, inclusion, and order persist.
      Stable IDs, editable names, and selected sequence numbers are distinct. Close
      waits for saving and blocks further edits; deletion cleans in-memory exclusions.
      Regression tests cover delayed/failed saves and the full exclude → editor →
      delete excluded shot → sheet → generate transition.
- [x] SS03: All saved projects are searchable and can reopen their sheet directly.
      Storage failures remain visible and recoverable; saved references remain
      accessible independently of scene loading. General project duplication/deletion
      is separate library work, not a blocker for opening a sheet.

### 2. Build a faithful artifact

- [x] SS04: The provider-independent model is immutable and uses saved cameras
      and images. It validates selections, camera metadata, and input budgets without
      inventing focus, aperture, metric measurements, or per-shot duration.
- [x] SS05: The renderer produces 1440 × 2036 PNG pages with contained mixed-aspect
      images, selected-shot numbers, date/page labels, attribution, Unicode/RTL support,
      and complete long-note continuation. Missing/corrupt images require exclusion
      or recapture. Limits are explicit: up to 100 selected shots and 40 pages, with
      bounded image decoding and output memory; no silent truncation or partial success.
- [x] SS06: Preview displays the exact generated page bytes. Edits invalidate
      stale output. Generation and file preparation have separate cancellation,
      progress, error, and retry states. Preparation failure preserves existing PNGs;
      delayed results after cancellation/close are disposed safely. DOM tests exercise
      these transitions. Actual WebView readability/memory remains SS14/R03 acceptance.
      **Accessibility:** each page exposes the exact ordered text painted into its
      PNG through a selectable **Read text for page N** disclosure. Renderer tests
      compare it with actual canvas text calls; UI tests cover page changes,
      continuation, cancellation, failed preparation and stale-generation removal.
      The latest iOS build opens readable page text and closes/retitles the
      disclosure on page change. Native VoiceOver remains an acceptance gate.

### 3. Deliver files

- [x] SS07: App-owned sharing/file ports have native Capacitor Share/Filesystem
      and browser file-share/per-page-download adapters. Files and capability checks
      are prepared before the explicit Share click; generated PNGs and names are
      validated. Browser sharing retains click activation.
- [ ] SS08: Finish recipient and recovery acceptance on physical platforms.
      **Implemented:** cancellation is a normal outcome; unavailable sharing,
      concurrent requests, low-storage/write failures, and retries preserve preview
      and project. Native cache retention lasts 24 hours after the latest handoff
      attempt, with cleanup of expired inactive batches during later preparation;
      browser URLs have bounded lifetimes. Port and UI tests cover these policies.
      **Simulator evidence:** a one-shot 16:9 Small Garden sheet was shared through
      native Share → Save to Files and opened visually in the recipient Files
      viewer, with identical bytes at all three storage locations. Native Share
      cancellation returns a normal notice and preserves the preview and enabled
      Share action. The 381-test iPhone 16 Pro Max build also regenerates a retained
      two-shot project with an 8-second move and opens its received PNG in Files
      after closing the app preview. Build-specific receipts are below.
      **Remaining:** inspect every page received in another app, including after
      closing Oculo's preview, retry/cancellation, and storage/interruption cases.
      Cache policy and successful API calls alone do not prove recipient access.
- [ ] SS09: Finish native runtime acceptance after the latest sync/build.
      **Implemented:** locked Share/Filesystem dependencies, generated bindings on
      iOS/Android, iOS file-timestamp privacy declaration, Android cache FileProvider,
      and corrected product/paywall documentation. Native binaries have built.
      **Runtime progress:** the rebuilt iPhone 16/iOS 26.3.1 simulator launches without
      the initial Firebase crash and renders Small Garden upright in a live 16:9
      camera, then captures and shares a one-shot PNG successfully. iOS minimum
      version 17 and the tested SOG API preflight are implemented. The preflight
      probes the main thread; worker/GPU/memory/decoder limitations remain runtime
      concerns. Latest iOS/Android native rebuilds succeeded; the updated iOS app
      reopens and regenerates the retained one-shot sheet, with readable enlarged
      PNG text. Reopening the saved scene passes the SOG preflight and renders
      the same upright garden framing. **Remaining:** Android runtime and
      physical/configured-account acceptance in SS14/SS15.

### 4. Keep images and edits dependable

- [x] SS10: IndexedDB v3 adds durable local images with additive legacy migration.
      Metadata-only cloud replacement preserves a matching scene/camera frame;
      mismatched frames are not reused. Deletion cleans unreferenced media.
      Tests cover a second device's metadata-only edit, migration, changed camera,
      deletion, and cloud-size behavior.
- [x] SS11: Local revision/transaction/session guards protect racing edits,
      acknowledgments, invalid/newer-schema cloud data, and account changes. The
      account UI offers explicit selected-project backup, destination/image-omission
      disclosure, errors/retry, and keep-both conflict recovery. Unknown legacy owners
      require explicit IDs; another known account's projects are never adopted.
      Failed sign-out rebinds a still-authenticated account. Store and DOM coverage
      exist; configured two-device/two-account checks remain R02/SS15 gates.
- [ ] SS12: Finish interruption and restart acceptance.
      **Implemented:** missing/corrupt-frame status, exclusion, saved-camera recapture,
      preservation of active camera/shot metadata, durable save retry without a second
      capture, and local reopen/migration tests. Available local images remain usable
      offline; omitted cloud thumbnails are explicitly unavailable on a fresh device.
      **Simulator evidence:** force-terminate → install over existing data → relaunch
      preserves the one-shot project. Home-first library entry opens its sheet
      without a scene viewer and regenerates from the retained image. This does
      not prove real OS-kill, airplane-mode, low-storage, or physical-device behavior.
      **Remaining:** verify acknowledged writes survive immediate force-quit/relaunch
      on physical iPhone/Android, plus backgrounding during movement, recapture, and
      file preparation. An asynchronous page-exit flush is not an OS durability guarantee.

### 5. Verify and prepare the release

- [x] SS13: Record automated and rendered-output evidence for the current source.
      **Recorded checkpoint:** 381 tests in 29 files passed, including domain/model/renderer,
      sharing ports, persistence/sync, account/workspace/recapture DOM tests, and App
      transitions. Prior artifact inspection covered contained wide/square/portrait
      frames, Unicode/RTL text, and full long-note continuation.
      The framing/replay/account regressions are included in this checkpoint.
      Final lint, full workspace typecheck, 381 tests/29 files, production build,
      and Capacitor sync pass. Four new viewport regressions cover focused-field
      visibility, scrolling/dismissal preservation, pinch-zoom exclusion and listener
      cleanup, alongside the prior library hydration/saved-frame restoration tests.
      Prior rendered artifacts and the byte-verified received PNGs
      provide output evidence. Latest native rebuilds and readable zoom/reopen
      checks also pass; physical interaction acceptance stays in SS14.
- [ ] SS14: Complete the native and physical workflow matrix.
      Final source lint/typecheck/test/build/sync and both latest iOS debug
      simulator/Android debug builds passed with the final web assets. A one-shot native
      Share/Files handoff and visual/byte verification succeeded in the simulator.
      Updated native library reopen, regeneration, Enlarge (100%) readable
      header/metadata, and Fit restoration pass. Native Share cancellation retains
      the preview and enabled Share action; reopening the saved scene renders the
      same upright garden framing through the SOG preflight. Focused preview
      keyboard Down/Right scrolling is verified in the simulator, as are software
      keyboard name/notes access and Save. In the 381-test iPhone 16 Pro Max/iOS
      26.3.1 retest, focusing a lower title no longer moves the sheet header behind
      the notch: header, title, notes and Preview remain accessible with both the
      hardware-keyboard accessory and software keyboard; dismissal preserves list
      position. Arrow Down scrolling and readable page text pass. Keyboard Next
      and Page Down behavior is uncertain in this retest, not an established
      general regression. The current iPad Pro/iPadOS 18.6 retest also keeps the
      lower notes field, header and Preview accessible with the accessory/software
      keyboard, restores the full sheet after dismissal, and regenerates the
      retained two-shot sheet with its move summary and exact page text.
      Touch panning remains unverified:
      Simulator drag did not establish meaningful movement. Physical panning,
      screen-reader behavior and native Unicode glyph support remain open.
      On a physical iPhone and Android,
      complete capture → organize →
      generate → share to another app → inspect received files → force-quit/reopen →
      regenerate offline. Verify 16:9, 4:3, 1:1, 9:16, rotation, large text, safe areas,
      accessibility, many pages, cancelled/failed sharing, storage errors, and
      interruptions, VoiceOver, and Android runtime behavior. Record device, OS,
      build ID, and actual received-file evidence.
- [ ] SS15: Complete team configuration and submission evidence.
      Final app identifier and signing/team confirmation, published privacy/terms/
      support links, configured RevenueCat catalog/public keys, provider/rules setup
      if accounts ship, sandbox purchase/restore/expiry/account deletion, screenshots,
      store privacy answers, archive validation, and test distribution remain release
      inputs. Source icons/configuration and a debug build are not store acceptance.
      Do not substitute mocks for these gates.
      **Progress:** unsigned device Release archive and Android AAB compile; final
      web assets, bundled scene/fonts and signature absence were inspected.
      Server-only RevenueCat
      deletion source and identity-race tests pass; deployment, Secret Manager
      configuration, failure monitoring and real provider cleanup remain open.
      Screenshots and store listing assets are not final configured-release
      approval or submission evidence.

## Current status audit — 2026-09-10

**Assessment: the core workflow is implemented and demonstrated on iOS simulators;
physical workflow acceptance and release readiness are unfinished.** Source review
has not identified a missing screen, renderer, delivery adapter or persistence
layer needed for the first PNG sheet. This is not a claim that every runtime case
passes. The 381-test checkpoint includes the whole workspace, not 381 end-to-end
shot-sheet tests.

| Step                | Implemented and covered                                                                                                                                                                                      | Remaining acceptance                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Review and organize | Library/editor entry, one-shot flow, search, titles/notes, selection/order/sequence, guarded save/close; keyboard viewport correction and iPhone simulator retest                                            | Physical phone layout, large text, safe areas and accessibility                                           |
| Build artifact      | Immutable saved-shot model, bounded attributed PNGs, mixed aspects, complete notes, exact-byte preview, cancellation and independent preparation retry; received simulator PNG visually inspected            | Physical preview panning; actual physical WebView appearance and memory                                   |
| Deliver files       | Native/browser adapters, plugin linkage, privacy/cache setup, iOS 17 minimum/API preflight, explicit Share/download; iPhone multi-page and iPad one-page simulator Files receipts visually and byte verified | Physical delivery; cancellation/storage/interruption cases; supported GPU/worker runtime limits           |
| Preserve work       | v3 local media/migrations, revision/account guards, consent/recovery UI, missing-frame recapture with retry                                                                                                  | Physical restart/background tests; configured cross-device/account checks                                 |
| Verify/release      | 381 tests/29 files, full lint/typecheck/build/sync checkpoint, iOS/Android debug builds, unsigned archive/bundle builds, simulator launch/capture/share/received-file evidence                               | Physical preview panning; full offline/failure matrix; physical matrix and team/service/store inputs |

The useful first-version outcome is a collaborator receiving a readable visual
shot plan without installing Oculo. PNG-only delivery and 480-pixel reference
captures are deliberate limits. Validate that image quality and page density are
sufficient with creators before promising print-quality output or production
film rendering. Accounts and purchases are independent release requirements;
they do not block the anonymous local sheet workflow.

### Previously reported blockers resolved

- Slow-close edits cannot return an older project snapshot: the workspace blocks
  editing while saving and returns its committed state; a delayed-store DOM test
  covers the boundary.
- Deleting an excluded shot normalizes selection before sheet navigation. The App
  integration test exercises exclusion, editor deletion, reopening, and generation.
- File-preparation failure retains exact generated PNGs and permits preparation
  retry without regeneration; late handles are disposed after cancel/close.
- Review cards display selected-shot sequence numbers independently of names.
- Share/Filesystem are included in native projects; remaining work is runtime and
  recipient verification, not adding the dependencies again.
- App/Account is connected to selected-project backup, omission disclosure,
  conflict keep-both/retry, legacy ownership selection, and failed-sign-out recovery.
- Saved-tray previews use actual contained images rather than empty background
  spans. The latest App regression exercises metadata-only library loading,
  hydrated previews and restoration of the saved camera; native iPad inspection
  confirms both retained images are visible.
- Keyboard viewport panning no longer hides the sheet header behind the notch.
  The workspace follows the visible viewport, reveals newly focused fields inside
  its list, and preserves user scrolling on keyboard dismissal. Four deterministic
  regressions and the 381-test native iPhone retest cover the confirmed defect.

Relevant evidence lives in
[App.test.tsx](../apps/mobile/src/App.test.tsx),
[ShotSheetWorkspace.test.tsx](../apps/mobile/src/components/ShotSheetWorkspace.test.tsx),
[RecaptureShot.test.tsx](../apps/mobile/src/components/RecaptureShot.test.tsx),
[AccountSheet.test.tsx](../apps/mobile/src/components/AccountSheet.test.tsx),
[shot-sheet tests](../apps/mobile/src/services/shotSheet), and
[store tests](../apps/mobile/src/store). These tests isolate provider/device
boundaries; they do not prove native sharing or AR tracking on physical hardware.

### Received-file evidence — iOS simulator

The current **381-test build** (`index-wUJCYxXD.js`, `index-7jibKmkY.css`) was
installed over existing data on **iPhone 16 Pro Max, iOS 26.3.1 (23D8133)** simulator.
The retained two-shot project and 8-second move regenerate a fresh one-page sheet.
Native Share → Save to Files → On My iPhone succeeds. After Oculo's preview
closes, Files Quick Look opens the received PNG; visual inspection confirms both
frames, names, full notes, camera settings, credits and the move summary.

- Size: 941,628 bytes; dimensions: 1440 × 2036.
- SHA-256: `8c1b7969f5e8787df833481a398cb37dda41f76b3d011f6cb60bb9e75e019e15`.
- Temporary inspection artifact:
  a local QA artifact (not included in this repository).

The keyboard retest keeps the header below the status bar and makes the title,
notes and Preview accessible with the hardware-keyboard accessory and software
keyboard. Dismissal preserves the sheet's list position. Arrow Down scrolling and
the readable page-text disclosure pass; Next/Page Down remain uncertain. This
does not establish physical touch, screen-reader or native Unicode acceptance.
Final team approval of store screenshots remains open.

The same **381-test build** was installed over retained data on **iPad Pro 13-inch
(M4, 8 GB), iPadOS 18.6 (22G86)** simulator
(`B01C528D-F76D-4943-B60E-AB648FDBF784`). Home → Small Garden → Shot sheet directly
reopens both distinct 16:9 frames at 35/52 mm, names and full notes. Focusing the
second shot's lower notes field with either the hardware-keyboard accessory or
full software keyboard keeps the header below the status bar and the full textarea
above Preview and the keyboard. Hiding the keyboard and blurring the field restores
the full sheet. Regeneration produces one PNG containing both frames/notes and the
two-keyframe, 8-second move summary; Read text exposes the matching metadata/notes.
Temporary GUI proofs are
a local QA artifact (not included in this repository) and
a local QA artifact (not included in this repository).
This retest does not include a new Files transfer, physical touch/screen-reader
acceptance or new store captures.

The preceding 348-test build (`index-D9uGenfS.js`, `index-BmmPltgq.css`) was installed on an
isolated **iPad Pro 13-inch (M4, 8 GB), iPadOS 18.6 (22G86)** simulator. Small Garden
passes the SOG API preflight and renders upright. Save one 16:9 shot → edit title
and notes → generate one page → native Share popover → Save to Files succeeds.
The received PNG remains after preview closure and exactly matches the app cache:

- Size: 541,587 bytes; dimensions: 1440 × 2036.
- SHA-256: `612d92a076001eae93a6a1fdccd1d9c0fca8b18a6e6c07ba388c314842e5bfc8`.
- Temporary inspection artifact:
  a local QA artifact (not included in this repository).

Visual inspection of the received PNG confirms the frame, shot name, full notes,
camera metadata, attribution and page label. Force-terminate → relaunch retains
the image and edits; direct library entry regenerates the sheet without opening
the scene. The page-text disclosure displays the corresponding text. The floating
keyboard accessory dismisses when the heading is tapped, making the preview
button accessible. This one-page simulator case does not establish physical iPad
performance, touch/VoiceOver, offline/interruption behavior, all tablet sizes or
store screenshot acceptance. The native archive supports both iPhone and iPad.
Installing the subsequent 376-test build (`index-iQbDqzU2.js`) over this project
also preserves its image, name and notes; direct library reopen and sheet
regeneration are visually verified. This installation does not repeat the Files
handoff or establish physical tracking acceptance.

The subsequent 377-test build (`index-C0I6v33F.js`, `index-B5QgGQr7.css`) displays
both retained iPad tray images correctly. Recalling **Garden overview** and
**Flower detail** restores the corresponding 35 mm and 52 mm framing. A move made
from these saved cameras plays, pauses and scrubs through an 8-second lens change;
its final frame returns to 52 mm. This establishes the inspected simulator lens
and timeline behavior, not physical navigation or a translational camera move.
A fresh capture also displays its tray image on the iPhone 16 Pro Max/iOS 26.3.1
simulator. These captures do not close physical-device or final configured-release acceptance.

The preceding rebuilt app (`index-CuisEi8Q.js`, `index-9mEL71P3.css`) added a fifth,
9:16 portrait shot and generated/shared four pages again. All four received Files
PNGs match the generated cache bytes; the final page was visually inspected with
the contained square and portrait frames. Each page is 1440 × 2036. Copies are at
a local QA artifact (not included in this repository).

| Page |   Bytes | SHA-256                                                            |
| ---- | ------: | ------------------------------------------------------------------ |
| 1    | 755,007 | `461925fbcec0e3afae7dd560be548f2cb9adf1b0f7cd35400a869efb07eae9ca` |
| 2    | 420,597 | `9e763e102a79169dccf8c43a0af773f2408026278dc9602dc6f7ea7cd9736fc2` |
| 3    | 632,900 | `2f42f3c6a145e141aad48b0f6a747e6dc0847eac6ba6538f566d9614e67804bb` |
| 4    | 460,768 | `32f36bec55b92ffb1083fe4d8fabf9647319e986788dc78d206f0f37181583c8` |

The preceding four-shot run retained 16:9, 4:3, and square captures plus long notes
through force-terminate/relaunch, then generated four pages directly from the
library. Native Share → Save to Files received all four pages. After closing
Oculo's preview, each received file still matched its app-cache PNG exactly.
All four received artifacts were visually inspected: aspect containment,
attribution, sequence labels, note continuation through all 18 numbered beats,
and the final cue on page 3 are intact. The automated typing tool dropped some
non-ASCII fixture characters before saving, so this run does not establish native
Unicode input/rendering acceptance. Automated renderer Unicode coverage remains
separate.

| Page |   Bytes | SHA-256                                                            |
| ---- | ------: | ------------------------------------------------------------------ |
| 1    | 754,891 | `2fa6c4385650a6321e809d0ef7bd8e72e25ab9d2ac36df1ab531b747d06fa73a` |
| 2    | 420,427 | `70647f0323a1f96cf2551050bee069bcb483a875d49239ac01a1099be9aa65f8` |
| 3    | 632,781 | `510f6ce090ef2286816dfdf03520a2c7766eddc758330c7e36f3822ad3760802` |
| 4    | 325,201 | `fda4ae715477ad14a873f290845c427dd93fa835f8e9eb533de9116c39fcddf2` |

Every page is 1440 × 2036. Inspection copies are temporarily at
a local QA artifact (not included in this repository). Files retained the existing
one-page QA export and named the new first page `Small-Garden-shot-sheet-01 2.png`.
This is simulator evidence, not physical recipient/interruption acceptance.

The iPhone 16/iOS 26.3.1 simulator completed Small Garden upright 16:9 → save one
shot → sheet → native Share → Save to Files → open received PNG in Files.
Visual inspection confirmed the received page, and the app cache, recipient
Inbox, and Files storage contain identical bytes:

- Size: 513,832 bytes; dimensions: 1440 × 2036.
- SHA-256: `a14305b9988123a2bf1146067e25457352d7138d831a3f5596f7a82df2239bb9`.
- Temporary inspection artifact:
  a local QA artifact (not included in this repository).

The updated native build also survives force-terminate and install-over-existing-
data, retains the one-shot project, reopens directly from the library without a
scene viewer, regenerates its sheet from the retained image, and displays readable
enlarged PNG header/metadata at 100%; Fit restores the page view. Native Share
cancellation returns a normal notice while retaining the preview and enabled
Share button. Reopening the saved scene passes the SOG preflight and renders the
same upright garden framing. Touch panning is not verified.

This paragraph records the earlier single-page simulator case; the four-page,
all-aspect evidence above extends it. True offline/OS-kill recovery, physical
hardware, storage/interruption behavior, configured purchases/accounts, and
signing/distribution remain separate gates.
No physical phone is currently connected: `xctrace` lists only the Mac under
Devices, and `adb devices` lists only the QA emulator. The exact simulator runtime is 26.3.1 even
though its window label displays 26.3.

### Remaining completion sequence

1. **Prove the baseline on physical iPhone and Android (SS08/SS09/SS14).** Use the
   381-test candidate or a later fully checked build. Capture one shot, edit its
   name/notes, generate, share to Files and another available recipient, close the
   preview, and open every received file. Repeat with all four aspects and long
   notes across multiple pages. Compare landmarks in the live view, saved frame
   and received PNG. Record device, OS, build and received-file evidence. Android
   startup logs do not satisfy this workflow check.
2. **Prove recovery and offline use (SS08/SS12).** After “Saved on device,”
   immediately force-quit and relaunch; verify images, edits, order and selection.
   Reopen the library and regenerate in airplane mode. Exercise missing/corrupt
   image exclusion and saved-camera recapture, cancelled sharing, interrupted
   preparation and failed writes. Pass only when retry preserves the project and
   active camera and acknowledged data survives restart.
3. **Finish phone usability and performance (SS14, V07/R03 in TODO).** Check
   keyboard access, rotation/safe areas, large text, touch panning of enlarged
   pages, VoiceOver/TalkBack, Unicode glyphs and repeated generation on supported
   hardware. Measure large-sheet generation time and peak memory; reduce supported
   limits if the advertised budget cannot run reliably. Confirm a new creator can
   reach and understand the received sheet without coaching, targeting under three
   minutes; record observations rather than assuming discoverability from DOM tests.
4. **Validate configured services if they ship (SS11/SS15).** Perform two-device,
   two-account backup/conflict/image-omission recovery; deploy and verify account
   cleanup and monitoring; exercise real sandbox purchases, restore and expiry.
   These checks must not become prerequisites for making a local free sheet.
5. **Complete distribution separately (SS15).** The latest `release:check` still
   reports ten missing inputs: final app ID, three public URLs, four RevenueCat
   catalog IDs and two public SDK keys. Confirm team/signing inputs, finish
   Android screenshots and privacy answers, validate signed archives and test
   distribution. Capture store screenshots from the final configured release.
   Unsigned binaries are build evidence, not store-ready releases.

Close the feature acceptance items only after steps 1–3 pass on the required
platforms and any resulting defects are fixed and rechecked. Close overall
release readiness only after the applicable service and distribution gates pass.

Small Garden is now a bundled, attributed CC BY 4.0 starter; arbitrary remote
scene caching remains absent. Verify fresh native airplane-mode entry on devices.
PDF, movie rendering, standalone high-resolution stills, and customer scene import
must not expand this first shot-sheet completion gate.
