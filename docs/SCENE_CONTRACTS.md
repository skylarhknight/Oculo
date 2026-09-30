# Scene and camera contracts — Phase 4A

Phase 4A is implemented in the shared schema/camera packages, project store, and
viewer. Native Files copying/relink UI, PDF generation, and the export/share UI
remain in Phases 4B–4.5. The JSON serializer is available as a service function;
there is no new export button in this phase.

## Identity and version rules

A project, each saved shot, and its path carry `sceneId` and `assetVersionId`.
`SceneDescriptor.id` identifies the scene; `asset.versionId` identifies a version.
A filename or URL never supplies identity for newly created assets.

`createAssetVersion(originalBytes, metadata)` generates an opaque UUID, computes
SHA-256, and records byte size and explicit format/version without mutating bytes.
It does not parse SPZ, copy files, or infer a format version. The importer must
validate encoding and durably copy those same original bytes in Phase 4.5.

Asset locators are either a validated app-managed relative path, a remote HTTP(S)
URL, or unavailable. Absolute/temporary native paths and blob URLs are not local
locators. `resolveSceneBytes` uses a runtime resolver, verifies known byte size and
SHA-256 before passing bytes to Spark, and rejects a mismatch instead of silently
loading changed content. The future native adapter supplies access to local files.
Resolved URLs are never written back into project state.

IndexedDB schema 5 preserves `sceneBindings`, `shotImages`, and `sceneAssets` from
both historical branch layouts without dropping stores or records. Saves
atomically register content signatures and coordinate bindings. Reusing a version
with different content metadata is rejected across scenes. Rebinding an existing
project to another version, transform, or metric scale is rejected: create a new
version and project instead. Verified locator relocation is allowed. For an
unverified historical scene, changing its locator requires a new version because
there is no digest with which to establish equivalence.

## Coordinate and camera conventions

- Right-handed canonical space, +Y up, camera forward along local -Z.
- Quaternion component order `[x, y, z, w]`; nonzero quaternions are normalized by
  the renderer/interpolator. Persistence preserves the supplied numeric values.
- Camera positions and near/far planes use scene units; focal length and sensor
  dimensions use millimeters; keyframe time uses seconds.
- `assetToScene` is translation, quaternion rotation, and positive XYZ scale,
  composed as T × R × S. Apply it to the splat object, not saved camera poses.
- `sourceCoordinates` records the source convention and conversion description
  when known. Unknown is null; the actual conversion remains the explicit transform.
- `metricScale` is unknown or carries positive `metersPerSceneUnit` plus source
  metadata/calibration evidence. Legacy `metricScaleFactor` was used as movement
  gain and is not trusted as physical calibration. It remains in local legacy
  metadata for recovery. The HUD does not label scene Y as physical camera height.
- Magic Window's translation gain is independent of metric scale. Gain 1 does not
  claim life-size geometry.

`camera.output` stores aspect ratio and the `center-inside-sensor` crop policy.
Use the largest centered rectangle contained in the physical sensor with the
requested output aspect. Its effective height H and focal length f give vertical
FOV = 2 atan(H / (2f)). A 36 × 24 mm sensor at 16:9 uses a 36 × 20.25 mm rectangle.
Changing output aspect does not change the recorded physical sensor dimensions.

The viewer fits that full frame into the available viewport with letterboxing;
the engine retains the output aspect across resize. Thumbnail capture renders the
saved camera state and the same framed canvas. Pixel dimensions may round to the
nearest integer; no scene content is cropped to fill a differently shaped phone.
Camera paths preserve and interpolate output aspect as well as lens/sensor values,
pose and clipping values. Keyframe times must increase and fit project duration.

## Migration and unknown data

Domain persistence envelopes and projects now use version 2. Envelopes 0/1 and
project version 1 migrate explicitly; unsupported future versions fail validation
and remain untouched. Existing records migrate on read and are written in version
2 on the next explicit save. No database reset is performed.

Legacy projects get deterministic project-scoped version IDs. Old poses, notes,
images, timing and lens values are retained. Old splat rotation becomes the
asset-to-scene rotation, other transform components default to identity, and source
coordinates/provenance/fingerprint/byte size remain unknown. Historical remote
samples are correctly labeled remote. A dead blob locator becomes unavailable.

Old output aspect is inferred from the recorded sensor ratio. Legacy thumbnails
are retained, but their original viewport/crop was never stored, so exact recovery
of their old visual framing cannot be guaranteed. Old remote samples without a
fingerprint remain explicitly unverified; a provider changing those bytes cannot
be detected until a verified version is created.

## Portable JSON and privacy

`stringifyShotPlan(project)` creates version 2 `OculoShotPlan` JSON;
`parseShotPlan` validates it. It preserves identity, content fingerprint, format,
size, provenance, transforms, scale status, camera intrinsics/output, shots/notes,
clipping planes and path timing. No account or provider call is involved.

The export allowlist omits all asset locators, legacy URLs and thumbnail data URLs.
Absolute paths and URL-like text embedded in source labels are omitted. A standalone
public HTTP(S) attribution URL is retained after credentials, fragments and sensitive
query parameters are removed. User-authored project/shot names and notes are
intentional share content; the serializer is not a general-purpose secret scanner
for arbitrary text someone writes there. Original local metadata is unchanged.

JSON is a metadata interchange format, not a source-splat bundle, PDF, or a promise
of compatibility with an external editor. It cannot reconstruct absent geometry.
Cloud project sync separately omits native relative locators. When applying newer
remote metadata to an existing local project, the sync layer retains its local
locator; scene-binding validation still rejects content/coordinate changes.

## Validation

Automated tests cover legacy schema/database migration, retained original records,
version-reference agreement, SHA-256 and changed bytes, immutable bindings,
verified relocation, unsafe paths, source metadata redaction, JSON numeric/timing
round-trips, and output crop/FOV across viewport orientations. Physical iPhone
framing, backgrounding, file access, and device limits remain release checks.

## Shot-sheet branch compatibility

The older shot-sheet branch also wrote project schema 2, using URL-based scenes
and `camera.outputAspectRatio`. The reader recognizes that historical shape and
migrates it to asset references and `camera.output`, retaining speed curves,
shot-sheet selection, attribution, local SPZ references, and saved camera crops.
Local storage recovers separated images using their original exact signatures.
Canonical version-2 records continue to validate strictly, including immutable
scene bindings. Imported bytes and bundled starter bytes are fingerprinted;
unverified historical assets remain explicitly unknown.
