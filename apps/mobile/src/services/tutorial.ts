import { DEMO_SCENES } from "../config/demoScenes";
import { appendKeyframe, setSegmentSpeed, createSpeedCurvePreset } from "@oculo/camera-core";
import { cloneCamera, type CinematicCamera, type Project } from "../types/project";
import { createProject, createProjectScene, createShot, newKeyframeId } from "./projectFactory";

export const TUTORIAL_NAME = "Tutorial · Garden walkthrough";

type Vec3 = [number, number, number];

/** Camera forward (-Z) rotated by an xyzw quaternion. */
function forward([x, y, z, w]: readonly number[]): Vec3 {
  const qx = x ?? 0;
  const qy = y ?? 0;
  const qz = z ?? 0;
  const qw = w ?? 1;
  return [-2 * (qx * qz + qw * qy), -2 * (qy * qz - qw * qx), -(1 - 2 * (qx * qx + qy * qy))];
}

function dolly(camera: CinematicCamera, distance: number, focalLengthMm: number): CinematicCamera {
  const next = cloneCamera(camera);
  const direction = forward(camera.pose.quaternion);
  next.pose.position = camera.pose.position.map(
    (value, index) => value + direction[index]! * distance,
  ) as Vec3;
  next.focalLengthMm = focalLengthMm;
  return next;
}

/**
 * A ready-made project on the bundled offline scene. It demonstrates static shots and a
 * moving shot so a new user can try every stage before importing their own scene.
 */
export function createTutorialProject(): Project {
  const starter = DEMO_SCENES.find((scene) => scene.availableOffline) ?? DEMO_SCENES[0]!;
  const scene = createProjectScene(starter.descriptor, { name: starter.title });
  const base = scene.camera;
  const sensor = { sensorWidthMm: base.sensorWidthMm, sensorHeightMm: base.sensorHeightMm };
  const aspectRatio = base.output.aspectRatio;
  const still = (name: string, camera: CinematicCamera, notes: string) => ({
    ...createShot(starter.descriptor, camera, {
      name,
      lens: { kind: "prime", focalLengthMm: camera.focalLengthMm },
      ...sensor,
      aspectRatio,
    }),
    notes,
  });
  const wide = { ...cloneCamera(base), focusDistanceM: 6, apertureFStop: 5.6 };
  const push = createShot(starter.descriptor, wide, {
    name: "03 Push in to the flowers",
    lens: { kind: "zoom", minFocalLengthMm: 24, maxFocalLengthMm: 85 },
    ...sensor,
    aspectRatio,
  });
  let moving = appendKeyframe(push, newKeyframeId(), {
    ...dolly(base, 2.5, 50),
    focusDistanceM: 3,
    apertureFStop: 2.8,
  });
  moving = appendKeyframe(moving, newKeyframeId(), {
    ...dolly(base, 4, 85),
    focusDistanceM: 1.2,
    apertureFStop: 2,
  });
  moving = setSegmentSpeed(moving, moving.keyframes[0]!.id, createSpeedCurvePreset("ease-in"));
  const shots = [
    still(
      "01 Establishing wide",
      wide,
      "A static shot: one keyframe. Tap it in Shots to open it, move with the sticks, and tap Update keyframe to re-frame it.",
    ),
    still(
      "02 Medium on the path",
      { ...dolly(base, 2.5, 35), focusDistanceM: 3, apertureFStop: 4 },
      "Tap New shot in Compose to start another. Pick a prime or a zoom lens first.",
    ),
    {
      ...moving,
      notes:
        "A moving shot: three keyframes on a zoom lens with a focus pull. Add keyframe records where the camera is now; change Length to slow it down.",
    },
  ];
  return {
    ...createProject(TUTORIAL_NAME, { ...scene, shots }),
    tutorial: true,
  };
}
