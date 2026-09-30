# Firebase accounts and project sync

This document covers the implemented Firebase integration: optional sign-in
(Google, Apple, email + password) and per-user Firestore sync of project
documents, including available shot reference images. Signing in is never
required. Source-level behavior and automated tests are implemented; configured
provider flows, production rules, and physical-device checks are separate
release requirements.

## Projects and environments

Use two Firebase projects so development never touches customer data:

| Alias  | Project ID              | Used for                                       |
| ------ | ----------------------- | ---------------------------------------------- |
| `dev`  | `your-firebase-development-project` | local development, simulators, internal builds |
| `prod` | `your-firebase-production-project`        | TestFlight/production builds                   |

`.firebaserc` declares both aliases. Deploy security rules with:

```sh
firebase deploy --only firestore:rules --project dev
firebase deploy --only firestore:rules --project prod
```

The framing update writes project schema version 2. The checked-in rules accept
versions 1 and 2; deploy these rules before distributing that build to signed-in
users. Older deployed rules accepting only version 1 reject cloud writes from
the new build, while local saves continue to work. This code change does not
deploy rules. Upgrade devices sharing an account together: older app builds
cannot read version 2 records. Current code rejects invalid/newer records without
treating them as remote deletion, protects racing local edits, and provides
explicit keep-both conflict recovery. Validate configured-account and cross-device
behavior before release; this document does not claim rules were deployed.

## One-time console setup (per project)

- [ ] Create the Firebase project (no Google Analytics required)
- [ ] Add a **Web app**; copy its config values into `apps/mobile/.env.local`
- [ ] Add an **iOS app** with the final bundle identifier; download `GoogleService-Info.plist`
- [ ] Add an **Android app** with the final application ID; download `google-services.json`
- [ ] Enable **Authentication** providers: Google, Apple, Email/Password
- [ ] For Apple sign-in, configure the Sign in with Apple key/service in the Apple Developer portal and paste it into the Firebase Apple provider settings
- [ ] Enable **Cloud Firestore** (production mode) and deploy `firestore.rules`
- [ ] Add the web app's domains (and `localhost`) to Authentication → Authorized domains

The bundle identifier is currently the placeholder `org.example.oculo.student`.
Apple sign-in services, Google OAuth clients, and the Firebase iOS app all
bind to it — finalize the identifier before configuring the prod project.

## Environment variables

The Firebase web config is public (identifiers, not secrets), but it is still
kept out of the repository. In `apps/mobile/.env.local`:

```dotenv
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=your-firebase-development-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-firebase-development-project
VITE_FIREBASE_APP_ID=1:...:web:...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_STORAGE_BUCKET=your-firebase-development-project.firebasestorage.app
```

When `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`, or
`VITE_FIREBASE_APP_ID` is empty, `getFirebaseApp()` returns `null`, the
composition root selects the plain IndexedDB store plus a no-op auth service,
and the account sheet reports that accounts are unavailable.

Native Firebase configuration is separate from these web values. Capacitor
includes the native auth plugin only when its platform file exists at sync time:

- iOS: `apps/mobile/ios/App/App/GoogleService-Info.plist`
- Android: `apps/mobile/android/app/google-services.json`

Without that file the native plugin is excluded, and the JS auth factory also
reports unavailable when `FirebaseAuthentication` is missing. This prevents an
unconfigured plugin from attempting Firebase initialization at app startup;
setting web variables alone does not enable native sign-in.

Values are compiled into the web bundle; run `pnpm cap:sync` after changing
them for native builds.

The initial unconfigured iOS build exposed a Firebase startup crash. After the
per-platform guard and native rebuild, the iOS simulator launches, captures,
reopens saved projects, and shares PNG pages successfully. Android emulator
startup logs also show local assets loading without a fatal app exception;
its full UI walkthrough and both physical platforms remain acceptance gates.

## iOS native configuration

Native sign-in uses `@capacitor-firebase/authentication` (configured in
`apps/mobile/capacitor.config.ts`). The config enables Capacitor's SwiftPM
symlink option for this plugin to avoid package-identity collisions. After
placing `GoogleService-Info.plist` at the path above, run `pnpm cap:sync`, then:

- [ ] Add `GoogleService-Info.plist` to the Xcode `App` target (File → Add Files, ensure target membership)
- [ ] Add the **Sign in with Apple** capability to the App target
- [ ] Add the Google reversed client ID (from `GoogleService-Info.plist`, key `REVERSED_CLIENT_ID`) as a URL scheme in Info → URL Types
- [ ] Build and verify Google, Apple, and email sign-in on a physical device

Credential flow: the plugin performs the native sign-in, then the credential
is bridged into the Firebase JS SDK (`signInWithCredential`) so one JS-side
auth state serves both Authentication and Firestore. Apple sign-in uses
`skipNativeAuth: true` at the call site because Apple credentials are
single-use.

## Android native configuration

`apps/mobile/android/variables.gradle` enables the plugin's Google support
with `rgcfaIncludeGoogle` and AndroidX Credentials 1.3.0. After registering the
Android application in Firebase:

- [ ] Add `google-services.json` to `apps/mobile/android/app`
- [ ] Add the debug signing certificate's SHA-1 and SHA-256 fingerprints to
      the Firebase Android app, then download an updated configuration file
- [ ] For Play-distributed builds, also register the Google Play App Signing
      certificate fingerprints
- [ ] Run `pnpm cap:sync`, open Android Studio, and verify Google, Apple, and
      email sign-in on a physical device

## Architecture boundaries

- `AuthService` (`apps/mobile/src/services/AuthService.ts`) is the
  Oculo-owned port. UI consumes `AuthUser`, `AuthState`, and `AuthError`
  codes only; Firebase types never leave the adapter.
- `CloudProjectRepository` (`apps/mobile/src/store/CloudProjectRepository.ts`)
  owns all Firestore access at `users/{uid}/projects/{projectId}` and maps
  Firestore failures to Oculo error codes.
- `SyncedProjectStore` (`apps/mobile/src/store/SyncedProjectStore.ts`) wraps
  the IndexedDB store behind the unchanged `ProjectStore` port.

## Sync semantics

- Local IndexedDB is the source of truth; every write lands locally first.
- IndexedDB schema v3 preserves `projects` and `syncMeta`, and adds a durable
  `shotImages` store. Sync metadata tracks revisions, `dirty`, tombstoned
  deletions, `ownerUid`, and `lastSyncedAt`.
- `setUser(uid)` resumes that account's already-owned projects and pulls
  remote-only projects. It does not adopt existing local work. New projects
  created while signed in are linked to that account, as disclosed in the UI.
- **Back up selected projects** is the consent boundary for existing unowned
  projects. The account panel shows the Firebase destination/current account,
  shot/missing-image counts, omission limits, progress, errors, and retry.
  Nothing is selected initially. Legacy records whose previous owner is unknown
  require explicit IDs; known-other-account projects are not offered or transferred.
- `updatedAt` orders remote revisions, but a newer cloud version cannot replace
  dirty local edits. It reports a conflict. **Keep both projects** atomically
  creates a new local project with the local images, installs the remote version
  under the original ID, and then backs up the copy. This upload is disclosed by
  the action. A failed upload leaves both local versions available for retry.
- Local revision checks prevent remote application or push acknowledgment from
  overwriting/marking clean a racing edit. Session invalidation rejects stale
  responses after account changes; cloud operations do not hold local writes open.
- Complete cloud lists are validated before changes. Invalid, duplicate, or
  newer-schema data fails the sync visibly rather than looking like a deletion.
- A clean, previously synced project missing from a valid remote list is removed
  locally only for the matching owner and unchanged revision. Dirty local work
  is retained/pushed. Local tombstones propagate intentional deletion.
- Offline edits queue as dirty records and flush when connectivity returns.
- Projects above a 900,000-byte UTF-8 serialized budget upload without shot
  thumbnails (`sanitizeProjectForCloud`). If metadata alone exceeds the budget,
  backup fails visibly and the complete project remains local.
- Cloud serialization allows validated metadata and supported embedded image
  data URLs. Device-local asset paths are rejected, except exact known references
  to the bundled starter; no bundled asset bytes are uploaded.

### Local images and another device

The local image store associates each frame with project/shot IDs and an exact
scene/camera signature. Reads hydrate `thumbnailDataUrl` for UI use; legacy
embedded images migrate additively. A metadata-only cloud update preserves a
matching local image, while a changed scene/camera cannot inherit an outdated
frame. Intentional deletion cleans only unreferenced media.

A fresh device cannot recover an image omitted from the cloud document. The shot
sheet displays **Frame unavailable on this device** and offers exclusion or
recapture when the scene is available. Recapture retains the saved camera and
replaces only the reference image. This is project backup with conditional image
coverage, not full media/scene backup, and Firebase Storage is not a media pipeline.

### Sign-out and account changes

Sign-out quiesces sync before ending authentication and retains local projects,
images, owner IDs, dirty revisions, and tombstones. If authentication sign-out
fails, the app rebinds sync to the still-current account and displays the error.
Another signed-in account can see retained local work, but cannot silently
upload or adopt projects already owned by someone else. Switching accounts
clears the account panel's selections and pending consent UI.

## Account deletion

Account deletion is available in the account sheet. After reauthentication, the
app drains RevenueCat identity work and switches to an anonymous purchase
identity, quiesces sync, and deletes cloud projects while the session is valid.
Apple access is revoked when an Apple identity is linked, then the Firebase user
is deleted. Account identity guards reject a replacement session across awaited
operations. If deletion fails while the same account remains, billing identity
is restored. Once cloud deletion starts, sync stays quiesced to avoid recreating
removed backups during a retry. Local projects, images, and ownership history
are retained; they do not become automatically adoptable by another account.

`apps/account-functions` implements a server-only, first-generation Firebase Auth
deletion trigger that requests RevenueCat customer deletion for the event's UID.
It uses `REVENUECAT_SECRET_API_KEY` from Secret Manager, retries failures, and
redacts identifiers, credentials, and response bodies from logs. HTTP 200 means
the asynchronous provider request was accepted; 404 means the customer is absent.
Neither the app receipt nor an accepted request proves final provider erasure.
The account UI explains processing and links to store subscription management:
account deletion does not cancel an Apple/Google subscription.

**Not deployed or provider-verified.** Follow the
[server deployment and recovery runbook](../apps/account-functions/README.md)
before enabling accounts in a release. Configure failure alerts and reconciliation
within Firebase's retry window. Verify aliases and other-device behavior. Do not
use RevenueCat's subscriber GET endpoint to check absence: it can recreate the
customer. Firebase bulk user deletion does not emit the required Auth events.

## RevenueCat identity

On sign-in the purchase adapter calls RevenueCat `logIn` with the Firebase
UID so `oculo_pro` follows the account across devices; sign-out reverts to
an anonymous store identity. Only public platform SDK keys are used.

Entitlement access and a purchasable offer are separate. New purchases require
the exact configured offering/package/platform product mapping and supported
store billing terms. Existing purchases can still be restored in a configured
native build when no new offer is available. Identity/refresh failures are
visible and must not grant mock Pro access in production.

## Privacy

Authorized project backup sends shots, poses, lens values, paths, settings,
selection, attribution, and available reference images under the selected UID.
These thumbnails are imagery. Scene/splat files, local media keys, and ownership
bookkeeping are excluded. Checked-in Firestore rules restrict access to the
authenticated user's subtree; configured deployments must verify those rules.

Before sign-in, the UI discloses automatic sync of newly created signed-in
projects. Existing local work requires the separate selected-project backup
action; conflict-copy upload has its own keep-both action. Sync status/errors and
retry remain visible. These actions do not authorize customer scene upload,
World Labs generation, public publishing, or telemetry.

### Merged contract compatibility

Canonical version-2 projects include scene and asset-version references and a
camera `output` crop. Older URL-based version-2 projects from the shot-sheet
branch migrate explicitly. Cloud transactions reject scene rebinding; local
IndexedDB version 5 preserves both branches' data stores and sync revisions.
Imported scenes remain local. Previously recorded native/service acceptance
results do not certify this merged build.
