# Oculo — Version 1.0 PRD

Release target: iPhone

Status: In development; integrated release validation remains required.

## Product description

Oculo is a mobile virtual scouting and shot-planning app for filmmakers. Users bring a Gaussian splat scene into the app, explore it, compose and save camera angles, and plan camera movements.

Users can share their work as PNG shot sheets and video previews of planned camera moves. These outputs help collaborators understand framing and movement before a shoot.

Oculo focuses on preproduction planning. Version 1.0 does not include scene scanning, lighting simulation, actor placement, or a desktop editing application.

## Intended users

Independent filmmakers, directors, cinematographers, and small production teams who want to explore a location remotely and communicate a useful shot plan.

## Core user outcome

Bring a relevant scene into Oculo and leave with a shot plan that a collaborator can understand without opening the app.

The primary workflow is:

Import scene → explore and compose → save and annotate shots → organize shots → export and share

Planning and exporting a camera move is optional.

## Version 1.0 requirements

### 1. Scene import and access

Import supported Gaussian splat files from iPhone Files.

Start with SPZ support; publish supported encoding versions and device limits after validation.

Provide an optional World Labs account connection for importing scenes through a supported, authorized integration.

Keep Files import usable without a World Labs account.

Retain imported scene bytes in app-managed persistent storage.

Keep imported scenes usable after the original file moves or the source download URL expires.

Include at least one licensed, mobile-sized offline demo.

Show useful errors for unsupported files, interrupted imports, insufficient storage, and scenes exceeding supported limits.

Record whether a scene is captured, generated, or of unknown origin, with available source and attribution information.

### 2. Navigation and composition

Support touch navigation for orbiting, moving closer or farther away, and panning.

Provide camera reset/recenter.

Retain optional Magic Window navigation using physical iPhone movement.

Show tracking status and provide recenter, permission-denial recovery, and an explicit return to touch controls.

Support focal-length and sensor controls.

Support output aspect ratios and composition guides.

Preserve the same saved composition across device rotation, reopening, and export.

Support portrait and both intended landscape orientations on iPhone.

Magic Window navigation does not, by itself, provide metric calibration or imply continuous camera-performance recording.

### 3. Saved shots and projects

Organize work into projects. A project holds one or more scenes; each scene owns its own ordered shots, and each shot is static or moving. (Revised 2026-09-25: multi-scene projects replace the earlier one-scene-per-project rule. The Oculo Pro boundary is unchanged: it lifts the saved-project limit only, and scenes per project are not limited.)

Save multiple ordered shots with matching framed thumbnails.

Support shot names, optional notes, renaming, reordering, and deletion.

Restore saved camera settings and poses.

Persist projects, scene references, shots, notes, and movement data across relaunch.

Show accurate saving, saved, and save-failure states with recovery.

Provide clear project deletion behavior and reclaim scene storage only when no project still references it.

Keep existing projects accessible regardless of current purchase status.

### 4. Camera movement planning

Movement belongs to shots. A shot is created once and is static (one keyframe) or moving (two or more keyframes). (Revised 2026-09-25: this replaces building a move from two saved shots.)

A shot stores what stays fixed while rolling: lens type (a prime, or a zoom with its range), sensor, aspect ratio and length. Keyframes store what an operator changes while rolling: position, rotation including dutch angle, zoom within the lens, focus distance and aperture.

Add a keyframe by moving the camera and changing its settings, then recording them. Provide length, per-segment speed, playback, stop and scrubbing.

Move through the scene with on-screen thumb sticks (walk, strafe, crane, pan and tilt), direct drag and pinch, the keyboard, and press-and-hold buttons for assistive technology.

Focus and aperture are recorded and exported; depth of field is not rendered.

Support undo/redo for the implemented camera and movement editing actions.

Keep movement editing available to free users.

Do not require a camera move before creating or sharing a shot sheet.

Final supported controls and limits must match the integrated release build.

### 5. Export and sharing

PNG shot sheets

Generate shot sheets from selected saved shots.

Include framed images, shot numbering, names, notes, and relevant camera settings.

Include scene/provenance and scale information where applicable.

Preview the generated pages before sharing.

Preserve saved framing and keep text readable across multiple pages.

Share through the native iOS share sheet, including Save to Files and installed messaging destinations.

Video previews

Export a preview video of a chosen shot using the implemented video-export workflow.

Clearly communicate supported resolution, duration, encoding, and device limits after testing.

Handle cancellation, export failure, and retry without losing project data.

Exports are collaboration references. Version 1.0 does not promise editable timelines or native project interchange with desktop editing software. PDF is not the default export format.

### 6. Durable scene and camera data

Use stable scene IDs and immutable asset-version IDs.

Identify assets through content fingerprints rather than filenames or temporary URLs.

Preserve scene transforms, coordinate conventions, camera poses, lens/sensor settings, output framing, clipping, and timing.

Version persisted schemas and migrate existing data without clearing projects.

Treat changed asset bytes as a new version.

Keep metric scale explicitly unknown unless supported by metadata or calibration.

Exclude private asset paths and access credentials from shared metadata.

### 7. Monetization

Free

One saved project.

Scene import and navigation.

Multiple saved shots and annotations.

Expanded movement editing.

PNG shot sheets and supported video exports.

Oculo Pro

A one-time, non-consumable purchase enabling additional saved projects.

No subscription.

No separate paid restrictions on movement editing, shots, scene formats, or exports.

Existing projects remain accessible if entitlement status is unavailable or changes.

Device and storage limits apply equally to free and Pro users.

Purchases use Apple In-App Purchase through RevenueCat, with the oculo_pro entitlement. Purchase restoration must work without an Oculo account. Restoring Pro does not recover local project or scene files.

### 8. Accounts and connectivity

The core local workflow must not require an Oculo account.

World Labs connection is optional and separate from Oculo authentication.

Imported scenes and local editing should work offline after required assets are downloaded.

Network access may be required for World Labs access, purchases, and message delivery.

Any shipped Firebase account/sync functionality requires explicit release validation, accurate disclosure, and account deletion.

Metadata synchronization must not imply that source scene files are synchronized.

## Platform scope

Initial release: iPhone.

iPad: deferred; not part of initial release acceptance.

Android: preserve compatibility where practical, but release readiness is outside the iPhone critical path.

Desktop: no dedicated application, phone-to-PC synchronization, or desktop movement editor in Version 1.0.

## Accuracy and capability boundaries

Lens and sensor controls describe framing.

The app does not simulate depth of field, exposure, or lighting unless a specific supported effect is implemented and clearly identified.

Unknown scene scale must not produce claims of accurate physical dimensions.

Generated scenes must not be presented as verified real-world locations.

Supported scene sizes and export limits must come from measurements on actual iPhones.

## Release acceptance

Version 1.0 is ready when:

A filmmaker imports a supported scene, saves at least three annotated shots, and shares a readable PNG shot sheet.

A collaborator opens the shared output without needing Oculo.

Planned camera movement can be previewed and exported successfully within supported limits.

Imported projects survive force-quit/relaunch and remain usable offline.

Unsupported inputs and failed saves/exports recover without losing existing work.

Free users complete the full workflow; Pro enables a second project.

Purchase, cancellation, restoration, and entitlement recovery pass native testing.

Portrait, landscape, Magic Window, and safe areas pass physical-iPhone testing.

The signed release build, privacy disclosures, store listing, and paid claims agree.

## Deferred opportunities

These are candidates for future evaluation, not commitments for Version 1.1:

Actor, prop, and equipment placement.

Blocking, actor animation, and equipment-fit planning.

Scene scanning or reconstruction.

AI copilot and assisted shot planning.

AI scene search, filtering, or shot-to-sketch generation.

Location discovery, proximity search, and a scene marketplace.

Verified measurement and calibration workflows.

Custom project folders and richer organization.

Desktop editing, cloud collaboration, and DCC integrations.

iPad and Android releases.
