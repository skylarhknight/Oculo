# CLAUDE.md

This file defines the working contract for AI coding agents in Oculo.

## Product invariant

Oculo lets a filmmaker import a relevant captured or generated scene, compose
and save annotated shots on iPhone, and export a shot plan a collaborator can read.

Preserve the MVP loop:

**Import or open scene → compose → save annotated shots → optionally preview a simple move → export and share → reopen the local project**

The revised scope in `docs/MVP.md` is an explicit product decision: local SPZ
import and PDF/JSON export are required; a camera move is optional before sharing.
The one-time `oculo_pro` unlock removes the one-saved-project limit only.
Accounts are optional. iPhone is the release target; preserve Android compatibility
without requiring Android release readiness for iPhone handoff.

## Repository rules

- Use pnpm workspaces; do not add a second package manager or lockfile.
- Keep TypeScript strict and preserve `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and type-only imports.
- Keep the mobile shell in `apps/mobile` and reusable domain/provider code in `packages`.
- `packages/scene-schema` owns versioned persisted domain schemas.
- `packages/camera-core` owns camera math and replaceable path interpolation.
- `packages/scene-core` owns the imperative Three.js/Spark lifecycle and must remain independent from React.
- Domain code must not import React, Capacitor, IndexedDB, RevenueCat, or a world-provider SDK.
- UI code consumes application services and domain types, never provider SDK objects.
- Put browser/native implementations behind ports defined by the application or domain layer.
- Store durable local project state through the persistence repository, not directly from components.
- Use additive IndexedDB migrations; never destroy a user's database as an upgrade strategy.
- Keep every persisted/imported domain schema explicitly versioned; reject or deliberately migrate unsupported versions.
- Confirm the chosen production application ID consistently before release; do not rename an already finalized identifier merely because older documentation calls it a placeholder.
- Treat `oculo_pro` as the canonical RevenueCat entitlement identifier.

## World-provider rules

- `SceneSource`, `CameraPathInterpolator`, camera pose, and scene descriptors are Oculo-owned contracts.
- Use the existing local/demo adapters and implement the planned persistent local-import adapter described in `docs/MVP.md`; local file import does not imply cloud upload.
- Future World Labs support belongs in a separate adapter implementing the same contracts.
- Never leak World Labs request, response, session, scene, or SDK types outside that adapter.
- Map provider failures to Oculo error codes at the boundary.
- Do not silently upload customer scenes, images, project files, telemetry, or derived assets. Upload requires an explicit user action, a clear destination, consent, and visible progress/error state.
- Do not build a custom replacement for World Labs Spark. Integrate Spark through supported APIs/SDKs or use the local adapter.

## Scope rules

`docs/MVP.md` is the scope authority. Its non-goals are intentionally complete for the MVP; do not implement them as opportunistic enhancements. Prefer the smallest vertical slice that advances the fixed loop.

## Commands and verification

```sh
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm cap:sync
```

For ordinary changes, run the narrowest relevant test plus lint/type-check. Before demo or release handoff, run:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

For native changes, also sync Capacitor and verify on the affected physical platform. Never commit `.env` files, signing material, service-account files, secret RevenueCat keys, or generated native build output.

## Documentation discipline

Update the corresponding document when changing:

- boundaries or target layout: `docs/ARCHITECTURE.md`
- MVP behavior or scope: `docs/MVP.md`
- provider contracts or data policy: `docs/WORLD_LABS_INTEGRATION.md`
- native configuration or demo operations: `README.md`

Documentation must distinguish implemented behavior from planned behavior.
