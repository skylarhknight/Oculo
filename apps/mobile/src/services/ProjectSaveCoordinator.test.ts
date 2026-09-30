import { migrated } from "../test/projectFixtures";
import { migrateScene } from "@oculo/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CAMERA, type Project } from "../types/project";
import { ProjectSaveCoordinator, type ProjectSaveState } from "./ProjectSaveCoordinator";

function makeProject(name = "Location"): Project {
  return migrated({
    sceneId: "scene",
    assetVersionId: "legacy-scene:scene",
    schemaVersion: 2,
    id: "project",
    name,
    scene: migrateScene({ id: "scene", name: "Scene", splatUrl: "/scene.spz", source: "bundled" }),
    updatedAt: 1,
    durationSeconds: 8,
    camera: structuredClone(DEFAULT_CAMERA),
    shots: [],
    path: {
      sceneId: "scene",
      assetVersionId: "legacy-scene:scene",
      id: "path",
      name: "Move",
      keyframes: [],
    },
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ProjectSaveCoordinator", () => {
  it("debounces edits and saves an immutable snapshot of the complete project", async () => {
    const put = vi.fn<(project: Project) => Promise<void>>().mockResolvedValue(undefined);
    const saves = new ProjectSaveCoordinator({ put });
    saves.schedule(makeProject("Earlier"));
    await vi.advanceTimersByTimeAsync(200);

    const latest = makeProject("Latest");
    saves.schedule(latest);
    latest.name = "Mutation after scheduling";
    latest.scenes[0]!.camera.pose.position[0] = 99;

    await vi.advanceTimersByTimeAsync(349);
    expect(put).not.toHaveBeenCalled();
    expect(saves.getState().status).toBe("saving");
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledExactlyOnceWith(makeProject("Latest"));
    expect(saves.getState().status).toBe("saved");
  });

  it("commits during continuous camera movement instead of postponing forever", async () => {
    const put = vi.fn<(project: Project) => Promise<void>>().mockResolvedValue(undefined);
    const saves = new ProjectSaveCoordinator({ put });
    saves.schedule(makeProject());
    for (let frame = 1; frame <= 9; frame += 1) {
      await vi.advanceTimersByTimeAsync(100);
      saves.schedule(makeProject(`Frame ${frame}`));
    }
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(put).toHaveBeenCalledExactlyOnceWith(makeProject("Frame 9"));
    expect(saves.getState().status).toBe("saved");
  });

  it("flushes before a debounce expires without creating a second delayed write", async () => {
    const put = vi.fn<(project: Project) => Promise<void>>().mockResolvedValue(undefined);
    const saves = new ProjectSaveCoordinator({ put });
    saves.schedule(makeProject());
    await saves.flush();
    expect(put).toHaveBeenCalledTimes(1);
    expect(saves.getState().status).toBe("saved");
    await vi.advanceTimersByTimeAsync(1500);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("serializes writes and waits for newer edits without reporting an older save as current", async () => {
    const first = deferred();
    const second = deferred();
    const put = vi
      .fn<(project: Project) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const saves = new ProjectSaveCoordinator({ put });
    const states: ProjectSaveState[] = [];
    saves.subscribe((state) => states.push(state));

    const flushing = saves.flush(makeProject("First"));
    let finished = false;
    void flushing.then(() => {
      finished = true;
    });
    saves.schedule(makeProject("Intermediate"));
    saves.schedule(makeProject("Latest"));
    expect(saves.flush()).toBe(flushing);
    expect(put).toHaveBeenCalledTimes(1);

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(makeProject("Latest"));
    expect(saves.getState().status).toBe("saving");
    expect(states.map(({ status }) => status)).toEqual(["saved", "saving"]);
    expect(finished).toBe(false);

    second.resolve();
    await flushing;
    expect(finished).toBe(true);
    expect(saves.getState().status).toBe("saved");
  });

  it("retains the latest edits after a failed background write and retries them", async () => {
    const first = deferred();
    const put = vi
      .fn<(project: Project) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const saves = new ProjectSaveCoordinator({ put });
    saves.schedule(makeProject("First"));
    await vi.advanceTimersByTimeAsync(350);
    saves.schedule(makeProject("Latest"));
    first.reject(new Error("Storage is full"));
    await vi.advanceTimersByTimeAsync(0);

    expect(saves.getState()).toEqual({ status: "error", error: "Storage is full" });
    expect(put).toHaveBeenCalledTimes(1);
    await saves.retry();
    expect(put).toHaveBeenLastCalledWith(makeProject("Latest"));
    expect(saves.getState()).toEqual({ status: "saved" });
  });

  it.each([false, true])(
    "includes edits scheduled from a saved notification before flush settles (microtask: %s)",
    async (inMicrotask) => {
      const second = deferred();
      const put = vi
        .fn<(project: Project) => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockReturnValueOnce(second.promise);
      const saves = new ProjectSaveCoordinator({ put });
      saves.schedule(makeProject("First"));
      let queuedNext = false;
      saves.subscribe(({ status }) => {
        if (status !== "saved" || queuedNext) return;
        queuedNext = true;
        const queue = () => saves.schedule(makeProject("From save notification"));
        if (inMicrotask) void Promise.resolve().then(queue);
        else queue();
      });

      const flushing = saves.flush();
      let finished = false;
      void flushing.then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(put).toHaveBeenCalledTimes(2);
      expect(put).toHaveBeenLastCalledWith(makeProject("From save notification"));
      expect(finished).toBe(false);
      expect(saves.getState().status).toBe("saving");

      second.resolve();
      await flushing;
      expect(saves.getState().status).toBe("saved");
      await vi.advanceTimersByTimeAsync(1500);
      expect(put).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects an explicit save on failure so navigation can retain the editor", async () => {
    const put = vi
      .fn<(project: Project) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Disk unavailable"))
      .mockResolvedValue(undefined);
    const saves = new ProjectSaveCoordinator({ put });
    await expect(saves.flush(makeProject())).rejects.toThrow("Disk unavailable");
    expect(saves.getState().status).toBe("error");

    await saves.retry();
    expect(put).toHaveBeenCalledTimes(2);
    expect(saves.getState().status).toBe("saved");
  });

  it("removes subscribers without abandoning a pending save", async () => {
    const put = vi.fn<(project: Project) => Promise<void>>().mockResolvedValue(undefined);
    const saves = new ProjectSaveCoordinator({ put });
    const listener = vi.fn();
    const unsubscribe = saves.subscribe(listener);
    saves.schedule(makeProject());
    unsubscribe();
    await saves.flush();
    expect(listener.mock.calls.map(([state]) => (state as ProjectSaveState).status)).toEqual([
      "saved",
      "saving",
    ]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("prevents another editor from replacing this project in the save queue", async () => {
    const put = vi.fn<(project: Project) => Promise<void>>().mockResolvedValue(undefined);
    const saves = new ProjectSaveCoordinator({ put });
    saves.schedule(makeProject());
    expect(() => saves.schedule({ ...makeProject(), id: "another" })).toThrow("between editors");
    await saves.flush();
    expect(put).toHaveBeenCalledExactlyOnceWith(makeProject());
  });
});
