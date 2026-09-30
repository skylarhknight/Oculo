import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraPoseSource } from "@oculo/scene-core";
import { createDevicePoseSource } from "./DevicePoseService";

const native = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  addListener: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => native,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const sources: CameraPoseSource[] = [];
let listeners: {
  name: string;
  callback: (event: never) => void;
  remove: ReturnType<typeof vi.fn>;
}[];
const source = () => {
  const created = createDevicePoseSource();
  sources.push(created);
  return created;
};
const emit = (name: string, event: unknown) => {
  // Deliberately invoke even removed native callbacks to exercise invalidation.
  listeners
    .filter((listener) => listener.name === name)
    .forEach((listener) => listener.callback(event as never));
};
const pose = { px: 1, py: 2, pz: 3, qx: 0, qy: 0, qz: 0, qw: 1, timestampMs: 1 };

beforeEach(() => {
  vi.resetAllMocks();
  listeners = [];
  native.isAvailable.mockResolvedValue({ available: true });
  native.start.mockResolvedValue(undefined);
  native.stop.mockResolvedValue(undefined);
  native.addListener.mockImplementation(async (name: string, callback: (event: never) => void) => {
    const remove = vi.fn(async () => undefined);
    listeners.push({ name, callback, remove });
    return { remove };
  });
});

afterEach(async () => {
  native.stop.mockResolvedValue(undefined);
  for (const current of sources.splice(0)) await current.stop();
});

describe("native device pose ownership", () => {
  it("subscribes before startup events and invalidates callbacks as soon as stop is requested", async () => {
    const current = source();
    const poses = vi.fn();
    const quality = vi.fn();
    current.onPose(poses);
    current.onTrackingQuality(quality);
    native.start.mockImplementationOnce(async () => {
      emit("trackingState", { state: "normal" });
      emit("pose", pose);
    });
    await current.start();
    expect(quality).toHaveBeenCalledWith("normal");
    expect(poses).toHaveBeenCalledWith({
      position: [1, 2, 3],
      quaternion: [0, 0, 0, 1],
      timestampMs: 1,
    });
    const stopped = current.stop();
    emit("pose", pose);
    emit("trackingState", { state: "normal" });
    await stopped;
    expect(poses).toHaveBeenCalledTimes(1);
    expect(quality).toHaveBeenCalledTimes(1);
    expect(listeners.every((listener) => listener.remove.mock.calls.length === 1)).toBe(true);
  });

  it("interrupts a pending native start, drains cleanup, and permits a later viewer to start", async () => {
    const first = source();
    const second = source();
    const pending = deferred<void>();
    native.start.mockImplementationOnce(() => pending.promise);
    const result = first.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
    native.stop.mockImplementationOnce(async () => {
      pending.reject(new Error("cancelled"));
    });
    const stopped = first.stop();
    const next = second.start();
    expect(await result).toBeInstanceOf(Error);
    await stopped;
    await next;
    expect(native.start).toHaveBeenCalledTimes(2);
    const stops = native.stop.mock.calls.length;
    await first.stop();
    expect(native.stop).toHaveBeenCalledTimes(stops);
    const poses = vi.fn();
    second.onPose(poses);
    emit("pose", pose);
    expect(poses).toHaveBeenCalledTimes(1);
  });

  it("cleans a delayed listener when another registration fails, then allows retry", async () => {
    const current = source();
    const late = deferred<{ remove: ReturnType<typeof vi.fn> }>();
    const remove = vi.fn(async () => undefined);
    native.addListener
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockImplementationOnce(() => late.promise);
    const result = current.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(native.addListener).toHaveBeenCalledTimes(2));
    late.resolve({ remove });
    expect(await result).toBeInstanceOf(Error);
    expect(remove).toHaveBeenCalledOnce();
    expect(native.start).not.toHaveBeenCalled();
    await current.start();
    expect(native.start).toHaveBeenCalledOnce();
  });

  it("does not start natively when stop arrives during listener registration", async () => {
    const current = source();
    const late = deferred<{ remove: ReturnType<typeof vi.fn> }>();
    const remove = vi.fn(async () => undefined);
    native.addListener.mockImplementationOnce(() => late.promise);
    const starting = current.start();
    await vi.waitFor(() => expect(native.addListener).toHaveBeenCalledTimes(2));
    const stopped = current.stop();
    late.resolve({ remove });
    await starting;
    await stopped;
    expect(native.start).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("shares duplicate startup and prevents an older owner from stopping its replacement", async () => {
    const first = source();
    const quality = vi.fn();
    first.onTrackingQuality(quality);
    await Promise.all([first.start(), first.start()]);
    expect(native.start).toHaveBeenCalledOnce();
    const second = source();
    await second.start();
    expect(quality).toHaveBeenCalledWith("unavailable");
    const stops = native.stop.mock.calls.length;
    await first.stop();
    expect(native.stop).toHaveBeenCalledTimes(stops);
  });

  it("removes listeners and rejects stale poses even when native stop fails", async () => {
    const current = source();
    const poses = vi.fn();
    current.onPose(poses);
    await current.start();
    native.stop.mockRejectedValueOnce(new Error("bridge stopped responding"));
    await expect(current.stop()).rejects.toThrow("bridge stopped responding");
    emit("pose", pose);
    expect(poses).not.toHaveBeenCalled();
    expect(listeners.every((listener) => listener.remove.mock.calls.length === 1)).toBe(true);
    await current.start();
    emit("pose", pose);
    expect(poses).toHaveBeenCalledTimes(1);
  });
});
