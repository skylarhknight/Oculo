import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

export interface ShareArtifact {
  name: string;
  mimeType: string;
  blob: Blob;
}

export type ShareOutcome = "shared" | "cancelled" | "dismissed";
export type SharingErrorCode =
  "invalid-files" | "busy" | "unavailable" | "storage" | "failed" | "disposed";

export class SharingError extends Error {
  constructor(
    readonly code: SharingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SharingError";
  }
}

export interface PreparedShare {
  readonly files: ReadonlyArray<Readonly<{ name: string; mimeType: string; size: number }>>;
  readonly canShare: boolean;
  readonly canDownload: boolean;
  /** Invoke directly from an explicit click. This reports handoff, not receipt. */
  share(): Promise<ShareOutcome>;
  /** One explicit click per page; browsers may block automatic multiple downloads. */
  download(index: number): void;
  dispose(): void;
}

export interface PrepareShareOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number }) => void;
}

export interface SharingService {
  prepare(
    artifacts: readonly ShareArtifact[],
    options?: PrepareShareOptions,
  ): Promise<PreparedShare>;
}

/** Application-owned delivery ports keep Capacitor types inside this adapter. */
export interface BrowserSharingPort {
  kind: "browser";
  createFile(artifact: ShareArtifact): File | undefined;
  canShare(files: File[]): boolean;
  share(files: File[]): Promise<void>;
  canDownload: boolean;
  /** Starts one download and returns the URL release operation. */
  download(artifact: ShareArtifact): () => void;
}

export interface CachedShareBatch {
  name: string;
  retainedAt: number;
  bytes: number;
}

export interface NativeSharingPort {
  kind: "native";
  canShare(): Promise<boolean>;
  listBatches(): Promise<CachedShareBatch[]>;
  writeFile(batch: string, name: string, base64: string): Promise<string>;
  retainBatch(batch: string): Promise<void>;
  removeBatch(batch: string): Promise<void>;
  share(files: string[]): Promise<{ activityType?: string }>;
}

const MAX_FILES = 100;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
export const SHARE_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DOWNLOAD_URL_RETENTION_MS = 60_000;
const CACHE_DIRECTORY = "oculo-shot-sheets";
const BATCH_PATTERN =
  /^sheet-(\d{1,16})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_JSON_FILE_BYTES = 5 * 1024 * 1024;

type ArtifactKind = "png" | "mp4" | "json";
const KIND_BY_MIME: Readonly<Record<string, ArtifactKind>> = {
  "image/png": "png",
  "video/mp4": "mp4",
  "application/json": "json",
};

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("File preparation cancelled.", "AbortError");
}

function errorDetails(error: unknown): { name: string; code: string; message: string } {
  if (typeof error !== "object" || error === null) return { name: "", code: "", message: "" };
  const value = error as Record<string, unknown>;
  return {
    name: typeof value.name === "string" ? value.name : "",
    code: typeof value.code === "string" ? value.code : "",
    message: typeof value.message === "string" ? value.message : "",
  };
}

function isCancellation(error: unknown): boolean {
  const { name, message, code } = errorDetails(error);
  return (
    name === "AbortError" ||
    /^(share|sharing) cancel(?:l)?ed\.?$/i.test(message) ||
    code === "USER_CANCELLED"
  );
}

function normalizeError(error: unknown, preparing = false): SharingError {
  if (error instanceof SharingError) return error;
  const { name, message, code } = errorDetails(error);
  if (/in progress|already sharing/i.test(message) || name === "InvalidStateError") {
    return new SharingError("busy", "Another share is still open. Close it and try again.");
  }
  if (
    /not implemented|unavailable|not supported/i.test(message) ||
    ["UNIMPLEMENTED", "UNAVAILABLE"].includes(code)
  ) {
    return new SharingError("unavailable", "File sharing is unavailable on this device.");
  }
  if (
    preparing ||
    /space|storage|disk|quota|ENOSPC/i.test(message) ||
    name === "QuotaExceededError"
  ) {
    return new SharingError(
      "storage",
      "The files could not be prepared on this device. Check available storage and try again.",
    );
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new SharingError(
      "unavailable",
      "This browser did not allow file sharing. Use a page download or try Share again.",
    );
  }
  // Never surface plugin payloads, file URLs, base64 data, or customer content.
  return new SharingError(
    "failed",
    "The share could not be completed. Your preview is still available to retry.",
  );
}

function validFileName(name: string, extension: ArtifactKind): boolean {
  return (
    name.length <= 160 &&
    name === name.trim() &&
    !name.startsWith(".") &&
    /^[\p{L}\p{N} _().-]+\.(png|mp4|json)$/u.test(name) &&
    name.endsWith(`.${extension}`)
  );
}

async function validateArtifacts(
  artifacts: readonly ShareArtifact[],
  signal?: AbortSignal,
): Promise<ShareArtifact[]> {
  if (artifacts.length < 1 || artifacts.length > MAX_FILES) {
    throw new SharingError(
      "invalid-files",
      `Prepare between 1 and ${MAX_FILES} PNG pages or MP4 previews.`,
    );
  }
  const names = new Set<string>();
  let total = 0;
  // Blob bytes are immutable; copy the descriptors before the first await.
  const files = artifacts.map((artifact) => ({ ...artifact }));
  for (const file of files) {
    abortIfNeeded(signal);
    const kind = KIND_BY_MIME[file.mimeType];
    const isVideo = kind === "mp4";
    const key = file.name.normalize("NFC").toLocaleLowerCase();
    if (
      kind === undefined ||
      !validFileName(file.name, kind) ||
      names.has(key) ||
      file.blob.type !== file.mimeType ||
      file.blob.size < (isVideo ? 24 : kind === "json" ? 2 : 8) ||
      file.blob.size >
        (isVideo ? MAX_VIDEO_FILE_BYTES : kind === "json" ? MAX_JSON_FILE_BYTES : MAX_FILE_BYTES)
    ) {
      throw new SharingError(
        "invalid-files",
        "Every file needs a unique filename matching its type: PNG images up to 20 MB, MP4 previews up to 64 MB, or JSON data up to 5 MB.",
      );
    }
    names.add(key);
    total += file.blob.size;
    if (total > MAX_ARTIFACT_BYTES) {
      throw new SharingError(
        "invalid-files",
        "These pages exceed the 100 MB delivery limit. Prepare fewer pages at a time.",
      );
    }
    if (kind === "json") {
      let parsed: boolean;
      try {
        const value: unknown = JSON.parse(await file.blob.text());
        parsed = typeof value === "object" && value !== null;
      } catch {
        parsed = false;
      }
      if (!parsed)
        throw new SharingError(
          "invalid-files",
          "A prepared file does not match its format. Generate the export again.",
        );
      continue;
    }
    const header = new Uint8Array(await file.blob.slice(0, isVideo ? 24 : 8).arrayBuffer());
    const validHeader = isVideo
      ? String.fromCharCode(...header.subarray(4, 8)) === "ftyp" &&
        new DataView(header.buffer).getUint32(0) >= 16 &&
        new DataView(header.buffer).getUint32(0) <= file.blob.size &&
        ["isom", "iso2", "mp41", "mp42", "avc1"].includes(
          String.fromCharCode(...header.subarray(8, 12)),
        )
      : PNG_SIGNATURE.every((byte, index) => byte === header[index]);
    if (!validHeader) {
      throw new SharingError(
        "invalid-files",
        "A prepared file does not match its format. Generate the export again.",
      );
    }
  }
  abortIfNeeded(signal);
  return files;
}

async function toBase64(blob: Blob, signal?: AbortSignal): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  // A multiple of three lets encoded chunks join without interior padding.
  const chunkSize = 24 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    abortIfNeeded(signal);
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))));
    if (offset > 0 && offset % (chunkSize * 32) === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  abortIfNeeded(signal);
  return chunks.join("");
}

class ArtifactSharingService implements SharingService {
  private preparing = false;
  private sharing = false;
  private readonly activeBatches = new Set<string>();

  constructor(
    private readonly port: BrowserSharingPort | NativeSharingPort,
    private readonly now: () => number,
    private readonly createId: () => string,
  ) {}

  async prepare(
    artifacts: readonly ShareArtifact[],
    options: PrepareShareOptions = {},
  ): Promise<PreparedShare> {
    if (this.preparing) throw new SharingError("busy", "File preparation is already in progress.");
    this.preparing = true;
    let batch: string | undefined;
    const port = this.port;
    try {
      const files = await validateArtifacts(artifacts, options.signal);
      options.onProgress?.({ completed: 0, total: files.length });
      if (port.kind === "browser") {
        const browserFiles = files.flatMap((file) => {
          const browserFile = port.createFile(file);
          return browserFile === undefined ? [] : [browserFile];
        });
        let canShare = false;
        try {
          canShare = browserFiles.length === files.length && port.canShare(browserFiles);
        } catch {
          /* Download remains available. */
        }
        options.onProgress?.({ completed: files.length, total: files.length });
        abortIfNeeded(options.signal);
        return this.prepared(
          files,
          canShare,
          port.canDownload,
          () => port.share(browserFiles),
          port,
        );
      }

      if (!(await port.canShare()))
        throw new SharingError("unavailable", "File sharing is unavailable on this device.");
      await this.cleanCache(
        port,
        files.reduce((sum, file) => sum + file.blob.size, 0),
      );
      abortIfNeeded(options.signal);
      batch = `sheet-${this.now()}-${this.createId()}`;
      if (!BATCH_PATTERN.test(batch))
        throw new SharingError("failed", "A temporary file location could not be created.");
      this.activeBatches.add(batch);
      const uris: string[] = [];
      for (const [index, file] of files.entries()) {
        const base64 = await toBase64(file.blob, options.signal);
        const uri = await port.writeFile(batch, file.name, base64);
        if (!uri.startsWith("file://"))
          throw new SharingError("failed", "The temporary page could not be opened for sharing.");
        uris.push(uri);
        abortIfNeeded(options.signal);
        options.onProgress?.({ completed: index + 1, total: files.length });
      }
      await port.retainBatch(batch);
      abortIfNeeded(options.signal);
      const preparedBatch = batch;
      return this.prepared(
        files,
        true,
        false,
        async () => {
          // Retain for a full day after every handoff attempt, including retries.
          try {
            await port.retainBatch(preparedBatch);
          } catch (error) {
            throw normalizeError(error, true);
          }
          return port.share(uris);
        },
        undefined,
        preparedBatch,
      );
    } catch (error) {
      if (batch !== undefined && port.kind === "native") {
        this.activeBatches.delete(batch);
        await port.removeBatch(batch).catch(() => undefined);
      }
      if (isCancellation(error))
        throw new DOMException("File preparation cancelled.", "AbortError");
      throw normalizeError(error, port.kind === "native");
    } finally {
      this.preparing = false;
    }
  }

  private prepared(
    artifacts: ShareArtifact[],
    canShare: boolean,
    canDownload: boolean,
    performShare: () => Promise<void | { activityType?: string }>,
    browser?: BrowserSharingPort,
    batch?: string,
  ): PreparedShare {
    let disposed = false;
    let attemptedShare = false;
    let sharingHere = false;
    const releaseBatch = () => {
      if (batch !== undefined && this.port.kind === "native") {
        this.activeBatches.delete(batch);
        if (!attemptedShare) void this.port.removeBatch(batch).catch(() => undefined);
      }
    };
    const assertOpen = () => {
      if (disposed)
        throw new SharingError("disposed", "Generate or prepare the sheet again before sharing.");
    };
    return {
      files: Object.freeze(
        artifacts.map(({ name, mimeType, blob }) =>
          Object.freeze({ name, mimeType, size: blob.size }),
        ),
      ),
      canShare,
      canDownload,
      share: async () => {
        assertOpen();
        if (!canShare)
          throw new SharingError(
            "unavailable",
            "This browser cannot share these files. Download each page instead.",
          );
        if (this.sharing)
          throw new SharingError("busy", "Another share is still open. Close it and try again.");
        this.sharing = true;
        sharingHere = true;
        attemptedShare = true;
        try {
          // No await, file conversion, or capability query before this call:
          // browser implementations must consume the original click activation.
          const result = await performShare();
          return browser !== undefined || result?.activityType ? "shared" : "dismissed";
        } catch (error) {
          if (isCancellation(error)) return "cancelled";
          throw normalizeError(error);
        } finally {
          this.sharing = false;
          sharingHere = false;
          if (disposed) releaseBatch();
        }
      },
      download: (index) => {
        assertOpen();
        if (!canDownload || browser === undefined)
          throw new SharingError("unavailable", "Page downloads are unavailable here. Use Share.");
        const artifact = artifacts[index];
        if (!Number.isInteger(index) || artifact === undefined)
          throw new SharingError("invalid-files", "Choose an available page to download.");
        try {
          const release = browser.download(artifact);
          // Do not revoke on modal close: the browser may not have read the URL
          // yet. Each download releases its own URL after a bounded grace period.
          setTimeout(release, DOWNLOAD_URL_RETENTION_MS);
        } catch (error) {
          throw normalizeError(error);
        }
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // Keep the lease while retention is being refreshed or a native sheet
        // is open. Once a recipient may hold a URI, TTL cleanup owns the files.
        if (!sharingHere) releaseBatch();
      },
    };
  }

  private async cleanCache(port: NativeSharingPort, incomingBytes: number): Promise<void> {
    let retainedBytes = 0;
    for (const batch of await port.listBatches()) {
      if (!BATCH_PATTERN.test(batch.name)) continue;
      if (
        !this.activeBatches.has(batch.name) &&
        this.now() - batch.retainedAt >= SHARE_CACHE_RETENTION_MS
      ) {
        try {
          await port.removeBatch(batch.name);
          continue;
        } catch {
          /* Count files that could not be removed. */
        }
      }
      retainedBytes += Math.max(0, batch.bytes);
    }
    if (retainedBytes + incomingBytes > MAX_CACHE_BYTES) {
      throw new SharingError(
        "storage",
        "Temporary share storage is full. Recently shared files are retained for 24 hours; try again after they expire.",
      );
    }
  }
}

function browserPort(): BrowserSharingPort {
  return {
    kind: "browser",
    createFile: ({ blob, name, mimeType }) =>
      typeof File === "undefined" ? undefined : new File([blob], name, { type: mimeType }),
    canShare: (files) =>
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files }),
    share: (files) => navigator.share({ files }),
    canDownload:
      typeof document !== "undefined" &&
      "download" in document.createElement("a") &&
      typeof URL.createObjectURL === "function",
    download: ({ blob, name }) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.hidden = true;
      document.body.append(anchor);
      try {
        anchor.click();
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      } finally {
        anchor.remove();
      }
      return () => URL.revokeObjectURL(url);
    },
  };
}

function missingFile(error: unknown): boolean {
  const { message, code } = errorDetails(error);
  return (
    code === "OS-PLUG-FILE-0008" || /does not exist|not exist|no such file|not found/i.test(message)
  );
}

function nativePort(): NativeSharingPort {
  const path = (batch: string, name?: string) =>
    `${CACHE_DIRECTORY}/${batch}${name === undefined ? "" : `/${name}`}`;
  return {
    kind: "native",
    canShare: async () => (await Share.canShare()).value,
    listBatches: async () => {
      let entries;
      try {
        entries = (await Filesystem.readdir({ directory: Directory.Cache, path: CACHE_DIRECTORY }))
          .files;
      } catch (error) {
        if (missingFile(error)) return [];
        throw error;
      }
      const batches: CachedShareBatch[] = [];
      for (const entry of entries) {
        const match = BATCH_PATTERN.exec(entry.name);
        if (entry.type !== "directory" || match === null) continue;
        const files = (
          await Filesystem.readdir({ directory: Directory.Cache, path: path(entry.name) })
        ).files;
        const retention = files.find((file) => file.name === "retention.txt");
        batches.push({
          name: entry.name,
          retainedAt: Math.max(Number(match[1]), retention?.mtime ?? 0),
          bytes: files.reduce((sum, file) => sum + file.size, 0),
        });
      }
      return batches;
    },
    writeFile: async (batch, name, data) =>
      (
        await Filesystem.writeFile({
          directory: Directory.Cache,
          path: path(batch, name),
          data,
          recursive: true,
        })
      ).uri,
    retainBatch: async (batch) => {
      await Filesystem.writeFile({
        directory: Directory.Cache,
        path: path(batch, "retention.txt"),
        data: "Retain for recipient access.",
        encoding: Encoding.UTF8,
        recursive: true,
      });
    },
    removeBatch: async (batch) => {
      await Filesystem.rmdir({ directory: Directory.Cache, path: path(batch), recursive: true });
    },
    share: (files) => {
      const video = files.some((file) => file.endsWith(".mp4"));
      return Share.share({
        files,
        title: video ? "Oculo camera move" : "Oculo shot sheet",
        dialogTitle: video ? "Share video" : "Share shot sheet",
      });
    },
  };
}

export function createSharingService(
  port: BrowserSharingPort | NativeSharingPort = Capacitor.isNativePlatform()
    ? nativePort()
    : browserPort(),
  options: { now?: () => number; createId?: () => string } = {},
): SharingService {
  return new ArtifactSharingService(
    port,
    options.now ?? Date.now,
    options.createId ?? (() => crypto.randomUUID()),
  );
}
