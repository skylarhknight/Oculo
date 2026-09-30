# Camera preview video export

`exportCameraPathVideo` snapshots and validates a saved camera path, renders every sample with `SceneEngine.beginFrameCapture`, and encodes H.264 into an MP4 using browser WebCodecs and Mediabunny. It does not record animation-frame timing. The first supported adapter is the browser encoder, capability-checked on the current device. Unsupported devices receive an actionable error before camera ownership changes.

The output uses a fixed frame, up to 1280 × 720 (720 × 1280 portrait), 30 frames per second, no audio, and a 64 MB delivery limit. Existing moves up to 60 seconds are supported. Every camera sample uses the same interpolation and framing conversion as playback, including speed curves, quaternion rotation, focal length, sensor dimensions and clipping planes. Mixed-aspect moves fit their full changing camera gate into the output frame with black bars.

For an integral duration D, frame timestamps are `i / 30`, with `30 * D` frames. The last frame explicitly samples the saved endpoint at D and holds it for the final frame interval; this includes the endpoint without adding time to the clip. All earlier samples use their actual presentation timestamps. Fractional durations divide the total duration over the rounded-up frame count, quantized to microseconds with no gaps.

A **sequence** passes several shots: `createVideoTimeline` concatenates each shot's own frames (same sampling, endpoints held) with hard cuts and no gaps, reports `shotStarts`, and caps the total at 120 seconds so the file stays under the 64 MB limit at 4 Mbit/s. The output takes the first shot's aspect ratio and fits the rest inside it; the encoder forces a keyframe at every cut, and progress reports which shot is rendering.

Cancellation and failures dispose the encoder, restore the live camera/rendering state, and clear the temporary canvas. Encoding uses memory and creates no partial disk files. The dialog cancels on backgrounding or unmount. Completed video sharing uses `SharingService`, including native cache rollback after failed preparation, removal of unshared files, and existing recipient-access retention after sharing. Preview object URLs release on close; download URLs have a bounded grace period.

When the scene includes attribution, the dialog displays its credit, source and license links, and a description of the rendering changes. The same full text is embedded in both the MP4 description and comment tags so the exported file retains it. The real verifier checks these tags with ffprobe. The library's MPL-2.0 license and pinned source provenance are shipped under `public/licenses/mediabunny-MPL-2.0.txt` and `mediabunny-NOTICE.txt`.

Run the independent end-to-end verifier from the repository root:

```sh
node apps/mobile/scripts/verify-video-export.mjs --output=/absolute/output/directory
```

It requires Chrome (`CHROME_BIN` can override the macOS default), ffmpeg, and ffprobe. `VIDEO_VERIFY_PORT` and `VIDEO_VERIFY_DEBUG_PORT` override its isolated default ports 5175 and 9227. The verifier opens a local SPZ fixture through the real Spark renderer, creates a five-second MP4, checks all 150 decoded frames and metadata, compares five decoded camera samples against independent PNG references (including first/last endpoints, a saved interior waypoint, changing lenses, aspect ratios, and speed curves), and verifies cancellation restores a reusable capture session. The output directory contains the MP4, PNG references, screenshot and `report.json`; temporary Chrome profiles and test processes are cleaned up.

Primary API references: [Spark manual renderer updates](https://sparkjs.dev/docs/spark-renderer/), [Mediabunny writing media](https://mediabunny.dev/guide/writing-media-files), [canvas frame timestamps and backpressure](https://mediabunny.dev/api/CanvasSource), [encoding capability checks](https://mediabunny.dev/api/canEncodeVideo).
