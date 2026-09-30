import type {
  CameraPath,
  CameraPathKeyframe,
  CameraPose,
  CinematicCamera,
} from "@oculo/scene-schema";
import { CatmullRomCurve3, Quaternion, Vector3 } from "three";

import { speedCurveProgress } from "./speedCurve.js";

export interface CameraPathInterpolator {
  interpolate(path: CameraPath, timeSeconds: number): CinematicCamera;
}

function assertPath(path: CameraPath): void {
  if (path.keyframes.length === 0) {
    throw new RangeError("At least one camera keyframe is required");
  }
  for (let index = 1; index < path.keyframes.length; index += 1) {
    if (path.keyframes[index]!.timeSeconds <= path.keyframes[index - 1]!.timeSeconds) {
      throw new RangeError("Camera keyframe times must be strictly increasing");
    }
  }
}

function tupleFromVector(vector: Vector3): CameraPose["position"] {
  return [vector.x, vector.y, vector.z];
}

function tupleFromQuaternion(quaternion: Quaternion): CameraPose["quaternion"] {
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function normalizedQuaternion(tuple: CameraPose["quaternion"]): Quaternion {
  const quaternion = new Quaternion(...tuple);
  if (quaternion.lengthSq() === 0) {
    throw new RangeError("Camera keyframe quaternions must not have zero length");
  }
  return quaternion.normalize();
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

function cloneNormalized(camera: CinematicCamera): CinematicCamera {
  return {
    ...camera,
    output: { ...camera.output },
    pose: {
      position: [...camera.pose.position],
      quaternion: tupleFromQuaternion(normalizedQuaternion(camera.pose.quaternion)),
    },
  };
}

/** Keeps two shots aimed at a shared subject from cutting straight toward it. */
function interpolateSubjectOrbit(
  from: Vector3,
  to: Vector3,
  fromQuaternion: Quaternion,
  toQuaternion: Quaternion,
  quaternion: Quaternion,
  alpha: number,
): Vector3 | undefined {
  const displacement = to.clone().sub(from);
  if (displacement.lengthSq() === 0) return undefined;

  const fromForward = new Vector3(0, 0, -1).applyQuaternion(fromQuaternion);
  const toForward = new Vector3(0, 0, -1).applyQuaternion(toQuaternion);
  const directionDot = fromForward.dot(toForward);
  const denominator = 1 - directionDot * directionDot;
  // Parallel or nearly parallel viewing rays cannot establish a reliable
  // subject distance. Trucks, straight dollies and pans retain linear motion.
  if (denominator <= 1e-6) return undefined;

  // Solve for the closest points on the two forward rays. A subject must sit
  // in front of both cameras, and the rays must meet to within rounding error.
  const alongFrom = displacement.dot(fromForward);
  const alongTo = displacement.dot(toForward);
  const fromDistance = (alongFrom - directionDot * alongTo) / denominator;
  const toDistance = (directionDot * alongFrom - alongTo) / denominator;
  if (fromDistance <= 0 || toDistance <= 0) return undefined;

  const fromSubject = from.clone().addScaledVector(fromForward, fromDistance);
  const toSubject = to.clone().addScaledVector(toForward, toDistance);
  const tolerance = Math.max(displacement.length(), fromDistance, toDistance) * 1e-5;
  if (fromSubject.distanceTo(toSubject) > tolerance) return undefined;

  const subject = fromSubject.add(toSubject).multiplyScalar(0.5);
  const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
  // Follow the same shortest camera rotation as orientation interpolation.
  // Deriving position from its forward axis also keeps pitched/rolled shots
  // looking at the subject; independent position/orientation arcs can drift.
  return subject.addScaledVector(forward, -lerp(fromDistance, toDistance, alpha));
}

export class SmoothCameraPathInterpolator implements CameraPathInterpolator {
  interpolate(path: CameraPath, timeSeconds: number): CinematicCamera {
    assertPath(path);
    if (!Number.isFinite(timeSeconds)) {
      throw new RangeError("timeSeconds must be finite");
    }

    const keyframes = path.keyframes;
    const first = keyframes[0]!;
    const last = keyframes[keyframes.length - 1]!;
    if (keyframes.length === 1 || timeSeconds <= first.timeSeconds) {
      return cloneNormalized(first.camera);
    }
    if (timeSeconds >= last.timeSeconds) {
      return cloneNormalized(last.camera);
    }

    const toIndex = keyframes.findIndex(({ timeSeconds: time }) => time > timeSeconds);
    const fromIndex = toIndex - 1;
    const from: CameraPathKeyframe = keyframes[fromIndex]!;
    const to: CameraPathKeyframe = keyframes[toIndex]!;
    const localT = speedCurveProgress(
      from.speedCurve,
      (timeSeconds - from.timeSeconds) / (to.timeSeconds - from.timeSeconds),
    );
    const fromQuaternion = normalizedQuaternion(from.camera.pose.quaternion);
    const toQuaternion = normalizedQuaternion(to.camera.pose.quaternion);
    const quaternion = new Quaternion()
      .slerpQuaternions(fromQuaternion, toQuaternion, localT)
      .normalize();
    const points = keyframes.map(({ camera }) => new Vector3(...camera.pose.position));
    const position =
      points.length === 2
        ? (interpolateSubjectOrbit(
            points[0]!,
            points[1]!,
            fromQuaternion,
            toQuaternion,
            quaternion,
            localT,
          ) ?? points[0]!.clone().lerp(points[1]!, localT))
        : new CatmullRomCurve3(points, false, "centripetal").getPoint(
            (fromIndex + localT) / (keyframes.length - 1),
          );

    return {
      pose: {
        position: tupleFromVector(position),
        quaternion: tupleFromQuaternion(quaternion),
      },
      output: {
        aspectRatio: lerp(from.camera.output.aspectRatio, to.camera.output.aspectRatio, localT),
        crop: "center-inside-sensor" as const,
      },
      focalLengthMm: lerp(from.camera.focalLengthMm, to.camera.focalLengthMm, localT),
      sensorWidthMm: lerp(from.camera.sensorWidthMm, to.camera.sensorWidthMm, localT),
      sensorHeightMm: lerp(from.camera.sensorHeightMm, to.camera.sensorHeightMm, localT),
      // Mixed-aspect paths transition continuously; equal-aspect paths keep a fixed gate.
      near: lerp(from.camera.near, to.camera.near, localT),
      far: lerp(from.camera.far, to.camera.far, localT),
    };
  }
}

export const defaultCameraPathInterpolator: CameraPathInterpolator =
  new SmoothCameraPathInterpolator();
