# Permissions and data flows

Implementation inventory for the September 11, 2026 development candidate. This records code behavior, not legal advice or completed store privacy declarations. Provider-side retention, deployment region, team identity, and store answers must be checked against the exact configured release and observed traffic.

## Local application data

| Data | Where created/stored | Network destination | Retention/deletion |
| --- | --- | --- | --- |
| Project names, notes, shots, camera settings, paths, speed curves, output aspect and display settings | IndexedDB `projects`; schema validation and acknowledged transactions in `ProjectStore.ts` | Eligible projects may enter optional Firestore backup through `SyncedProjectStore`; local imports are excluded | Saved until project deletion/app-data removal. Local revision tombstones record pending remote deletions |
| Saved reference frames | IndexedDB `shotImages`, keyed by project/shot and exact camera+scene signature | Eligible cloud backups can include safe image data URLs; oversized backups omit thumbnails | Removed when their shot/project is deleted or signatures change; duplicate projects receive independent image records |
| Imported SPZ source bytes | User-chosen file copied as an immutable Blob into IndexedDB `sceneAssets`, atomically with its project | None through Oculo import/backup. Original paths and source bytes are never placed in project metadata or uploaded | Retained while at least one local project references the asset. Removing one duplicate keeps shared bytes; final deletion/reference replacement removes them |
| Imported scene metadata | `SceneDescriptor.localAsset`: version, opaque ID, base filename, format, byte count; stable `oculo-asset:` reference | Imported local projects are excluded from cloud backup; cloud sanitizer also rejects local URLs | Stored with the project. Filename is a basename, not a filesystem path |
| Temporary scene URLs | `URL.createObjectURL` for loaded scene bytes | Used by the renderer's local fetch; no server receives a Blob URL | Revoked on viewer disposal, replacement, or failed loading. A capture using the live viewer retains its scene URL until viewer cleanup |
| Undo/redo history and playback state | In-memory editor state | None | Session-scoped; the resulting project edits, not the full history, are persisted |
| Rendered PNG and MP4 exports | In-memory canvas/Blob containing saved framing and optional scene credits; MP4 embeds attribution/source/license/modification notes when supplied. Native sharing prepares copies in `Directory.Cache` | Only the system-share destination selected by the user; browser downloads remain local unless the chosen destination syncs them | Canceled/unshared preparation is cleaned up. Native shared cache batches become eligible for cleanup 24 hours after the latest share attempt, checked during later preparation |

IndexedDB durability protects acknowledged writes from normal restart and interruption. Clearing app/browser storage, uninstalling, OS storage management, or device-backup behavior can still affect local files. Android's application manifest currently sets `allowBackup=true`; platform backup scope must be reflected in final privacy material. Oculo project deletion does not delete copies previously exported to another app.

## Optional network services

| Trigger | Data/destination | Source evidence |
| --- | --- | --- |
| Open an online demo scene | Scene download from configured public HTTPS hosts; hosting service receives normal request/connection metadata | `config/demoScenes.ts`, `scene-core/src/SceneEngine.ts` |
| Configure and use accounts | Firebase Authentication credentials/provider tokens and account identifiers; Google/Apple provider flows when chosen | `services/firebase.ts`, `services/AuthService.ts`, native plugin configuration |
| Back up eligible account-owned projects | Validated camera/shot metadata, names/notes, scene references, and bounded thumbnails to `users/{uid}/projects` in Firestore | `store/SyncedProjectStore.ts`, `store/CloudProjectRepository.ts`, Firestore rules |
| Initialize a configured purchase SDK; purchase or restore | RevenueCat/Apple/Google purchase and entitlement data, RevenueCat customer identifiers; SDK may communicate before the paywall is opened | `services/PurchaseService.ts`; exact third-party collection requires SDK/config review |
| Delete a configured account | In-app reauthentication, cloud project cleanup, linked Apple token revocation where applicable, Firebase user deletion; deployed auth-deletion function requests RevenueCat customer deletion | `services/AuthService.ts`, `store/SyncedProjectStore.ts`, `account-functions/src/index.ts` and `revenueCatDeletion.ts` |
| Open policy, support, attribution or license links | Browser request to destination URL | Release configuration, scene attribution and application links |

Missing Firebase configuration disables Oculo account/backup operations. Native Firebase inclusion follows the corresponding native configuration file. RevenueCat configuration is independent of Firebase and can be enabled without accounts. No application analytics or advertising integration was found in the reviewed source; this does not establish what configured third-party SDKs or hosting providers collect.

Account deletion retains local projects and their imported files. RevenueCat API acknowledgement is not proof that asynchronous provider erasure finished; deployment, retries, alias scope and operational monitoring require service verification. Deleting an account does not cancel a store subscription or erase shared files.

## Permissions and platform declarations

| Platform/capability | Declaration or trigger | Use |
| --- | --- | --- |
| iOS camera | `NSCameraUsageDescription`; permission requested when the user starts Magic Window | ARKit estimates device pose/tracking. Oculo receives pose/tracking state and does not record or upload the camera feed through this feature |
| iOS required-reason API | App privacy manifest declares file timestamp access, reason `C617.1` | App-container file/cache handling; review combined dependency manifests for the actual archive |
| Android internet | `android.permission.INTERNET` | Online scene loading and configured account/purchase services |
| File import | System file chooser with `.spz` selection | Access to the selected file; no broad external-storage permission is requested by Oculo |
| Native sharing | App-scoped cache plus Android FileProvider/URI grants or iOS system share sheet | Shares only prepared PNG/MP4 files after an explicit action |
| Haptics | Capacitor Haptics | Local interaction feedback |

No contacts, microphone, photo-library scanning, or GPS-location access is requested by the reviewed app manifests. Inspect the final merged Android manifest and iOS archive privacy manifests as dependencies/configuration change. A source scene can depict a private location or people; imports remain local, while exported frames carry whatever the user chose to compose and share.

## Agent-verifiable evidence and external inputs

The release-candidate report links tests for schema/path sanitization, ownership and cloud exclusions, atomic import/cancellation, shared-asset deletion, scene URL cleanup, and export cleanup. Browser verification exercises local import/restart and editor interactions. Native launch screenshots do not certify permissions or tracking on physical hardware.

External inputs still needed: team/controller and contacts; production Firebase region/rules/deletion deployment; RevenueCat catalog and retention/deletion handling; actual policy/support hosting practices; store billing terms; final merged SDK privacy review; store privacy forms matching the submitted configuration.
