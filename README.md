# Oculo

Oculo is a mobile spatial-cinematography workspace. A filmmaker enters a photorealistic world, scouts it, composes shots with real camera and lens controls, saves them as static shots or moving shots built from keyframes, previews the result, and shares it.

The [Version 1.0 PRD](docs/PRD.md) defines an iPhone shot-planning app: durable SPZ import, saved shots, expanded movement editing, PNG shot sheets and supported MP4 previews. Free includes one saved project; the one-time Oculo Pro unlock adds projects. See [implementation alignment](docs/PRD_ALIGNMENT.md) for completed code and remaining device acceptance, and [architecture](docs/ARCHITECTURE.md).

Accounts and cloud sync are disabled unless you provide Firebase environment values, and purchases are disabled unless you provide RevenueCat configuration. Local importing, editing and exports work without either.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/01-scene-gallery.png" width="200" alt="Scene gallery with bundled scenes and an import option"><br><sub>Pick a bundled scene or import your own <code>.spz</code></sub></td>
    <td align="center"><img src="docs/screenshots/02-compose-pantheon.png" width="200" alt="Composing a shot in the Pantheon with lens controls"><br><sub>Frame a shot with real lens controls</sub></td>
    <td align="center"><img src="docs/screenshots/03-moving-shot-keyframes.png" width="200" alt="A moving shot with a keyframe timeline on Perseverance Rover"><br><sub>Plan a camera move with keyframes</sub></td>
    <td align="center"><img src="docs/screenshots/04-map-view-iss.png" width="200" alt="Top-down map view of the International Space Station"><br><sub>Map view with the cinematographer figure</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/05-shots-storyboard-iss.png" width="200" alt="Storyboard of saved shots with camera positions on the scene"><br><sub>Saved shots as a storyboard</sub></td>
    <td align="center"><img src="docs/screenshots/06-export-shot-plan.png" width="200" alt="Export screen with the Shot plan option"><br><sub>Export a printable shot plan</sub></td>
    <td align="center"><img src="docs/screenshots/07-compose-perseverance.png" width="200" alt="Composing a close-up on Perseverance Rover"><br><sub>Compose with focal length and focus</sub></td>
    <td align="center"><img src="docs/screenshots/08-export-iss.png" width="200" alt="Export screen for a shot of the International Space Station"><br><sub>Shot plan, video and data exports</sub></td>
  </tr>
</table>

## Prerequisites

- Node.js 22 or newer
- pnpm 11.21.0 (the version declared in `package.json`)
- For iOS: macOS, Xcode 26+, and either the iOS Simulator or an iPhone. Capacitor uses Swift Package Manager; CocoaPods is not required. The simulator needs no paid Apple developer account.
- For Android: current Android Studio, Android SDK/platform tools, its bundled Java 21 runtime, and a physical Android device

Enable the pinned package manager, then install dependencies:

```sh
corepack enable
pnpm install
```

## Common commands

```sh
pnpm dev          # start the mobile web development server
pnpm build        # build all workspace packages
pnpm lint         # lint the repository
pnpm typecheck    # type-check all workspace packages
pnpm test         # run tests once
pnpm format       # format the repository
pnpm cap:sync     # build and sync web assets/plugins into iOS and Android
```

Run all quality checks before handing off a change:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Environment

Create the mobile app's local environment file from its checked-in example. Never commit API keys.

```sh
cp apps/mobile/.env.example apps/mobile/.env.local
```

Optional Firebase variables enable accounts (Google, Apple, email) and cloud project sync; leave them empty to run fully local. See [`docs/FIREBASE.md`](docs/FIREBASE.md) for setup:

```dotenv
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...
```

## Try the purchase flow with the RevenueCat Test Store

Oculo Pro is a single non-consumable purchase that lifts the one-saved-project limit. You can exercise the real RevenueCat purchase flow with no card and no Apple or Google account by using a RevenueCat Test Store.

1. In [RevenueCat](https://app.revenuecat.com), create a project and open **Apps and providers** to create a **Test Store**. Copy its public SDK key (it starts with `test_`).
2. Under **Product catalog**, create a Test Store product with identifier `oculo_pro_lifetime` (non-consumable), attach it to an entitlement named `oculo_pro`, and add it to an offering named `default` as a package with identifier `Oculo_Pro_Lifetime`.
3. Set these values in `apps/mobile/.env.local` (use your own HTTPS privacy, terms and support pages; the purchase UI stays disabled without them):

   ```dotenv
   VITE_REVENUECAT_IOS_API_KEY=test_...
   VITE_REVENUECAT_OFFERING_ID=default
   VITE_REVENUECAT_PRO_PACKAGE_ID=Oculo_Pro_Lifetime
   VITE_REVENUECAT_IOS_PRO_PRODUCT_ID=oculo_pro_lifetime
   VITE_REVENUECAT_MOCK=false
   VITE_PRIVACY_POLICY_URL=https://...
   VITE_TERMS_URL=https://...
   VITE_SUPPORT_URL=https://...
   ```

4. Test Store keys only work in development builds. Build one and sync it to iOS (do not run `pnpm cap:sync` afterwards, because it rebuilds a production bundle that rejects Test Store keys):

   ```sh
   pnpm build
   pnpm --filter @oculo/mobile exec env NODE_ENV=development vite build --mode development
   pnpm --filter @oculo/mobile exec cap sync ios
   ```

5. Open the project in Xcode (`pnpm --filter @oculo/mobile exec cap open ios`), run the Debug configuration on a simulator, create a project, try to create a second one to reach the paywall, and complete the purchase from the Test Store dialog. The second project then unlocks.

Never put a RevenueCat secret key in `VITE_*` variables, source code or native resources. Production releases use platform-specific public SDK keys and a real store product that grants the `oculo_pro` entitlement.

## Run on native devices

After installing dependencies and configuring environment variables:

```sh
pnpm cap:sync
pnpm --filter @oculo/mobile exec cap open ios
pnpm --filter @oculo/mobile exec cap open android
```

In Xcode, select the app target, choose a simulator (or set a development team for a physical iPhone), and press Run. Trust the developer certificate on the phone if prompted. The checked-in bundle identifier is an example; choose your own before distributing.

In Android Studio, let Gradle sync, confirm `applicationId`, enable USB debugging on the phone, select the connected device, and press Run. `adb devices` can verify that the device is authorized.

Native RevenueCat keys are compiled into the web bundle. After changing an environment variable, rebuild and sync again.

## Product and integration guarantees

- Oculo owns navigation, camera intent, shot and move data, persistence, and UI.
- World providers stay behind adapters; provider SDK types never enter domain or UI code.
- Local-first project state is stored in IndexedDB.
- Oculo does not silently upload customer scenes or project data.
- Oculo does not build a custom replacement for World Labs Spark.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — repository rules for coding agents
- [`docs/SCENE_CONTRACTS.md`](docs/SCENE_CONTRACTS.md) — implemented Phase 4A contracts and migration limitations
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — boundaries, target layout, and local persistence
- [`docs/MVP.md`](docs/MVP.md) — revised Phase 1–14 checklist, Pro boundary, and deferred scope
- [`docs/WORLD_LABS_INTEGRATION.md`](docs/WORLD_LABS_INTEGRATION.md) — current and future provider adapters
- [`docs/FIREBASE.md`](docs/FIREBASE.md) — accounts, cloud project sync, and Firebase setup

## Third-party notices

Third-party components and assets keep their own licenses and notices; see `apps/mobile/public/licenses/` and each scene's `ATTRIBUTION.txt` under `apps/mobile/public/scenes/`.

## License

Licensed under the [MIT License](LICENSE). Third-party components keep their own licenses, as described above.
