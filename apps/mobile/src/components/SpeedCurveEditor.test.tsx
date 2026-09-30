// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpeedCurvePreset } from "@oculo/camera-core";
import { MAX_SPEED_CURVE_POINTS, type CameraPath } from "@oculo/scene-schema";
import { DEFAULT_CAMERA } from "../types/project";
import { SpeedCurveEditor } from "./SpeedCurveEditor";

function makePath(segments = 1): CameraPath {
  return {
    sceneId: "scene",
    assetVersionId: "legacy-scene:scene",
    id: "test-move",
    name: "Dolly move",
    keyframes: Array.from({ length: segments + 1 }, (_, index) => ({
      timeSeconds: index * 4,
      camera: { ...DEFAULT_CAMERA, pose: { ...DEFAULT_CAMERA.pose, position: [index, 1, 4] } },
    })),
  };
}

function setup(initial = makePath(), disabled = false, timeSeconds?: number) {
  const onChange = vi.fn();
  let latest = initial;
  function Controlled({ disabled }: { disabled: boolean }) {
    const [path, setPath] = useState(initial);
    return (
      <SpeedCurveEditor
        path={path}
        disabled={disabled}
        {...(timeSeconds === undefined ? {} : { timeSeconds })}
        onChange={(next) => {
          latest = next;
          onChange(next);
          setPath(next);
        }}
      />
    );
  }
  const result = render(<Controlled disabled={disabled} />);
  return {
    ...result,
    onChange,
    latest: () => latest,
    setDisabled: (value: boolean) => result.rerender(<Controlled disabled={value} />),
  };
}

function point(number: number) {
  return screen.getByRole("slider", { name: `Speed point ${number}` });
}
function edit(name: string, value: string) {
  fireEvent.change(screen.getByRole("spinbutton", { name }), { target: { value } });
}
function pointer(element: Element, type: string, clientX = 0, clientY = 0, pointerId = 7) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  fireEvent(element, event);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SpeedCurveEditor", () => {
  it("edits only the chosen outgoing segment and resets it without moving cameras or arrival times", () => {
    const original = makePath(2);
    original.keyframes[0]!.speedCurve = createSpeedCurvePreset("ease-out");
    const { latest } = setup(original);
    fireEvent.change(screen.getByRole("combobox", { name: "Speed curve segment" }), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ease in" }));
    expect(latest().keyframes[1]!.speedCurve).toEqual(createSpeedCurvePreset("ease-in"));
    expect(latest().keyframes[0]).toBe(original.keyframes[0]);
    expect(latest().keyframes[2]).toBe(original.keyframes[2]);
    expect(latest().keyframes[1]!.camera).toBe(original.keyframes[1]!.camera);
    expect(latest().keyframes.map((frame) => frame.timeSeconds)).toEqual([0, 4, 8]);
    expect(original.keyframes[1]!.speedCurve).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(latest()).toEqual(original);
  });

  it("adds, edits, and removes timing points independently of camera waypoints", () => {
    const { latest } = setup();
    fireEvent.click(screen.getByRole("button", { name: "+ Add point" }));
    expect(latest().keyframes[0]!.speedCurve!.points[1]).toEqual({
      time: 0.5,
      speed: 1,
      intensity: 0.5,
    });
    edit("Point time (seconds)", "1.2");
    edit("Point relative speed", "2.5");
    fireEvent.change(screen.getByRole("slider", { name: "Curve intensity" }), {
      target: { value: "65" },
    });
    expect(latest().keyframes[0]!.speedCurve!.points[1]).toEqual({
      time: 0.3,
      speed: 2.5,
      intensity: 0.65,
    });
    expect(latest().keyframes).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove point" }));
    expect(latest().keyframes[0]!.speedCurve!.points).toHaveLength(2);
    expect(
      (screen.getByRole("button", { name: "Remove point" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("spinbutton", { name: "Point time (seconds)" }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps normalized curve shape when segment duration changes and shows a local playback cursor", () => {
    const path = makePath();
    path.keyframes[0]!.speedCurve = createSpeedCurvePreset("ease-in-out");
    path.keyframes[0]!.timeSeconds = 2;
    path.keyframes[1]!.timeSeconds = 10;
    const onChange = vi.fn();
    const { rerender } = render(
      <SpeedCurveEditor path={path} onChange={onChange} timeSeconds={6} />,
    );
    fireEvent.click(point(2));
    expect(
      (screen.getByRole("spinbutton", { name: "Point time (seconds)" }) as HTMLInputElement).value,
    ).toBe("4");
    expect(screen.getByLabelText("Playback position").getAttribute("x1")).toBe("188");
    rerender(
      <SpeedCurveEditor
        path={{
          ...path,
          keyframes: [path.keyframes[0]!, { ...path.keyframes[1]!, timeSeconds: 18 }],
        }}
        onChange={onChange}
        timeSeconds={1}
      />,
    );
    expect(
      (screen.getByRole("spinbutton", { name: "Point time (seconds)" }) as HTMLInputElement).value,
    ).toBe("8");
    expect(screen.queryByLabelText("Playback position")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clamps numeric and keyboard edits to valid speeds and noncrossing times", () => {
    const { latest } = setup();
    fireEvent.click(screen.getByRole("button", { name: "+ Add point" }));
    edit("Point time (seconds)", "-100");
    expect(latest().keyframes[0]!.speedCurve!.points[1]!.time).toBe(0.01);
    edit("Point time (seconds)", "100");
    expect(latest().keyframes[0]!.speedCurve!.points[1]!.time).toBe(0.99);
    edit("Point relative speed", "9");
    expect(latest().keyframes[0]!.speedCurve!.points[1]!.speed).toBe(4);
    fireEvent.keyDown(point(2), { key: "ArrowUp" });
    expect(latest().keyframes[0]!.speedCurve!.points[1]!.speed).toBe(4);
    fireEvent.keyDown(point(2), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(point(2), { key: "ArrowDown" });
    expect(latest().keyframes[0]!.speedCurve!.points[1]!.time).toBeCloseTo(0.89);
    expect(latest().keyframes[0]!.speedCurve!.points[1]!.speed).toBeCloseTo(3.9);
    edit("Point relative speed", "-2");
    expect(latest().keyframes[0]!.speedCurve!.points[1]!.speed).toBe(0);
    fireEvent.keyDown(point(1), { key: "ArrowRight" });
    fireEvent.keyDown(point(3), { key: "ArrowLeft" });
    expect(latest().keyframes[0]!.speedCurve!.points.map((current) => current.time)).toEqual([
      0, 0.89, 1,
    ]);
  });

  it("accepts precise numeric times within a short segment without a step mismatch", () => {
    const path = makePath();
    path.keyframes[1]!.timeSeconds = 0.01;
    path.keyframes[0]!.speedCurve = createSpeedCurvePreset("ease-in-out");
    const { latest } = setup(path);
    fireEvent.click(point(2));
    const time = screen.getByRole("spinbutton", {
      name: "Point time (seconds)",
    }) as HTMLInputElement;
    expect(time.value).toBe("0.005");
    expect(time.min).toBe("0.0001");
    expect(time.max).toBe("0.0099");
    expect(time.step).toBe("any");
    edit("Point time (seconds)", "0.0025");
    expect(time.value).toBe("0.0025");
    expect(time.validity.stepMismatch).toBe(false);
    expect(latest().keyframes[0]!.speedCurve!.points.map((current) => current.time)).toEqual([
      0, 0.25, 1,
    ]);
  });

  it("converts scaled pointer coordinates, clamps drags, and releases capture on cancel", () => {
    const { latest, onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "+ Add point" }));
    const graph = screen.getByRole("group", { name: "Speed curve graph" });
    vi.spyOn(graph, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      width: 720,
      height: 384,
      right: 820,
      bottom: 434,
      toJSON: () => ({}),
    });
    const handle = point(2);
    const setCapture = vi.fn();
    const releaseCapture = vi.fn();
    Object.assign(handle, {
      setPointerCapture: setCapture,
      hasPointerCapture: () => true,
      releasePointerCapture: releaseCapture,
    });
    pointer(handle, "pointerdown");
    expect(setCapture).toHaveBeenCalledWith(7);
    pointer(graph, "pointermove", 663.2, 155);
    expect(latest().keyframes[0]!.speedCurve!.points[1]!.time).toBeCloseTo(0.8);
    expect(latest().keyframes[0]!.speedCurve!.points[1]!.speed).toBeCloseTo(3);
    pointer(graph, "pointermove", 2000, -100);
    expect(latest().keyframes[0]!.speedCurve!.points[1]).toMatchObject({ time: 0.99, speed: 4 });
    const calls = onChange.mock.calls.length;
    pointer(graph, "pointermove", 100, 100, 99);
    expect(onChange).toHaveBeenCalledTimes(calls);
    pointer(graph, "pointercancel");
    expect(releaseCapture).toHaveBeenCalledWith(7);
    pointer(graph, "pointermove", 100, 100);
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it("rejects all-zero profiles and removing the only moving point", () => {
    const { latest, onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Ease in / out" }));
    fireEvent.click(point(2));
    const valid = latest();
    edit("Point relative speed", "0");
    expect(screen.getByRole("alert").textContent).toContain("above zero");
    expect(latest()).toBe(valid);
    fireEvent.click(screen.getByRole("button", { name: "Remove point" }));
    expect(latest()).toBe(valid);
    expect(onChange).toHaveBeenCalledTimes(1);
    edit("Point relative speed", "1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps closely spaced persisted points ordered during all types of edits", () => {
    const path = makePath();
    path.keyframes[0]!.speedCurve = {
      version: 1,
      points: [0, 0.001, 0.002, 0.003, 1].map((time) => ({ time, speed: 1, intensity: 0 })),
    };
    const { latest } = setup(path);
    fireEvent.click(point(3));
    edit("Point relative speed", "2");
    fireEvent.change(screen.getByRole("slider", { name: "Curve intensity" }), {
      target: { value: "80" },
    });
    expect(latest().keyframes[0]!.speedCurve!.points[2]).toEqual({
      time: 0.002,
      speed: 2,
      intensity: 0.8,
    });
    edit("Point time (seconds)", "100");
    fireEvent.keyDown(point(3), { key: "ArrowLeft" });
    expect(latest().keyframes[0]!.speedCurve!.points.map((current) => current.time)).toEqual([
      0, 0.001, 0.002, 0.003, 1,
    ]);
  });

  it.each(["Constant", "Reset", "Remove point", "+ Add point"])(
    "cancels an active drag when %s changes curve points",
    (action) => {
      const path = makePath();
      path.keyframes[0]!.speedCurve = {
        version: 1,
        points: [0, 0.25, 0.75, 1].map((time) => ({ time, speed: 1, intensity: 0 })),
      };
      const { onChange } = setup(path);
      const handle = point(3);
      const releaseCapture = vi.fn();
      Object.assign(handle, {
        setPointerCapture: vi.fn(),
        hasPointerCapture: () => true,
        releasePointerCapture: releaseCapture,
      });
      const graph = screen.getByRole("group", { name: "Speed curve graph" });
      vi.spyOn(graph, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: 360,
        height: 192,
        right: 360,
        bottom: 192,
        toJSON: () => ({}),
      });
      pointer(handle, "pointerdown");
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(releaseCapture).toHaveBeenCalledWith(7);
      const calls = onChange.mock.calls.length;
      pointer(graph, "pointermove", 180, 100);
      expect(onChange).toHaveBeenCalledTimes(calls);
    },
  );

  it("enforces the point limit", () => {
    const { latest } = setup();
    for (let index = 2; index < MAX_SPEED_CURVE_POINTS; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "+ Add point" }));
    }
    expect(latest().keyframes[0]!.speedCurve!.points).toHaveLength(MAX_SPEED_CURVE_POINTS);
    expect(
      (screen.getByRole("button", { name: "+ Add point" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("blocks every edit while disabled and ends an active drag when playback disables it", () => {
    const { onChange, setDisabled } = setup();
    const handle = point(1);
    const releaseCapture = vi.fn();
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: releaseCapture,
    });
    pointer(handle, "pointerdown");
    setDisabled(true);
    expect(releaseCapture).toHaveBeenCalledWith(7);
    fireEvent.click(screen.getByRole("button", { name: "Ease in" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add point" }));
    edit("Point relative speed", "2");
    fireEvent.change(screen.getByRole("slider", { name: "Curve intensity" }), {
      target: { value: "75" },
    });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    pointer(handle, "pointerdown");
    pointer(screen.getByRole("group", { name: "Speed curve graph" }), "pointermove", 200, 100);
    expect(onChange).not.toHaveBeenCalled();
    expect(handle.getAttribute("tabindex")).toBe("-1");
    setDisabled(false);
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("renders nothing until a segment exists", () => {
    const { container } = setup(makePath(0));
    expect(container.innerHTML).toBe("");
  });

  it("observes a graph added after mount and keeps labels and handles at their native size on resize", () => {
    let width = 218;
    let notifyResize = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width,
      height: 192,
      right: width,
      bottom: 192,
      toJSON: () => ({}),
    }));
    const onChange = vi.fn();
    const { rerender, unmount } = render(
      <SpeedCurveEditor path={makePath(0)} onChange={onChange} />,
    );
    expect(observe).not.toHaveBeenCalled();
    rerender(<SpeedCurveEditor path={makePath()} onChange={onChange} />);
    const graph = screen.getByRole("group", { name: "Speed curve graph" });
    expect(observe).toHaveBeenCalledWith(graph);
    expect(graph.getAttribute("viewBox")).toBe("0 0 218 192");
    expect(point(2).getAttribute("cx")).toBe("202");
    width = 310;
    act(() => notifyResize());
    expect(graph.getAttribute("viewBox")).toBe("0 0 310 192");
    expect(point(2).getAttribute("cx")).toBe("294");
    expect(point(2).getAttribute("r")).toBe("22");
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
