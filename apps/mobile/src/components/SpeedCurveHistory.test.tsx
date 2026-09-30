// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shotAsPath } from "@oculo/camera-core";
import type { CameraPath, Shot } from "@oculo/scene-schema";
import { movingShot } from "../test/projectFixtures";
import { CameraEditHistory, cameraEditSnapshot } from "../services/CameraEditHistory";
import { DEFAULT_CAMERA } from "../types/project";
import { SpeedCurveEditor } from "./SpeedCurveEditor";

const pathOf = (snapshot: { shot: Shot | null }) => shotAsPath(snapshot.shot!);

/** Writes the editor's curves back onto the shot's keyframes, as the Compose panel does. */
function withCurves(shot: Shot, path: CameraPath): Shot {
  return {
    ...shot,
    keyframes: shot.keyframes.map((frame, index) => {
      const curve = path.keyframes[index]?.speedCurve;
      const { speedCurve: _old, ...rest } = frame;
      void _old;
      return curve ? { ...rest, speedCurve: curve } : rest;
    }),
  };
}

function setup() {
  const path: CameraPath = {
    sceneId: "scene",
    assetVersionId: "legacy-scene:scene",
    id: "editable-move",
    name: "Move",
    keyframes: [0, 4, 8].map((timeSeconds, index) => ({
      timeSeconds,
      camera: { ...DEFAULT_CAMERA, pose: { ...DEFAULT_CAMERA.pose, position: [index * 2, 1, 4] } },
      ...(index < 2
        ? {
            speedCurve: {
              version: 1 as const,
              points: [
                { time: 0, speed: 1, intensity: 0.5 },
                { time: 0.5, speed: 1, intensity: 0.5 },
                { time: 1, speed: 1, intensity: 0.5 },
              ],
            },
          }
        : {}),
    })),
  };
  const original = cameraEditSnapshot(
    DEFAULT_CAMERA,
    movingShot(path, path.keyframes, { id: path.id, durationSeconds: 8 }),
  );
  const history = new CameraEditHistory();
  let latest = original;
  const begin = vi.fn(() => history.begin());
  const finish = vi.fn(() => history.commit());
  function Editor({ disabled = false }: { disabled?: boolean }) {
    const [snapshot, setSnapshot] = useState(original);
    const apply = (value: typeof original | null) => {
      if (!value) return;
      latest = value;
      setSnapshot(value);
    };
    return (
      <>
        <button onClick={() => apply(history.undo())}>Undo</button>
        <button onClick={() => apply(history.redo())}>Redo</button>
        <SpeedCurveEditor
          path={pathOf(snapshot)}
          disabled={disabled}
          onEditStart={begin}
          onEditEnd={finish}
          onChange={(nextPath) => {
            const next = cameraEditSnapshot(
              snapshot.camera,
              withCurves(snapshot.shot!, nextPath),
              snapshot.playheadSeconds,
            );
            history.record(snapshot, next);
            apply(next);
          }}
        />
      </>
    );
  }
  const result = render(<Editor />);
  return {
    ...result,
    original,
    history,
    begin,
    finish,
    latest: () => latest,
    disable: () => result.rerender(<Editor disabled />),
  };
}

function pointer(target: Element, type: string, x: number, y: number, pointerType = "mouse") {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType } });
  fireEvent(target, event);
}

beforeEach(() => {
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 360,
    bottom: 192,
    width: 360,
    height: 192,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("speed curve gesture history", () => {
  it.each(["mouse", "touch"])(
    "undoes an entire %s drag with one action and redoes its final curve",
    (pointerType) => {
      const { original, latest, history, begin, finish } = setup();
      const graph = screen.getByRole("group", { name: "Speed curve graph" });
      const handle = screen.getByRole("slider", { name: "Speed point 2" });
      pointer(handle, "pointerdown", 188, 125.5, pointerType);
      pointer(graph, "pointermove", 170, 100, pointerType);
      pointer(graph, "pointermove", 210, 60, pointerType);
      pointer(graph, "pointermove", 240, 80, pointerType);
      pointer(graph, "pointerup", 240, 80, pointerType);
      const edited = structuredClone(latest());
      expect(pathOf(edited)).not.toEqual(pathOf(original));
      expect(begin).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(latest()).toEqual(original);
      expect(history.canUndo).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Redo" }));
      expect(latest()).toEqual(edited);
      expect(pathOf(edited).keyframes.map((frame) => [frame.timeSeconds, frame.camera])).toEqual(
        pathOf(original).keyframes.map((frame) => [frame.timeSeconds, frame.camera]),
      );
    },
  );

  it("groups repeated arrow keys until keyup, then gives the next press its own undo", () => {
    const { original, latest, history } = setup();
    const handle = screen.getByRole("slider", { name: "Speed point 2" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "ArrowUp", repeat: true });
    fireEvent.keyDown(handle, { key: "ArrowUp", repeat: true });
    fireEvent.keyUp(handle, { key: "ArrowUp" });
    const held = structuredClone(latest());
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyUp(handle, { key: "ArrowRight", shiftKey: true });
    expect(pathOf(latest())).not.toEqual(pathOf(held));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(latest()).toEqual(held);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(latest()).toEqual(original);
    expect(history.canUndo).toBe(false);
  });

  it.each(["pointercancel", "lostpointercapture", "disable", "unmount"])(
    "commits interrupted graph edits once on %s",
    (interruption) => {
      const { original, latest, history, finish, disable, unmount } = setup();
      const graph = screen.getByRole("group", { name: "Speed curve graph" });
      const handle = screen.getByRole("slider", { name: "Speed point 2" });
      pointer(handle, "pointerdown", 188, 125.5, "touch");
      pointer(graph, "pointermove", 210, 90, "touch");
      const edited = structuredClone(latest());
      if (interruption === "disable") disable();
      else if (interruption === "unmount") unmount();
      else pointer(graph, interruption, 210, 90, "touch");
      expect(finish).toHaveBeenCalledOnce();
      expect(history.undo()).toEqual(original);
      expect(history.canUndo).toBe(false);
      expect(history.redo()).toEqual(edited);
    },
  );

  it("keeps separate history entries when leaving a numeric edit for another segment", () => {
    const { original, latest, history } = setup();
    const speed = screen.getByRole("spinbutton", { name: "Point relative speed" });
    fireEvent.focus(speed);
    fireEvent.change(speed, { target: { value: "1.5" } });
    fireEvent.change(speed, { target: { value: "2.5" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Speed curve segment" }), {
      target: { value: "1" },
    });
    const first = structuredClone(latest());
    fireEvent.click(screen.getByRole("button", { name: "Ease in" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(latest()).toEqual(first);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(latest()).toEqual(original);
    expect(history.canUndo).toBe(false);
  });

  it("does not consume an undo entry for dragging a point away and back", () => {
    const { original, latest, history } = setup();
    const graph = screen.getByRole("group", { name: "Speed curve graph" });
    const handle = screen.getByRole("slider", { name: "Speed point 2" });
    pointer(handle, "pointerdown", 188, 125.5);
    pointer(graph, "pointermove", 250, 60);
    pointer(graph, "pointermove", 188, 125.5);
    pointer(graph, "pointerup", 188, 125.5);
    expect(latest()).toEqual(original);
    expect(history.canUndo).toBe(false);
  });

  it("groups intensity slider changes until pointer release and preserves redo until a new edit", () => {
    const { original, latest, history } = setup();
    const intensity = screen.getByRole("slider", { name: "Curve intensity" });
    pointer(intensity, "pointerdown", 80, 10);
    fireEvent.change(intensity, { target: { value: "60" } });
    fireEvent.change(intensity, { target: { value: "90" } });
    pointer(intensity, "pointerup", 120, 10);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(latest()).toEqual(original);
    expect(history.canRedo).toBe(true);
    act(() => intensity.focus());
    fireEvent.keyDown(intensity, { key: "ArrowRight" });
    fireEvent.change(intensity, { target: { value: "51" } });
    fireEvent.keyUp(intensity, { key: "ArrowRight" });
    expect(history.canRedo).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(latest()).toEqual(original);
    expect(history.canUndo).toBe(false);
  });
});
