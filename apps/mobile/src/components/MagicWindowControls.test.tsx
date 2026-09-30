// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CameraPoseSource,
  DevicePoseListener,
  PoseTrackingQualityListener,
  SceneEngine,
} from "@oculo/scene-core";
import { MagicWindowControls } from "./MagicWindowControls";

const source = vi.hoisted(() => ({
  isAvailable: vi.fn<CameraPoseSource["isAvailable"]>(),
  start: vi.fn<CameraPoseSource["start"]>(),
  stop: vi.fn<CameraPoseSource["stop"]>(),
  onPose: vi.fn<CameraPoseSource["onPose"]>(),
  onTrackingQuality: vi.fn<CameraPoseSource["onTrackingQuality"]>(),
  poses: new Set<DevicePoseListener>(),
  qualities: new Set<PoseTrackingQualityListener>(),
}));
vi.mock("../services/DevicePoseService", () => ({ createDevicePoseSource: () => source }));
vi.mock("../services/haptics", () => ({
  confirmHaptic: vi.fn(),
  tapHaptic: vi.fn(),
  warnHaptic: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const engine = {
    enterHandheldMode: vi.fn(),
    exitHandheldMode: vi.fn(),
    applyDevicePose: vi.fn(),
  };
  const engineRef = createRef<SceneEngine>() as { current: SceneEngine | null };
  engineRef.current = engine as unknown as SceneEngine;
  const onActiveChange = vi.fn();
  const props = { engineRef, onActiveChange, translationScale: 2 };
  return { ...render(<MagicWindowControls {...props} />), engine, props, onActiveChange };
}
const pose = (x: number) => {
  source.poses.forEach((listener) =>
    listener({ position: [x, 0, 0], quaternion: [0, 0, 0, 1], timestampMs: x }),
  );
};
const quality = (value: Parameters<PoseTrackingQualityListener>[0]) => {
  source.qualities.forEach((listener) => listener(value));
};
async function enable() {
  fireEvent.click(await screen.findByRole("button", { name: "Magic Window" }));
  await screen.findByRole("button", { name: "Exit Magic Window" });
}

beforeEach(() => {
  vi.resetAllMocks();
  source.poses.clear();
  source.qualities.clear();
  source.isAvailable.mockResolvedValue(true);
  source.start.mockResolvedValue(undefined);
  source.stop.mockResolvedValue(undefined);
  source.onPose.mockImplementation((listener) => {
    source.poses.add(listener);
    return () => {
      source.poses.delete(listener);
    };
  });
  source.onTrackingQuality.mockImplementation((listener) => {
    source.qualities.add(listener);
    return () => {
      source.qualities.delete(listener);
    };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Magic Window session recovery", () => {
  it("freezes every uncertain pose and reanchors before the first recovered pose", async () => {
    const { engine } = setup();
    await enable();
    act(() => pose(1));
    expect(engine.applyDevicePose).not.toHaveBeenCalled();
    act(() => {
      quality("normal");
      pose(2);
      pose(3);
    });
    expect(engine.applyDevicePose).toHaveBeenCalledTimes(2);
    engine.enterHandheldMode.mockClear();
    act(() => {
      quality("limited");
      pose(100);
      quality("unavailable");
      pose(200);
    });
    expect(engine.applyDevicePose).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toContain("Tracking lost · Frame held");
    expect((screen.getByRole("button", { name: "Recenter" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    act(() => {
      quality("normal");
      pose(500);
      pose(501);
    });
    expect(engine.enterHandheldMode).toHaveBeenCalledExactlyOnceWith(2);
    expect(engine.enterHandheldMode.mock.invocationCallOrder[0]).toBeLessThan(
      engine.applyDevicePose.mock.invocationCallOrder[2]!,
    );
    expect(engine.applyDevicePose).toHaveBeenCalledTimes(4);
  });

  it("accepts first normal tracking events emitted before start resolves", async () => {
    const { engine, onActiveChange } = setup();
    source.start.mockImplementationOnce(async () => {
      quality("normal");
      pose(10);
    });
    await enable();
    expect(engine.applyDevicePose).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toBe(" Tracking");
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
  });

  it("cancels pending startup on unmount and never targets a replacement engine", async () => {
    const pending = deferred();
    source.start.mockReturnValueOnce(pending.promise);
    const { engine, props, unmount, onActiveChange } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Magic Window" }));
    await screen.findByRole("button", { name: "Starting…" });
    const stale = [...source.poses];
    const replacement = { exitHandheldMode: vi.fn(), applyDevicePose: vi.fn() };
    props.engineRef.current = replacement as unknown as SceneEngine;
    unmount();
    expect(source.stop).toHaveBeenCalledOnce();
    expect(engine.exitHandheldMode).toHaveBeenCalledOnce();
    expect(replacement.exitHandheldMode).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    stale.forEach((listener) =>
      listener({ position: [1, 0, 0], quaternion: [0, 0, 0, 1], timestampMs: 1 }),
    );
    expect(engine.applyDevicePose).not.toHaveBeenCalled();
    expect(replacement.applyDevicePose).not.toHaveBeenCalled();
    expect(onActiveChange).not.toHaveBeenCalledWith(true);
    expect(source.poses.size + source.qualities.size).toBe(0);
  });

  it("releases tracking when playback disables it and does not automatically resume", async () => {
    const { engine, props, rerender } = setup();
    await enable();
    const stale = [...source.poses];
    rerender(<MagicWindowControls {...props} disabled />);
    expect(engine.exitHandheldMode).toHaveBeenCalledOnce();
    expect(source.stop).toHaveBeenCalledOnce();
    stale.forEach((listener) =>
      listener({ position: [1, 0, 0], quaternion: [0, 0, 0, 1], timestampMs: 1 }),
    );
    expect(engine.applyDevicePose).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Magic Window" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(<MagicWindowControls {...props} />);
    expect(source.start).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole("button", { name: "Magic Window" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("ignores a cancelled startup resolving after a new session has begun", async () => {
    const pending = deferred();
    source.start.mockReturnValueOnce(pending.promise);
    const { props, rerender, onActiveChange } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Magic Window" }));
    rerender(<MagicWindowControls {...props} disabled />);
    rerender(<MagicWindowControls {...props} />);
    await enable();
    const calls = onActiveChange.mock.calls.length;
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(onActiveChange).toHaveBeenCalledTimes(calls);
    expect(source.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Exit Magic Window" })).toBeTruthy();
  });

  it("stops on backgrounding and keeps touch navigation available when returning", async () => {
    const { engine } = setup();
    await enable();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(engine.exitHandheldMode).toHaveBeenCalledOnce();
    expect(source.stop).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(source.start).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Magic Window" })).toBeTruthy();
  });

  it("cleans startup failure and permits an explicit retry", async () => {
    const { engine } = setup();
    source.start.mockRejectedValueOnce(new Error("Camera access is required."));
    fireEvent.click(await screen.findByRole("button", { name: "Magic Window" }));
    await screen.findByText("Camera access is required.");
    expect(engine.exitHandheldMode).toHaveBeenCalledOnce();
    expect(source.poses.size + source.qualities.size).toBe(0);
    await enable();
    expect(source.start).toHaveBeenCalledTimes(2);
  });

  it("recenters using the next physical sample and handles an unavailable platform", async () => {
    const { engine, unmount } = setup();
    await enable();
    act(() => {
      quality("normal");
      pose(1);
    });
    engine.enterHandheldMode.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Recenter" }));
    expect(engine.enterHandheldMode).not.toHaveBeenCalled();
    act(() => pose(200));
    expect(engine.enterHandheldMode).toHaveBeenCalledOnce();
    unmount();
    source.isAvailable.mockRejectedValueOnce(new Error("plugin unavailable"));
    setup();
    await waitFor(() => expect(source.isAvailable).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Magic Window" })).toBeNull();
  });
});
