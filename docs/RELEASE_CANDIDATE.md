# Reproducible release candidate

From the repository root:

```sh
node scripts/release-candidate.mjs
```

The same pipeline is available as `corepack pnpm release:candidate` after dependencies are installed. The direct Node command also works when pnpm would otherwise stop at a dependency-freshness prompt. It creates a timestamped directory under `artifacts/release-candidate/`, with per-step logs, `report.json`, `report.md`, and available unsigned build artifacts. `artifacts/release-candidate/latest.json` points to the most recent completed report. Outputs, native build caches, and temporary browser data are ignored by Git and ESLint.

The default native release coverage is iPhone. Add `--android` to the direct Node command for independently owned Android verification. iPad is deferred. The same flag applies to `apps/mobile/scripts/check-release.mjs`.

## Checks and artifacts

1. Install exact lockfile dependencies with Corepack/pnpm and `--frozen-lockfile`.
2. Run lint, workspace type checks, the complete Vitest suite with at most four workers, and production builds.
3. Copy the production web bundle into the candidate, synchronize Capacitor assets and plugin registrations, and fingerprint the source tree.
4. Run the real Chrome editor verification and phone/tablet screenshots. Run the real video export verifier with Chrome and FFmpeg, retaining the MP4, reference frames, and codec/timing report.
5. On macOS with Xcode, build an unsigned iOS Release archive and simulator application. Record the packaged iOS permission/privacy manifests and verify the app is unsigned. Create disposable iPhone simulators from available installed runtimes, boot, install, launch, and poll screenshots with macOS Vision OCR until both “Oculo” and “Start exploring” are visible (bounded to 60 seconds). Retain attempt captures, the verified screenshot, and readiness timing/recognized-text JSON. Terminate and relaunch, then require the same content-readiness check. Delete only the simulators created by this run during cleanup.
6. Only with `--android`, when an Android SDK and JDK are available, build an unsigned release APK plus a debug-signed emulator APK. Install the debug build on an available emulator (never a physical device), or start an installed AVD in read-only mode. Launch, capture a screenshot, stop, and relaunch. Stop only emulator processes created by this run.
7. Run release configuration preflight and verify that source files did not change while candidate artifacts were being built/tested.

The iOS archive is intentionally unsigned; it cannot be installed on a physical iPhone or submitted to App Store Connect. The Android release APK is unsigned; the debug APK is for emulator verification. The command neither signs for distribution nor publishes anything.

## Prerequisites

- Node compatible with the lockfile/toolchain (the development machine uses Node 24), Corepack, and pnpm 11.21.0. Firebase account functions target Node 22 at deployment; their engine warning under the local toolchain must not be mistaken for a deployed runtime change.
- Network access for dependencies not already cached. Keep the workspace unchanged during a run; a changed source fingerprint marks the report failed even if individual builds succeeded.
- Chrome at its standard macOS path, or `CHROME_BIN`; `ffmpeg` and `ffprobe` on `PATH`. Editor verification reserves ports 5174/9225; video verification reserves ports 5175/9227 unless their scripts' override variables are set. Stop conflicting verification runs first.
- For iOS: full Xcode selected with its installed simulator runtime and access to CoreSimulator. A restricted filesystem/process sandbox may prevent Swift package resolution or simulator access; run the authorized local build with those capabilities available.
- For Android: SDK platform 36, build tools 36.0.0, platform-tools, JDK 21, and an installed AVD. Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` when the SDK is outside the standard user location.

Native dependencies and DerivedData/Gradle caches are retained under `artifacts/release-candidate/cache` so subsequent candidates can reuse compiled dependencies. Every candidate receives its own copied final artifacts and report. Do not delete these caches while a run is active.

## Reading the report

Each step records its command, timestamps, status, and log location. Completed preflight findings are classified as `needs-configuration` while retaining the original nonzero exit code/log; an unexpected preflight crash remains a technical failure. `technicalStatus` reports actual check/build failures separately from `coverageStatus` (partial when tools/platforms are unavailable). A failing test/build remains a failure even if later steps produce artifacts. Missing native SDKs or encoding tools are reported as unavailable and listed as external requirements; they never count as successful verification. The command exits nonzero for a failed, incomplete, or configuration-blocked candidate and still writes its report.

Screenshots prove that a capture was produced and allow visual review. The iOS OCR gate rejects a blank screen and proves the expected home content appeared; it does not judge layout quality or scene rendering. A failed native launch or content-readiness gate remains failed and triggers bounded screenshot, OCR, device-log, and process-state capture before the disposable simulator is deleted. A native process launch alone does not prove that scene rendering, touch controls, camera tracking, or file handoff work. Browser workflow and codec reports contain the separate evidence for those automated checks. Physical-device certification and configured provider/store acceptance remain external milestones.

The report always marks `storeReady: false`. Final application identity, team contact/legal inputs, public URLs, distribution signing, live purchase/provider setup, physical-device checks, and actual store submission are separate from building an independently testable candidate. See [DATA_FLOWS.md](DATA_FLOWS.md).
