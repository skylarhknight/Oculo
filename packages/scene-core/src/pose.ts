import { Quaternion, Vector3 } from "three";

import type { QuaternionTuple, Vector3Tuple } from "./types.js";

/**
 * Oculo-owned contract for physical device pose tracking ("Magic Window"
 * navigation). Implementations wrap platform capabilities (e.g. ARKit via a
 * native bridge) and must not leak platform types through this interface.
 */

export type PoseTrackingQuality = "initializing" | "normal" | "limited" | "unavailable";

export interface DevicePose {
  /** Device position in meters, right-handed Y-up world space. */
  readonly position: Vector3Tuple;
  /** Device orientation as a unit quaternion (x, y, z, w). */
  readonly quaternion: QuaternionTuple;
  readonly timestampMs: number;
}

export type DevicePoseListener = (pose: DevicePose) => void;
export type PoseTrackingQualityListener = (quality: PoseTrackingQuality) => void;

export interface CameraPoseSource {
  /** Resolves true when the platform can deliver 6DoF device poses. */
  isAvailable(): Promise<boolean>;
  /** Begins tracking. Rejects with an Oculo error message on failure. */
  start(): Promise<void>;
  /** Stops tracking and releases platform resources. */
  stop(): Promise<void>;
  onPose(listener: DevicePoseListener): () => void;
  onTrackingQuality(listener: PoseTrackingQualityListener): () => void;
}

export interface HandheldBaseline {
  readonly virtualPosition: Vector3Tuple;
  readonly virtualQuaternion: QuaternionTuple;
  readonly devicePosition: Vector3Tuple;
  readonly deviceQuaternion: QuaternionTuple;
}

export interface ComposedPose {
  readonly position: Vector3Tuple;
  readonly quaternion: QuaternionTuple;
}

/**
 * Composes a virtual camera pose from a physical device pose relative to a
 * captured baseline. The device delta since the baseline is rotated into the
 * virtual camera's frame so that "walk forward" always moves toward whatever
 * the virtual camera was facing when the baseline was captured.
 *
 * `translationScale` maps physical meters to scene units (1 = life size).
 */
export function composeHandheldPose(
  baseline: HandheldBaseline,
  device: DevicePose,
  translationScale = 1,
): ComposedPose {
  const baseDeviceQuat = new Quaternion(...baseline.deviceQuaternion).normalize();
  const deviceQuat = new Quaternion(...device.quaternion).normalize();
  const baseVirtualQuat = new Quaternion(...baseline.virtualQuaternion).normalize();

  // Orientation: virtual = baselineVirtual * (baselineDevice^-1 * device)
  const deviceDeltaQuat = baseDeviceQuat.clone().invert().multiply(deviceQuat);
  const quaternion = baseVirtualQuat.clone().multiply(deviceDeltaQuat).normalize();

  // Translation: rotate the physical displacement out of the baseline device
  // frame, into the baseline virtual frame, then scale meters to scene units.
  const displacement = new Vector3(...device.position).sub(new Vector3(...baseline.devicePosition));
  const localDisplacement = displacement.applyQuaternion(baseDeviceQuat.clone().invert());
  const virtualDisplacement = localDisplacement
    .applyQuaternion(baseVirtualQuat)
    .multiplyScalar(translationScale);
  const position = new Vector3(...baseline.virtualPosition).add(virtualDisplacement);

  return {
    position: [position.x, position.y, position.z],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
  };
}
