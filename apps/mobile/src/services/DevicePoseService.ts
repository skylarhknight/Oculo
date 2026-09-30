import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type {
  CameraPoseSource,
  DevicePose,
  DevicePoseListener,
  PoseTrackingQuality,
  PoseTrackingQualityListener,
} from "@oculo/scene-core";

/**
 * Capacitor adapter for the native ARKit pose plugin. All plugin/event types
 * stay inside this module; the rest of the app consumes the Oculo-owned
 * `CameraPoseSource` contract.
 */

interface ArPosePluginEvents {
  isAvailable(): Promise<{ available: boolean }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  addListener(
    eventName: "pose",
    listener: (event: {
      px: number;
      py: number;
      pz: number;
      qx: number;
      qy: number;
      qz: number;
      qw: number;
      timestampMs: number;
    }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "trackingState",
    listener: (event: { state: string }) => void,
  ): Promise<PluginListenerHandle>;
}

const ArPose = registerPlugin<ArPosePluginEvents>("ArPose");

// The native plugin owns one AR session. Serialize all source instances so a
// departing viewer cannot stop a newer viewer's session after a delayed start.
let nativeOperations: Promise<void> = Promise.resolve();
let nativeOwner: { source: NativeDevicePoseSource } | undefined;

function enqueueNative(operation: () => Promise<void>): Promise<void> {
  const result = nativeOperations.then(operation, operation);
  nativeOperations = result.catch(() => undefined);
  return result;
}

function toTrackingQuality(state: string): PoseTrackingQuality {
  switch (state) {
    case "normal":
      return "normal";
    case "limited":
      return "limited";
    case "initializing":
      return "initializing";
    default:
      return "unavailable";
  }
}

class NativeDevicePoseSource implements CameraPoseSource {
  private readonly poseListeners = new Set<DevicePoseListener>();
  private readonly qualityListeners = new Set<PoseTrackingQualityListener>();
  private handles: PluginListenerHandle[] = [];
  private requested = false;
  private generation = 0;
  private pendingStart: Promise<void> | undefined;
  private startingNative = false;

  async isAvailable(): Promise<boolean> {
    const nativePlatform = Capacitor.isNativePlatform();
    if (!nativePlatform) return false;
    try {
      const { available } = await ArPose.isAvailable();
      return available;
    } catch {
      return false;
    }
  }

  start(): Promise<void> {
    if (this.requested) return this.pendingStart ?? Promise.resolve();
    this.requested = true;
    const generation = ++this.generation;
    const isCurrent = () => this.requested && this.generation === generation;
    const operation = enqueueNative(async () => {
      if (!isCurrent()) return;
      try {
        if (nativeOwner && nativeOwner.source !== this) {
          const previous = nativeOwner.source;
          previous.requested = false;
          previous.generation += 1;
          for (const listener of previous.qualityListeners) listener("unavailable");
          await previous.releaseNative();
        }
        if (!isCurrent()) return;
        nativeOwner = { source: this };
        const registered = await Promise.allSettled([
          ArPose.addListener("pose", (event) => {
            if (!isCurrent() || nativeOwner?.source !== this) return;
            const pose: DevicePose = {
              position: [event.px, event.py, event.pz],
              quaternion: [event.qx, event.qy, event.qz, event.qw],
              timestampMs: event.timestampMs,
            };
            for (const listener of this.poseListeners) listener(pose);
          }),
          ArPose.addListener("trackingState", (event) => {
            if (!isCurrent() || nativeOwner?.source !== this) return;
            const quality = toTrackingQuality(event.state);
            for (const listener of this.qualityListeners) listener(quality);
          }),
        ]);
        // Retain successful registrations even if the other one failed so the
        // failure path can remove every handle, including late resolutions.
        this.handles = registered.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const failure = registered.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        if (isCurrent()) {
          this.startingNative = true;
          try {
            await ArPose.start();
          } finally {
            this.startingNative = false;
          }
        }
        if (!isCurrent()) await this.releaseNative();
      } catch (error) {
        if (isCurrent()) this.requested = false;
        await this.releaseNative().catch(() => undefined);
        throw new Error(
          "Motion tracking could not start. Check that Oculo has camera access in Settings.",
          { cause: error },
        );
      }
    });
    this.pendingStart = operation;
    const clear = () => {
      if (this.pendingStart === operation) this.pendingStart = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  stop(): Promise<void> {
    // Invalidate callbacks immediately, even while registration/permission is
    // pending. The returned promise drains startup and native resource cleanup.
    this.requested = false;
    this.generation += 1;
    // Native stop cancels the pending permission/start call. It is safe to
    // interrupt this owner here: later owners are still behind the start queue.
    const interruption =
      nativeOwner?.source === this && this.startingNative
        ? ArPose.stop().catch(() => undefined)
        : Promise.resolve();
    return enqueueNative(async () => {
      await interruption;
      await this.releaseNative();
    });
  }

  private async releaseNative(): Promise<void> {
    try {
      if (nativeOwner?.source === this) {
        try {
          await ArPose.stop();
        } finally {
          nativeOwner = undefined;
        }
      }
    } finally {
      await this.removeHandles();
    }
  }

  onPose(listener: DevicePoseListener): () => void {
    this.poseListeners.add(listener);
    return () => this.poseListeners.delete(listener);
  }

  onTrackingQuality(listener: PoseTrackingQualityListener): () => void {
    this.qualityListeners.add(listener);
    return () => this.qualityListeners.delete(listener);
  }

  private async removeHandles(): Promise<void> {
    const handles = this.handles;
    this.handles = [];
    await Promise.all(handles.map((handle) => handle.remove().catch(() => undefined)));
  }
}

export function createDevicePoseSource(): CameraPoseSource {
  return new NativeDevicePoseSource();
}
