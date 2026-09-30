import { migrateScene } from "@oculo/scene-schema";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportSceneModal } from "./ImportSceneModal";
import { DEFAULT_CAMERA } from "../types/project";
import { prepareSceneImport, type PreparedSceneImport } from "../services/sceneImport";

vi.mock("../services/sceneImport", () => ({ prepareSceneImport: vi.fn() }));
const prepared: PreparedSceneImport = {
  camera: DEFAULT_CAMERA,
  scene: migrateScene({
    id: "local",
    name: "My scene",
    source: "imported",
    splatUrl: "oculo-asset:abc",
    localAsset: { version: 1, id: "abc", filename: "location.spz", format: "spz", byteLength: 1 },
  }),
  asset: {
    id: "abc",
    descriptor: { version: 1, id: "abc", filename: "location.spz", format: "spz", byteLength: 1 },
    data: new Blob(["a"]),
  },
};
async function chooseFile() {
  await userEvent.upload(screen.getByLabelText("Scene file"), new File(["a"], "location.spz"));
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("ImportSceneModal", () => {
  it("imports selected bytes with editable name and orientation then waits for durable save", async () => {
    vi.mocked(prepareSceneImport).mockResolvedValue(prepared);
    let finish!: () => void;
    const onImport = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onClose = vi.fn();
    render(<ImportSceneModal onClose={onClose} onImport={onImport} />);
    expect(
      (screen.getByRole("button", { name: "Import location" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await chooseFile();
    fireEvent.change(screen.getByLabelText("Location name"), { target: { value: "Our set" } });
    fireEvent.change(screen.getByLabelText("Orientation"), { target: { value: "flip-y" } });
    fireEvent.submit(screen.getByRole("button", { name: "Import location" }).closest("form")!);
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(prepared, expect.any(AbortSignal)));
    expect(prepareSceneImport).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ name: "Our set", orientation: "flip-y" }),
    );
    expect(screen.getByRole("progressbar")).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows validation failures without saving anything", async () => {
    vi.mocked(prepareSceneImport).mockRejectedValue(new Error("The SPZ file is truncated"));
    const onImport = vi.fn();
    render(<ImportSceneModal onClose={vi.fn()} onImport={onImport} />);
    await chooseFile();
    fireEvent.submit(screen.getByRole("button", { name: "Import location" }).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("truncated");
    expect(onImport).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Import location" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("allows retry after a failed durable save without choosing the file again", async () => {
    vi.mocked(prepareSceneImport).mockResolvedValue(prepared);
    const onImport = vi
      .fn()
      .mockRejectedValueOnce(new Error("Storage is full"))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(<ImportSceneModal onClose={onClose} onImport={onImport} />);
    await chooseFile();
    fireEvent.submit(screen.getByRole("button", { name: "Import location" }).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("Storage is full");
    fireEvent.submit(screen.getByRole("button", { name: "Import location" }).closest("form")!);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onImport).toHaveBeenCalledTimes(2);
  });

  it("cancels pending validation with Escape and retains the form for a fresh attempt", async () => {
    vi.mocked(prepareSceneImport).mockImplementation(
      (_file, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Canceled", "AbortError")),
            { once: true },
          );
        }),
    );
    const onClose = vi.fn();
    const onImport = vi.fn();
    render(<ImportSceneModal onClose={onClose} onImport={onImport} />);
    await chooseFile();
    fireEvent.submit(screen.getByRole("button", { name: "Import location" }).closest("form")!);
    await userEvent.keyboard("{Escape}");
    expect((await screen.findByRole("status")).textContent).toContain("Import canceled");
    expect(onImport).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Location name") as HTMLInputElement).value).toBe("location");
  });

  it("passes cancellation to a pending transaction and aborts on unmount", async () => {
    vi.mocked(prepareSceneImport).mockResolvedValue(prepared);
    let signal!: AbortSignal;
    const onImport = vi.fn(
      (_prepared, activeSignal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal = activeSignal;
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Canceled", "AbortError")),
            { once: true },
          );
        }),
    );
    const onClose = vi.fn();
    const view = render(<ImportSceneModal onClose={onClose} onImport={onImport} />);
    await chooseFile();
    fireEvent.submit(screen.getByRole("button", { name: "Import location" }).closest("form")!);
    await waitFor(() => expect(onImport).toHaveBeenCalled());
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
