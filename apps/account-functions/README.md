# Account cleanup functions

`deleteRevenueCatCustomerAfterAuthDeletion` requests removal of the RevenueCat
customer associated with a deleted Firebase Auth UID. It runs **after Firebase
Auth deletes the account**, including individual administrative deletions. It
does not expose an HTTP or callable endpoint that accepts client-supplied UIDs.

Implementation and local verification are separate from deployment. No function
has been deployed, no secret has been configured, and real provider deletion has
not been verified by adding this package.

## Behavior and integration

The first-generation `auth.user().onDelete` trigger reads only the deleted user's
UID and a bound Secret Manager value, `REVENUECAT_SECRET_API_KEY`. Firebase's
[Auth lifecycle guide](https://firebase.google.com/docs/functions/1st-gen/auth-events)
confirms that second-generation functions do not support this event, and that
bulk Admin SDK `deleteUsers()` skips deletion triggers. Operational deletion
tools must delete users individually or separately reconcile provider cleanup.

The helper sends one request per event delivery:

```text
DELETE https://api.revenuecat.com/v1/subscribers/{encoded-firebase-uid}
Authorization: Bearer <server-secret>
```

The URL is fixed; the UID is encoded as a single path segment. Redirects are
rejected. The request is aborted after 10 seconds; the function has a 30-second
timeout and a maximum of five concurrent instances. The response body is never
parsed or logged.

- HTTP **200** produces `requested`: RevenueCat has accepted its asynchronous
  deletion request. It does not prove final erasure.
- HTTP **404** produces `absent`, allowing repeated event delivery to complete.
- Other statuses, connection failures and timeouts reject the invocation with a
  sanitized error. Logs contain only a fixed message, failure category and
  optional HTTP status; successful acknowledgements contain only the outcome.
  Application logs omit UIDs, email, secrets, URLs and provider payloads.

These semantics follow the [RevenueCat customer API](https://www.revenuecat.com/docs/api-v1/customers).
Do not verify erasure using `GET /subscribers/{uid}`: that API can recreate a
missing customer. Use provider dashboard/operator evidence instead.

The mobile account-deletion flow must finish detaching its RevenueCat SDK identity
before deleting Firebase Auth. Otherwise, subsequent SDK activity can recreate
the same provider customer. Other signed-in devices can also retain the old UID
until they observe invalidated authentication. This worker does not remotely
stop SDK sessions, maintain a tombstone, or prevent future re-creation. Test a
second device returning online, including stale tokens and delayed SDK requests,
and reconcile any recreated customer through an authorized operator workflow.
Never claim that sign-out itself deletes RevenueCat data.

Removing the RevenueCat customer does not cancel App Store or Google Play
subscriptions. Keep subscription management available and explain that billing
is managed separately. See [RevenueCat customer deletion](https://www.revenuecat.com/docs/dashboard-and-metrics/customer-profile#delete-customer).
This worker does not replace the app's Firestore/project deletion flow or Apple
token revocation. A separate release check must verify those steps too.

## Local checks and deployment package

Use Node 22 and the repository's pnpm version. [Firebase supports Node 22 and ESM](https://firebase.google.com/docs/functions/manage-functions#set_nodejs_version).

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @oculo/account-functions test
corepack pnpm --filter @oculo/account-functions typecheck
corepack pnpm --filter @oculo/account-functions build
```

Tests mock transport and secrets. They do not call RevenueCat or Firebase.
Root Vitest configuration includes this package's tests. The package has its own
strict Node TypeScript configuration, and production dependencies are declared
directly with exact versions. Its dependency resolution is recorded in the
workspace pnpm lockfile; it has no runtime workspace dependencies.

`firebase.json` defines codebase `account-cleanup`, source
`apps/account-functions`, runtime `nodejs22`, and a predeploy build. That build
emits both `dist/index.js` and `dist/revenueCatDeletion.js`. Firebase uploads these
compiled files and the package manifest, excluding local dependencies, tests,
TypeScript sources/configs and secret files. Cloud Build installs the declared
production dependencies; local helper imports remain inside `dist`.
The empty `gcp-build` script prevents a second TypeScript build against excluded
sources, following [Google's build-script configuration](https://docs.cloud.google.com/docs/buildpacks/nodejs#execute_custom_build_steps_during_deployment).

## Team setup — not performed by this implementation

1. Confirm the Firebase project, billing plan, function region and deploying
   principal. The function currently uses Firebase's default `us-central1`
   region. Do not rely on an unconfirmed repository project alias.
2. Create a RevenueCat **secret** API key for the matching RevenueCat project,
   with permission to delete its customers. Both mobile platform apps must map
   to that project. A public `appl_`/`goog_` SDK key cannot perform this cleanup.
   See [RevenueCat API keys](https://www.revenuecat.com/docs/projects/authentication).
3. Store it in Google Secret Manager using the interactive CLI command below.
   Never put the value in `VITE_*`, app resources, checked-in files, shell command
   arguments, logs, or a client-callable function.
4. Deploy this codebase only after local checks and team authorization.
   Confirm the Auth deletion event, secret binding, Node runtime and retry
   policy in the deployed configuration. Secret rotation requires redeployment.

```sh
firebase functions:secrets:set REVENUECAT_SECRET_API_KEY --project YOUR_CONFIRMED_PROJECT_ID
firebase deploy --only functions:account-cleanup --project YOUR_CONFIRMED_PROJECT_ID
```

These commands are setup instructions, not actions already taken. Follow
[Firebase's Secret Manager setup](https://firebase.google.com/docs/functions/config-env#secret_parameters)
for access control and rotation. The Functions emulator can access production
secrets through ambient credentials; use isolated test projects and explicit
local secret overrides when exercising it. `.secret.local` is ignored, and no
such file is included here.

## Monitoring and real verification still required

`failurePolicy: true` keeps unsuccessful delivery pending. Firebase v1 retries
with backoff for up to seven days. Timeouts, rate limits and temporary provider
failures can recover automatically. Invalid credentials or other persistent
rejections also remain failed deliveries so cleanup is not silently dropped;
operators must fix their cause promptly. The platform eventually expires failed
events. There is no independent durable completion ledger in this small worker.
See [Firebase retry behavior](https://firebase.google.com/docs/functions/retries).

Before release, configure alerts on `RevenueCat account cleanup pending`,
invocation errors and exhausted/aging retries. Monitor the `configuration`,
`provider-rejected`, `rate-limited`, `provider-unavailable`, `network`, `timeout`
and `unexpected` categories without adding personal data to logs. Document how
an authorized operator reconciles unresolved requests after the retry window;
an error count is not proof that every deletion completed.

Verify with disposable accounts in the confirmed test Firebase/RevenueCat
projects: complete in-app reauthentication and local SDK detachment, delete Auth,
observe the trigger acknowledgement, wait for provider processing, and inspect
the provider record without calling its get-or-create API. Exercise no existing
RevenueCat customer, repeated event delivery, temporary transport/provider
failure followed by recovery, revoked secret, and the second-device scenario.
Also verify aliased App User IDs and both mobile platform apps in the actual
RevenueCat project. Record delayed/failed cleanup separately from successful
Firebase Auth deletion. Verify that active store subscriptions remain manageable.

Deployments do not replay accounts deleted before the function was installed.
Existing deletion requests require a separately authorized reconciliation.
