import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA } from "../types/project";
import { CameraEditHistory, cameraEditSnapshot } from "./CameraEditHistory";

const snapshot = (focalLengthMm = 35) =>
  cameraEditSnapshot({ ...structuredClone(DEFAULT_CAMERA), focalLengthMm }, null);

describe("camera edit history", () => {
  it("coalesces a continuous gesture, restores both directions, and isolates snapshot mutations", () => {
    const history = new CameraEditHistory();
    history.begin();
    history.record(snapshot(35), snapshot(36));
    history.record(snapshot(36), snapshot(85));
    history.commit();
    const undone = history.undo()!;
    expect(undone.camera.focalLengthMm).toBe(35);
    expect(history.canUndo).toBe(false);
    undone.camera.focalLengthMm = 99;
    expect(history.redo()?.camera.focalLengthMm).toBe(85);
    expect(history.undo()?.camera.focalLengthMm).toBe(35);
  });
  it("preserves redo through a no-op gesture but clears it after a new edit", () => {
    const history = new CameraEditHistory();
    history.record(snapshot(35), snapshot(85));
    history.undo();
    history.begin();
    history.record(snapshot(35), snapshot(36));
    history.record(snapshot(36), snapshot(35));
    history.commit();
    expect(history.canRedo).toBe(true);
    history.record(snapshot(35), snapshot(50));
    expect(history.canRedo).toBe(false);
  });
  it("commits interrupted gestures before undo and bounds history without retaining project assets", () => {
    const history = new CameraEditHistory(2);
    history.record(snapshot(14), snapshot(20));
    history.record(snapshot(20), snapshot(35));
    history.begin();
    history.record(snapshot(35), snapshot(85));
    expect(history.undo()?.camera.focalLengthMm).toBe(35);
    expect(history.undo()?.camera.focalLengthMm).toBe(20);
    expect(history.undo()).toBeNull();
    expect(Object.keys(snapshot())).toEqual(["camera", "shot", "playheadSeconds"]);
  });
});
