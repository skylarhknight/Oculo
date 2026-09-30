// @vitest-environment jsdom
import { movingShot } from "../test/projectFixtures";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneEngine } from "@oculo/scene-core";
import { DEFAULT_CAMERA } from "../types/project";
import { VideoExportDialog } from "./VideoExportDialog";
import type { VideoAttribution } from "../services/videoExport/attribution";

const mocks = vi.hoisted(() => ({
  export: vi.fn(),
  prepare: vi.fn(),
  share: vi.fn(),
  download: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../services/videoExport", () => ({ exportShotVideo: mocks.export }));
vi.mock("../services/SharingService", () => ({
  createSharingService: () => ({ prepare: mocks.prepare }),
}));
const result = {
  blob: new Blob(["mp4"], { type: "video/mp4" }),
  name: "Move.mp4",
  width: 1280,
  height: 720,
  frameCount: 150,
  durationSeconds: 5,
};
function open(attribution?: VideoAttribution) {
  const onClose = vi.fn();
  const view = render(
    <VideoExportDialog
      engine={{} as SceneEngine}
      shots={[
        movingShot({ sceneId: "scene", assetVersionId: "legacy-scene:scene" }, [
          { timeSeconds: 0, camera: DEFAULT_CAMERA },
          { timeSeconds: 5, camera: DEFAULT_CAMERA },
        ]),
      ]}
      projectName="Project"
      {...(attribution ? { attribution } : {})}
      onClose={onClose}
    />,
  );
  return { ...view, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.export.mockResolvedValue(result);
  mocks.prepare.mockResolvedValue({
    canShare: true,
    canDownload: true,
    share: mocks.share,
    download: mocks.download,
    dispose: mocks.dispose,
  });
  mocks.share.mockResolvedValue("shared");
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:video-preview"),
      revokeObjectURL: vi.fn(),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("video export dialog", () => {
  it("exports several shots as one sequence and names the shot being rendered", async () => {
    const shot = (name: string) => ({
      ...movingShot({ sceneId: "scene", assetVersionId: "legacy-scene:scene" }, [
        { timeSeconds: 0, camera: DEFAULT_CAMERA },
        { timeSeconds: 2, camera: DEFAULT_CAMERA },
      ]),
      id: name,
      name,
    });
    const shots = [shot("Wide"), shot("Close")];
    let report: ((value: unknown) => void) | undefined;
    mocks.export.mockImplementationOnce(({ onProgress }) => {
      report = onProgress;
      return new Promise(() => undefined);
    });
    render(
      <VideoExportDialog
        engine={{} as SceneEngine}
        shots={shots}
        projectName="Project"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Export shot sequence" })).toBeDefined();
    expect(screen.getByText(/Share 2 shots as one 4-second MP4/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({ shot: shots }));
    act(() => report?.({ phase: "rendering", completed: 70, total: 120, shotIndex: 1 }));
    expect(screen.getByText("Rendering Close · frame 70 of 120")).toBeDefined();
  });

  it("shows the scene credit and passes it into the exported MP4", async () => {
    const attribution = {
      text: "Garden by Creator",
      url: "https://example.com/scene",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    };
    open(attribution);
    expect(screen.getByText(/Garden by Creator/).textContent).toContain("Changes: Camera framing");
    expect(screen.getByText(/Garden by Creator/).textContent).toContain(attribution.licenseUrl);
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("button", { name: "Share video" });
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({ attribution }));
  });
  it("exports only after a click and shares/downloads the prepared file on separate clicks", async () => {
    const view = open();
    expect(mocks.export).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("button", { name: "Share video" });
    expect(mocks.prepare).toHaveBeenCalledWith(
      [{ name: "Move.mp4", mimeType: "video/mp4", blob: result.blob }],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Share video" }));
    expect(mocks.share).toHaveBeenCalledOnce();
    await screen.findByText("Video handed to the sharing app.");
    fireEvent.click(screen.getByRole("button", { name: "Download MP4" }));
    expect(mocks.download).toHaveBeenCalledWith(0);
    view.unmount();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:video-preview");
  });

  it("cancels an in-progress export, keeps the dialog open, and allows retry", async () => {
    mocks.export.mockImplementationOnce(
      ({ signal, onProgress }) =>
        new Promise((_, reject) => {
          onProgress({ phase: "rendering", completed: 10, total: 150 });
          signal.addEventListener("abort", () =>
            reject(new DOMException("Cancelled", "AbortError")),
          );
        }),
    );
    const { onClose } = open();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("10");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    await screen.findByText("Export cancelled. Your camera move is unchanged.");
    expect(mocks.prepare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("button", { name: "Share video" });
  });

  it("retries file preparation without encoding again after a storage failure", async () => {
    mocks.prepare.mockRejectedValueOnce(new Error("Storage full"));
    open();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Prepare sharing" }));
    await screen.findByRole("button", { name: "Share video" });
    expect(mocks.export).toHaveBeenCalledOnce();
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
  });

  it("cancels export when the app is backgrounded", async () => {
    mocks.export.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Cancelled", "AbortError")),
          );
        }),
    );
    open();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByText("Export cancelled. Your camera move is unchanged.");
    expect(mocks.export.mock.calls[0]![0].signal.aborted).toBe(true);
    visibility.mockRestore();
  });

  it("aborts on unmount and disposes a prepared share that arrives late", async () => {
    let finish!: (value: unknown) => void;
    mocks.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = open();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
    const signal = mocks.prepare.mock.calls[0]![1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ dispose: mocks.dispose }));
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
