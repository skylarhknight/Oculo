# World Labs integration

## Intent

Oculo is the filmmaking workflow; a world provider supplies worlds and spatial viewing capabilities. The product must remain usable and testable without a specific provider SDK.

## Today

- Three.js + World Labs Spark is the scene renderer.
- Oculo owns provider-neutral camera state.
- Oculo owns the minimal `CameraPathInterpolator`.
- `BundledSceneSource` and `UrlSceneSource` resolve current scenes.
- Small Garden by scbenoit is packaged locally as SOG under CC BY 4.0. The
  catalog selects it first; other Spark examples are labeled online. Asset
  provenance and redistribution credit are recorded in
  [ATTRIBUTION.txt](../apps/mobile/public/scenes/small-garden/ATTRIBUTION.txt).
- `SceneDescriptor.attribution` carries optional credit, source URL, license,
  and license URL. Catalog credits and PNG shot-sheet metadata preserve it.
- Local SPZ v2/v3 imports store validated scene bytes on the device with an explicit
  file selection. The renderer continues to use supported Spark decoding APIs.
- A local MP4 preview branch renders saved camera paths through Spark and encodes
  H.264 with a replaceable WebCodecs adapter; it calls no generation service.
- A free shot-sheet branch generates and shares saved reference images locally;
  it does not require a World Labs API, scene reload, move, or account.
- A project may hold several scenes (project schema 4, where each shot owns its keyframes). Each project scene carries
  its own `SceneDescriptor`, so a future World Labs world is added as one more scene
  in an existing project; provider types still stop at the adapter boundary.
- Viewport overlays (shot frustums and the path of the shot being edited) are Oculo-owned
  Three.js objects added beside Spark; they never modify Spark internals and are
  excluded from every capture.

Bundling and adapters are implemented. Small Garden's first-frame appearance,
loading, memory, and performance still need physical-device verification. A
native build alone does not prove the spatial workflow is usable on the device.

## Planned local imports

The revised [MVP checklist](MVP.md) requires a user-facing SPZ import flow.
Implement it behind Oculo-owned services: validate and copy bytes to durable
local storage, assign stable scene/asset-version identity, and record source
provenance, coordinate conversion, and metric-scale status. Loading these assets
through Spark does not require a World Labs account or an API upload. Existing
local/demo adapters remain available. PDF/JSON export is provider-independent.

Phase 4A identity/transform/provenance contracts and runtime byte verification are implemented; see [SCENE_CONTRACTS.md](SCENE_CONTRACTS.md). Native file copying and the import/export UI remain planned.
Atlas or future World Labs camera tooling is not a release dependency.

## Future

- A World Labs scene/API adapter can implement `SceneSource`.
- A World Labs camera interaction adapter can replace navigation behind an Oculo interface.
- A World Labs spline/path adapter can implement `CameraPathInterpolator`.
- Collider, metric scale, and ground-plane metadata can populate `SceneDescriptor`.
- A future developer SDK can be integrated inside these adapters.

None of these integrations may leak World Labs-specific types into product domain models,
React component props, persisted schemas, or cross-package interfaces.

Oculo does not build a custom replacement for World Labs Spark.

## Oculo-owned contract

The implemented source contract is deliberately small:

```ts
interface SceneSource {
  load(signal?: AbortSignal): Promise<SceneDescriptor>;
}
```

`SceneDescriptor` contains a stable ID/name, asset reference, optional asset
rotation and initial camera pose, optional collider/scale/ground-plane metadata,
optional attribution, and source kind. `CameraState` owns position, quaternion,
vertical field of view, output aspect, and clipping distances. The independent
`CameraPathInterpolator` owns move interpolation. Provider SDK objects never
form part of these contracts.

The following larger session/capability abstraction is a **future design sketch**,
not an implemented World Labs API or current app service:

```ts
type WorldId = string;

interface WorldDescriptor {
  id: WorldId;
  title: string;
  thumbnailUrl?: string;
  attribution?: string;
  availability: "local" | "remote";
}

interface WorldSession {
  world: WorldDescriptor;
  capabilities: {
    navigation: boolean;
    cameraControl: boolean;
    movePreview: boolean;
  };
}

interface WorldProvider {
  listWorlds(signal?: AbortSignal): Promise<WorldDescriptor[]>;
  enterWorld(id: WorldId, signal?: AbortSignal): Promise<WorldSession>;
  leaveWorld(): Promise<void>;
  setCamera(camera: CameraState): Promise<void>;
  previewMove(move: CameraMove, signal?: AbortSignal): Promise<void>;
}
```

These are illustrative Oculo types; finalize them only when supported
provider operations require them. Domain/application packages own production
contracts. An adapter may use an internal SDK representation but returns only
Oculo values.

## Current scene-source adapters

The app catalog owns the configured scene manifest. `BundledSceneSource` validates
an already supplied descriptor; `UrlSceneSource` fetches and validates descriptor
JSON with cancellation support. Neither adapter scans locations, generates
worlds, authenticates to World Labs, or returns a capability/session object.
`SceneEngine` loads the referenced asset through Spark, while camera math and
saved-shot move playback remain Oculo-owned.

Output aspect is independent of the viewer dimensions and sensor crop. Capture
returns the live camera and its rendered image together; current saved references
have a maximum edge of 480 pixels. PNG pages contain those saved images at their
own aspect, camera labels, names/notes, and optional valid-move information.
They are digital planning references, not production-resolution stills. Short
MP4 camera-move previews are a separate local export flow. Focus/aperture simulation and guaranteed metric measurements are deferred.

The bundled starter supplies an asset path present in native web assets and can
be loaded without a network. The scene gallery (`config/sceneCatalog.ts`, built from
`sceneCatalog.generated.json` by `pnpm scenes:build`) adds bundled scenes with local
locators and download scenes with remote locators under `VITE_SCENE_GALLERY_BASE_URL`.
Both kinds go through `BundledSceneSource` with a pinned fingerprint. `source: "bundled"` alone does not guarantee offline
availability: the older configured demos still reference remote URLs. A browser
still needs the app/assets served; arbitrary offline website caching is not
implemented. The local adapter remains a fallback and requires no credentials.

Future adapters should share source-contract tests with the current adapters.
They must not pretend to call World Labs, copy private provider behavior, or
evolve into a custom Spark implementation.

## Future: World Labs adapters

Add future integrations behind the existing interfaces. Their responsibilities are:

1. Authenticate/configure the supported client without exposing credentials.
2. List or resolve only worlds the user is authorized to access.
3. Translate World Labs world metadata into `WorldDescriptor`.
4. Translate Oculo camera commands into supported provider operations.
5. Translate provider session/lifecycle events into `WorldSession` and Oculo errors.
6. Cancel outstanding work on route change, world change, or app backgrounding.
7. Dispose provider resources when leaving a world.
8. Log provider request IDs and coarse timing only when permitted, without customer scene content.

If Spark lacks a capability required by Oculo, expose the limitation through
an app-owned result or future capability contract and adjust the UI. Do not
emulate a proprietary world engine or fork product logic around leaked SDK details.

## No provider type leakage

The following must remain private to the World Labs adapter:

- SDK clients and configuration objects
- request/response DTOs
- provider IDs that are not explicitly wrapped/mapped
- scene, session, camera, vector, matrix, event, and error classes
- provider enums, promises, callbacks, and observables
- provider credentials, private request URLs, tokens, handles, and lifecycle objects

Do not export them, persist them, place them in global state, pass them as
component props, or include them in application use-case signatures. Validated
asset/source/license URLs in an Oculo descriptor are owned serializable
references, not provider sessions or credentials. Convert vectors/matrices to
Oculo primitives and documented units at the boundary; absent calibration,
retain scene units. Preserve opaque provider identifiers only in an adapter-owned
locator record when reconnection requires them.

Use compile-time dependency rules and contract tests to enforce this boundary. UI and domain tests must run without installing or initializing the provider SDK.

## Error mapping

For a future World Labs integration, map provider failures to stable Oculo
categories such as:

- `unauthorized`
- `not-found`
- `network-unavailable`
- `rate-limited`
- `unsupported-capability`
- `provider-unavailable`
- `cancelled`
- `unknown`

User-facing copy and retry behavior are selected outside the adapter. Keep provider diagnostics as an optional adapter-owned cause for development logs; never require UI code to inspect a provider error.

## Data and consent policy

Oculo must never silently upload customer scenes, images, projects, shot lists, camera moves, or derived assets.

Two implemented transfer flows have explicit boundaries:

- Optional Firebase backup sends project metadata and available reference images
  under the chosen account. Existing local projects require selected-project
  backup consent; new signed-in projects sync under the behavior disclosed before
  sign-in. Missing/omitted thumbnails on another device require exclusion or
  recapture. Scene assets, media-store keys, and device-local paths are not uploaded;
  known bundled starter references can be carried as metadata. See
  [FIREBASE.md](FIREBASE.md).
- Shot-sheet generation and file preparation happen locally. A Share click passes
  generated PNGs or MP4 previews to the native/browser destination selected by the user; downloads
  save individual pages. Share/Filesystem adapters keep native files in app cache
  for 24 hours after the latest handoff attempt, cleaning expired inactive batches
  during later preparation. This is retention policy, not guaranteed recipient
  access or an exact deletion timer. Recipient applications control their copies.

Local SPZ imports remain on this device and their projects are excluded from
Firebase backup selection. Stored references are versioned; temporary URLs are
owned and released by the viewer. No import action implies transfer consent.

Neither flow sends content to a World Labs generation service or includes the
underlying splat asset. Sharing a derived image must preserve its required source
credit. No content telemetry or automatic provider upload is implemented.

The bundled starter and OFL font files load locally. Explicit online demo choices
request static assets from their hosts; those hosts receive ordinary network
request information. Scene-gallery downloads are read-only too: a download scene
is fetched only after the user taps its card, with visible progress, Cancel and
Retry. Its bytes are checked against the SHA-256 pinned in the build and kept in
the device-local `galleryAssets` store. Nothing is sent to the host beyond the
request itself. The host is a public Hugging Face dataset that a developer publishes
with `pnpm scenes:upload`; it holds only the licensed gallery scenes, never user
projects, imports or telemetry. A configured RevenueCat SDK can contact its service before
the paywall opens. Account deletion requests server-side cleanup of the linked
RevenueCat UID after Firebase Auth deletion; that worker is implemented but not
deployed or provider-verified. It sends an identifier, not scene/project content.
OS-managed device backups and recipient copies have their own retention behavior.
See the data inventory in [DATA_FLOWS.md](DATA_FLOWS.md) and [Firebase semantics](FIREBASE.md)
for the exact release configuration and outstanding verification.

Any additional operation sending customer content to World Labs or another
service must:

1. begin from an explicit user action;
2. identify what will be sent and to which provider;
3. explain why it is required;
4. request consent before transfer;
5. show progress and allow cancellation where the API supports it;
6. show success or actionable failure;
7. document retention/deletion behavior;
8. avoid retrying in the background after consent context has ended.

Listing provider-hosted worlds or loading a world the user explicitly selected is not permission to upload local content. Telemetry must exclude scene content and customer-authored project data by default.

## Configuration

Provider configuration should be injected at the app composition root. Public client configuration may use build-time environment variables; secrets must not ship in the app bundle. If World Labs requires a secret, signed request, or token exchange, introduce a minimal backend before enabling the integration—do not embed the secret in Capacitor web assets.

## Adapter readiness checklist

- [ ] Official supported API/SDK and license reviewed
- [ ] Required capability mapping validated with World Labs
- [ ] Authentication flow works without bundled secrets
- [ ] Oculo contracts finalized before SDK types are introduced
- [ ] Contract test suite passes for local and World Labs adapters
- [ ] Capability degradation has visible UI behavior
- [ ] Cancellation, cleanup, offline, and rate-limit cases tested
- [ ] Data-flow/consent copy reviewed
- [ ] No silent customer scene upload path exists
- [ ] No custom Spark replacement code exists
