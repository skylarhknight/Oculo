import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSharingService,
  DOWNLOAD_URL_RETENTION_MS,
  SHARE_CACHE_RETENTION_MS,
  type BrowserSharingPort,
  type NativeSharingPort,
  type ShareArtifact,
} from "./SharingService";

const plugins = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  share: { canShare: vi.fn(), share: vi.fn() },
  filesystem: { readdir: vi.fn(), writeFile: vi.fn(), rmdir: vi.fn() },
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: plugins.isNativePlatform } }));
vi.mock("@capacitor/share", () => ({ Share: plugins.share }));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE" },
  Encoding: { UTF8: "utf8" },
  Filesystem: plugins.filesystem,
}));

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const NOW = 1_800_000_000_000;
const UUID = "00000000-0000-4000-8000-000000000001";
const BATCH = `sheet-${NOW}-${UUID}`;

function page(name = "Location-page-01.png"): ShareArtifact {
  return { name, mimeType: "image/png", blob: new Blob([PNG], { type: "image/png" }) };
}

function video(): ShareArtifact {
  const header = new Uint8Array([
    0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 97, 118,
    99, 49,
  ]);
  return {
    name: "Location-camera-move.mp4",
    mimeType: "video/mp4",
    blob: new Blob([header], { type: "video/mp4" }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function browser(overrides: Partial<BrowserSharingPort> = {}): BrowserSharingPort {
  return {
    kind: "browser",
    createFile: ({ name, mimeType, blob }) => new File([blob], name, { type: mimeType }),
    canShare: vi.fn(() => true),
    share: vi.fn().mockResolvedValue(undefined),
    canDownload: true,
    download: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

function native(overrides: Partial<NativeSharingPort> = {}): NativeSharingPort {
  return {
    kind: "native",
    canShare: vi.fn().mockResolvedValue(true),
    listBatches: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn(async (batch, name) => `file:///cache/${batch}/${name}`),
    retainBatch: vi.fn().mockResolvedValue(undefined),
    removeBatch: vi.fn().mockResolvedValue(undefined),
    share: vi.fn().mockResolvedValue({ activityType: "com.example.recipient" }),
    ...overrides,
  };
}

function nativeService(port: NativeSharingPort) {
  let id = 0;
  return createSharingService(port, {
    now: () => NOW,
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  plugins.isNativePlatform.mockReturnValue(false);
  for (const method of [...Object.values(plugins.share), ...Object.values(plugins.filesystem)])
    method.mockReset();
});

describe("MP4 preview delivery", () => {
  it("prepares and shares native MP4 files with video labeling and cleans unshared files", async () => {
    plugins.isNativePlatform.mockReturnValue(true);
    plugins.share.canShare.mockResolvedValue({ value: true });
    plugins.filesystem.readdir.mockResolvedValue({ files: [] });
    plugins.filesystem.writeFile.mockImplementation(async ({ path }) => ({
      uri: `file:///cache/${path}`,
    }));
    plugins.filesystem.rmdir.mockResolvedValue(undefined);
    const prepared = await createSharingService(undefined, {
      now: () => NOW,
      createId: () => UUID,
    }).prepare([video()]);
    expect(plugins.filesystem.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `oculo-shot-sheets/${BATCH}/Location-camera-move.mp4`,
        data: expect.any(String),
      }),
    );
    prepared.dispose();
    expect(plugins.filesystem.rmdir).toHaveBeenCalledWith({
      directory: "CACHE",
      path: `oculo-shot-sheets/${BATCH}`,
      recursive: true,
    });
    const shareable = await createSharingService(undefined, {
      now: () => NOW,
      createId: () => UUID,
    }).prepare([video()]);
    plugins.share.share.mockResolvedValue({ activityType: "com.example.editor" });
    await shareable.share();
    expect(plugins.share.share).toHaveBeenCalledWith({
      files: [`file:///cache/oculo-shot-sheets/${BATCH}/Location-camera-move.mp4`],
      title: "Oculo camera move",
      dialogTitle: "Share video",
    });
  });

  it("preserves actual MP4 MIME and bytes for browser delivery", async () => {
    const port = browser();
    const artifact = video();
    const prepared = await createSharingService(port).prepare([artifact]);
    await prepared.share();
    const file = vi.mocked(port.share).mock.calls[0]![0][0]!;
    expect(file.type).toBe("video/mp4");
    expect(file.name).toBe(artifact.name);
    expect(await file.arrayBuffer()).toEqual(await artifact.blob.arrayBuffer());
  });

  it("rejects mismatched filenames, invalid MP4 headers, and oversized videos", async () => {
    const artifact = video();
    for (const invalid of [
      { ...artifact, name: "Move.png" },
      { ...artifact, blob: new Blob(["invalid video container bytes"], { type: "video/mp4" }) },
      {
        ...artifact,
        blob: new Blob([new Uint8Array(64 * 1024 * 1024 + 1)], { type: "video/mp4" }),
      },
    ])
      await expect(createSharingService(browser()).prepare([invalid])).rejects.toMatchObject({
        code: "invalid-files",
      });
  });

  it("removes the partial native video after a write failure or cancellation", async () => {
    const failing = native({ writeFile: vi.fn().mockRejectedValue(new Error("Disk full")) });
    await expect(nativeService(failing).prepare([video()])).rejects.toMatchObject({
      code: "storage",
    });
    expect(failing.removeBatch).toHaveBeenCalledWith(BATCH);
    const controller = new AbortController();
    const cancelled = native({
      writeFile: vi.fn(async () => {
        controller.abort();
        return "file:///cache/video.mp4";
      }),
    });
    await expect(
      nativeService(cancelled).prepare([video()], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.removeBatch).toHaveBeenCalledWith(BATCH);
  });
});

describe("browser sheet delivery", () => {
  it("checks the actual files before the click and shares synchronously while activation exists", async () => {
    let active = false;
    const share = vi.fn(() => {
      expect(active).toBe(true);
      return Promise.resolve();
    });
    const canShare = vi.fn((data: ShareData) => data.files !== undefined);
    vi.stubGlobal("navigator", { canShare, share });
    const prepared = await createSharingService().prepare([page(), page("Location-page-02.png")]);
    const files = canShare.mock.calls[0]?.[0] as unknown as { files: File[] };
    expect(files.files.map(({ name }) => name)).toEqual([
      "Location-page-01.png",
      "Location-page-02.png",
    ]);
    expect(files.files.every((file) => file.type === "image/png")).toBe(true);
    expect(share).not.toHaveBeenCalled();

    active = true;
    const sharing = prepared.share();
    expect(share).toHaveBeenCalledExactlyOnceWith({ files: files.files });
    active = false;
    await expect(sharing).resolves.toBe("shared");
    expect(canShare).toHaveBeenCalledTimes(1);
    prepared.dispose();
  });

  it.each(["unsupported", "throws", "no-File"])(
    "keeps page downloads available when file sharing is %s",
    async (mode) => {
      const port = browser({
        canShare:
          mode === "throws"
            ? () => {
                throw new TypeError("Files unsupported");
              }
            : () => false,
        ...(mode === "no-File" ? { createFile: () => undefined } : {}),
      });
      const prepared = await createSharingService(port).prepare([page()]);
      expect(prepared.canShare).toBe(false);
      expect(prepared.canDownload).toBe(true);
      await expect(prepared.share()).rejects.toMatchObject({ code: "unavailable" });
      vi.useFakeTimers();
      prepared.download(0);
      expect(port.download).toHaveBeenCalledTimes(1);
      await vi.runAllTimersAsync();
      prepared.dispose();
    },
  );

  it("starts only the selected page download and preserves its URL through closing before releasing it", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const anchor = { href: "", download: "", hidden: false, click, remove };
    const append = vi.fn();
    vi.stubGlobal("document", { createElement: () => anchor, body: { append } });
    vi.stubGlobal("navigator", {});
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download-page");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const second = page("Location-page-02.png");
    const prepared = await createSharingService().prepare([page(), second]);
    vi.useFakeTimers();
    prepared.download(1);
    expect(anchor.download).toBe(second.name);
    expect(create).toHaveBeenCalledExactlyOnceWith(second.blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(anchor);
    expect(remove).toHaveBeenCalledTimes(1);
    prepared.dispose();
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DOWNLOAD_URL_RETENTION_MS);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:download-page");
  });

  it("returns cancellation normally, permits retry, and retains downloads after denied sharing", async () => {
    const share = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("User cancelled", "AbortError"))
      .mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"))
      .mockResolvedValue(undefined);
    const prepared = await createSharingService(browser({ share })).prepare([page()]);
    await expect(prepared.share()).resolves.toBe("cancelled");
    await expect(prepared.share()).rejects.toMatchObject({ code: "unavailable" });
    expect(prepared.canDownload).toBe(true);
    await expect(prepared.share()).resolves.toBe("shared");
  });

  it("guards concurrent shares across prepared sheets and clears the guard after failure", async () => {
    const first = deferred<void>();
    const share = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const service = createSharingService(browser({ share }));
    const one = await service.prepare([page()]);
    const two = await service.prepare([page()]);
    const sharing = one.share();
    await expect(two.share()).rejects.toMatchObject({ code: "busy" });
    first.reject(new DOMException("Cancelled", "AbortError"));
    await expect(sharing).resolves.toBe("cancelled");
    await expect(two.share()).resolves.toBe("shared");
  });

  it("rejects disposed handles and invalid page choices without starting delivery", async () => {
    const port = browser();
    const prepared = await createSharingService(port).prepare([page()]);
    expect(() => prepared.download(-1)).toThrow("Choose an available page");
    expect(() => prepared.download(0.5)).toThrow("Choose an available page");
    prepared.dispose();
    await expect(prepared.share()).rejects.toMatchObject({ code: "disposed" });
    expect(() => prepared.download(0)).toThrow("Generate or prepare");
    expect(port.share).not.toHaveBeenCalled();
    expect(port.download).not.toHaveBeenCalled();
  });
});

describe("native sheet delivery", () => {
  it("uses only Capacitor cache files, recognizes a missing initial cache, and retains by timestamp", async () => {
    plugins.isNativePlatform.mockReturnValue(true);
    plugins.share.canShare.mockResolvedValue({ value: true });
    plugins.share.share.mockResolvedValue({ activityType: "recipient" });
    plugins.filesystem.readdir.mockRejectedValue({ code: "OS-PLUG-FILE-0008" });
    plugins.filesystem.writeFile.mockImplementation(async ({ path }: { path: string }) => ({
      uri: `file:///cache/${path}`,
    }));
    const prepared = await createSharingService(undefined, {
      now: () => NOW,
      createId: () => UUID,
    }).prepare([page()]);
    expect(plugins.filesystem.writeFile).toHaveBeenCalledWith({
      directory: "CACHE",
      path: `oculo-shot-sheets/${BATCH}/Location-page-01.png`,
      data: "iVBORw0KGgo=",
      recursive: true,
    });
    expect(plugins.filesystem.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: "CACHE",
        path: `oculo-shot-sheets/${BATCH}/retention.txt`,
        encoding: "utf8",
      }),
    );
    await prepared.share();
    expect(plugins.share.share).toHaveBeenCalledWith({
      files: [`file:///cache/oculo-shot-sheets/${BATCH}/Location-page-01.png`],
      title: "Oculo shot sheet",
      dialogTitle: "Share shot sheet",
    });
    prepared.dispose();
    expect(plugins.filesystem.rmdir).not.toHaveBeenCalled();
  });

  it("preserves a previously shared batch using its refreshed retention marker", async () => {
    plugins.isNativePlatform.mockReturnValue(true);
    plugins.share.canShare.mockResolvedValue({ value: true });
    const old = `sheet-${NOW - 2 * SHARE_CACHE_RETENTION_MS}-${UUID}`;
    plugins.filesystem.readdir
      .mockResolvedValueOnce({ files: [{ name: old, type: "directory" }] })
      .mockResolvedValueOnce({
        files: [
          { name: "Page.png", size: 8, mtime: NOW - 2 * SHARE_CACHE_RETENTION_MS },
          { name: "retention.txt", size: 30, mtime: NOW - 1000 },
        ],
      });
    plugins.filesystem.writeFile.mockImplementation(async ({ path }: { path: string }) => ({
      uri: `file:///cache/${path}`,
    }));
    plugins.filesystem.rmdir.mockResolvedValue(undefined);
    const prepared = await createSharingService(undefined, {
      now: () => NOW,
      createId: () => UUID,
    }).prepare([page()]);
    expect(plugins.filesystem.rmdir).not.toHaveBeenCalled();
    prepared.dispose();
    expect(plugins.filesystem.rmdir).toHaveBeenCalledExactlyOnceWith({
      directory: "CACHE",
      path: `oculo-shot-sheets/${BATCH}`,
      recursive: true,
    });
  });

  it("preserves exact PNG bytes across base64 conversion chunks", async () => {
    const bytes = new Uint8Array(80_003);
    bytes.set(PNG);
    for (let index = PNG.length; index < bytes.length; index++) bytes[index] = index % 251;
    const port = native();
    const prepared = await nativeService(port).prepare([
      { ...page(), blob: new Blob([bytes], { type: "image/png" }) },
    ]);
    const encoded = vi.mocked(port.writeFile).mock.calls[0]?.[2] ?? "";
    expect(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))).toEqual(bytes);
    prepared.dispose();
  });

  it("writes all PNG pages with progress before sharing and refreshes retention before each handoff", async () => {
    const port = native();
    const progress = vi.fn();
    const prepared = await nativeService(port).prepare([page(), page("Location-page-02.png")], {
      onProgress: progress,
    });
    expect(prepared.canDownload).toBe(false);
    expect(port.writeFile).toHaveBeenNthCalledWith(
      1,
      BATCH,
      "Location-page-01.png",
      "iVBORw0KGgo=",
    );
    expect(port.writeFile).toHaveBeenNthCalledWith(
      2,
      BATCH,
      "Location-page-02.png",
      "iVBORw0KGgo=",
    );
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
    expect(port.share).not.toHaveBeenCalled();
    await expect(prepared.share()).resolves.toBe("shared");
    expect(port.retainBatch).toHaveBeenCalledTimes(2);
    expect(port.share).toHaveBeenCalledWith([
      `file:///cache/${BATCH}/Location-page-01.png`,
      `file:///cache/${BATCH}/Location-page-02.png`,
    ]);
    prepared.dispose();
    expect(port.removeBatch).not.toHaveBeenCalled();
  });

  it.each([
    { result: { activityType: "" }, outcome: "dismissed" },
    { result: {}, outcome: "dismissed" },
  ])(
    "does not claim a handoff when native completion lacks the destination: $result",
    async ({ result, outcome }) => {
      const prepared = await nativeService(
        native({ share: vi.fn().mockResolvedValue(result) }),
      ).prepare([page()]);
      await expect(prepared.share()).resolves.toBe(outcome);
    },
  );

  it.each(["Share canceled", "Share cancelled"])(
    'treats "%s" as a normal cancellation and permits sharing again',
    async (message) => {
      const share = vi
        .fn()
        .mockRejectedValueOnce({ message })
        .mockResolvedValue({ activityType: "recipient" });
      const prepared = await nativeService(native({ share })).prepare([page()]);
      await expect(prepared.share()).resolves.toBe("cancelled");
      await expect(prepared.share()).resolves.toBe("shared");
    },
  );

  it("does not remove potentially handed-off files when the UI closes while sharing", async () => {
    const pending = deferred<{ activityType: string }>();
    const port = native({ share: vi.fn().mockReturnValue(pending.promise) });
    const prepared = await nativeService(port).prepare([page()]);
    const sharing = prepared.share();
    prepared.dispose();
    pending.resolve({ activityType: "recipient" });
    await sharing;
    expect(port.removeBatch).not.toHaveBeenCalled();
  });

  it("removes files when an unused preparation is disposed", async () => {
    const port = native();
    const prepared = await nativeService(port).prepare([page()]);
    prepared.dispose();
    prepared.dispose();
    expect(port.removeBatch).toHaveBeenCalledExactlyOnceWith(BATCH);
  });

  it("keeps a closed preview leased while its native share is still in flight", async () => {
    const pending = deferred<{ activityType: string }>();
    const listBatches = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: BATCH, retainedAt: 0, bytes: 8 }]);
    const port = native({ listBatches, share: vi.fn().mockReturnValue(pending.promise) });
    const service = nativeService(port);
    const first = await service.prepare([page()]);
    const sharing = first.share();
    first.dispose();
    const second = await service.prepare([page()]);
    expect(port.removeBatch).not.toHaveBeenCalled();
    pending.resolve({ activityType: "recipient" });
    await sharing;
    second.dispose();
  });

  it("cleans partial writes after storage failure and allows preparation to retry", async () => {
    const writeFile = vi
      .fn()
      .mockResolvedValueOnce("file:///cache/one.png")
      .mockRejectedValueOnce(
        new Error("ENOSPC file:///private/customer-image.png data:image/png;base64,secret"),
      )
      .mockResolvedValue("file:///cache/retry.png");
    const port = native({ writeFile });
    const service = nativeService(port);
    const failure = service.prepare([page(), page("Page-02.png")]);
    await expect(failure).rejects.toMatchObject({ code: "storage" });
    await expect(failure).rejects.not.toThrow("customer-image");
    await expect(failure).rejects.not.toThrow("base64");
    expect(port.removeBatch).toHaveBeenCalledExactlyOnceWith(BATCH);
    const prepared = await service.prepare([page()]);
    expect(prepared.canShare).toBe(true);
    prepared.dispose();
  });

  it("cancels after an in-flight write finishes, cleans it, and prevents concurrent preparation", async () => {
    const writing = deferred<string>();
    const started = deferred<void>();
    const port = native({
      writeFile: vi.fn(() => {
        started.resolve();
        return writing.promise;
      }),
    });
    const service = nativeService(port);
    const controller = new AbortController();
    const preparing = service.prepare([page(), page("Page-02.png")], { signal: controller.signal });
    await started.promise;
    await expect(service.prepare([page()])).rejects.toMatchObject({ code: "busy" });
    controller.abort();
    writing.resolve("file:///cache/page.png");
    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    expect(port.writeFile).toHaveBeenCalledTimes(1);
    expect(port.removeBatch).toHaveBeenCalledExactlyOnceWith(BATCH);
    expect(port.share).not.toHaveBeenCalled();
  });

  it("does not write files when aborted or when native sharing is unavailable", async () => {
    const port = native({ canShare: vi.fn().mockResolvedValue(false) });
    const service = nativeService(port);
    const controller = new AbortController();
    controller.abort();
    await expect(service.prepare([page()], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(service.prepare([page()])).rejects.toMatchObject({ code: "unavailable" });
    expect(port.writeFile).not.toHaveBeenCalled();
  });

  it("cleans only expired owned batches and preserves recent recipient access", async () => {
    const old = `sheet-${NOW - SHARE_CACHE_RETENTION_MS}-${UUID}`;
    const recent = `sheet-${NOW - 1000}-${UUID}`;
    const port = native({
      listBatches: vi.fn().mockResolvedValue([
        { name: old, retainedAt: NOW - SHARE_CACHE_RETENTION_MS, bytes: 100 },
        { name: recent, retainedAt: NOW - 1000, bytes: 100 },
        { name: "../customer-scenes", retainedAt: 0, bytes: 100 },
      ]),
    });
    const prepared = await nativeService(port).prepare([page()]);
    expect(port.removeBatch).toHaveBeenCalledExactlyOnceWith(old);
    prepared.dispose();
  });

  it("keeps an active preview leased even when its cache entry appears old", async () => {
    const listBatches = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: BATCH, retainedAt: 0, bytes: 8 }]);
    const port = native({ listBatches });
    const service = nativeService(port);
    const first = await service.prepare([page()]);
    const second = await service.prepare([page()]);
    expect(port.removeBatch).not.toHaveBeenCalled();
    first.dispose();
    second.dispose();
  });

  it("bounds cache growth without evicting recently shared pages", async () => {
    const port = native({
      listBatches: vi
        .fn()
        .mockResolvedValue([{ name: BATCH, retainedAt: NOW, bytes: 256 * 1024 * 1024 }]),
    });
    await expect(nativeService(port).prepare([page()])).rejects.toMatchObject({ code: "storage" });
    expect(port.removeBatch).not.toHaveBeenCalled();
    expect(port.writeFile).not.toHaveBeenCalled();
  });

  it("does not open a share if the retention refresh fails", async () => {
    const retainBatch = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Disk is full"));
    const port = native({ retainBatch });
    const prepared = await nativeService(port).prepare([page()]);
    await expect(prepared.share()).rejects.toMatchObject({ code: "storage" });
    expect(port.share).not.toHaveBeenCalled();
  });
});

describe("artifact validation", () => {
  it.each([
    "../scene.png",
    "folder/scene.png",
    "file\\scene.png",
    ".hidden.png",
    "page.png\n",
    "page.jpg",
    "a".repeat(161) + ".png",
  ])("rejects unsafe or misleading filenames: %s", async (name) => {
    const port = browser();
    await expect(createSharingService(port).prepare([page(name)])).rejects.toMatchObject({
      code: "invalid-files",
    });
    expect(port.share).not.toHaveBeenCalled();
  });

  it("rejects empty, duplicate, wrong-MIME and corrupt image artifacts", async () => {
    const service = createSharingService(browser());
    for (const artifacts of [
      [],
      [page("Page.png"), page("page.png")],
      [{ ...page(), mimeType: "application/pdf" }],
      [{ ...page(), blob: new Blob([PNG], { type: "text/plain" }) }],
      [{ ...page(), blob: new Blob(["not a PNG file"], { type: "image/png" }) }],
    ]) {
      await expect(service.prepare(artifacts)).rejects.toMatchObject({ code: "invalid-files" });
    }
  });

  it("rejects oversized pages and total output without silently dropping pages", async () => {
    const service = createSharingService(browser());
    const large = new Blob([PNG, new Uint8Array(20 * 1024 * 1024 - PNG.length)], {
      type: "image/png",
    });
    await expect(
      service.prepare([{ ...page(), blob: new Blob([large, PNG], { type: "image/png" }) }]),
    ).rejects.toMatchObject({ code: "invalid-files" });
    const pages = Array.from({ length: 6 }, (_, index) => ({
      ...page(`Page-${index}.png`),
      blob: large,
    }));
    await expect(service.prepare(pages)).rejects.toMatchObject({ code: "invalid-files" });
    await expect(
      service.prepare(Array.from({ length: 101 }, (_, index) => page(`Page-${index}.png`))),
    ).rejects.toMatchObject({ code: "invalid-files" });
  });

  it("captures file descriptors by value before asynchronous validation", async () => {
    const port = browser();
    const artifact = page();
    const preparing = createSharingService(port).prepare([artifact]);
    artifact.name = "Changed.png";
    artifact.mimeType = "text/plain";
    const prepared = await preparing;
    expect(prepared.files).toEqual([
      { name: "Location-page-01.png", mimeType: "image/png", size: 8 },
    ]);
    expect(Object.isFrozen(prepared.files)).toBe(true);
    await prepared.share();
    expect((vi.mocked(port.share).mock.calls[0]?.[0] ?? []).map(({ name }) => name)).toEqual([
      "Location-page-01.png",
    ]);
  });
});
