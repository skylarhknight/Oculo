import type { SceneWorkspace } from "../../types/project";
import {
  createShotSheet,
  SHOT_SHEET_LIMITS,
  ShotSheetError,
  type SheetDocument,
  type ShotSheetIssue,
} from "./model";
import { layoutShotSheet } from "./layout";

export const SHEET_FONT_FAMILY =
  'Arial, "Geeza Pro", "Arial Unicode MS", "Hiragino Sans", "Apple Color Emoji", "Noto Naskh Arabic", "Noto Sans CJK JP", "Noto Color Emoji", sans-serif';

export interface GeneratedSheetPage {
  readonly name: string;
  readonly mimeType: "image/png";
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  /** Ordered text painted on this page; generateShotSheet always sets this value. */
  readonly text?: string;
}
export interface ShotSheetProgress {
  readonly phase: "images" | "pages";
  readonly completed: number;
  readonly total: number;
}
export interface SheetImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}
export interface ShotSheetEnvironment {
  createCanvas(): HTMLCanvasElement;
  loadImage(dataUrl: string, signal?: AbortSignal): Promise<SheetImage>;
  waitForFonts(signal?: AbortSignal): Promise<void>;
}
export interface GenerateShotSheetOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ShotSheetProgress) => void;
  /** Injectable platform surface for deterministic tests and artifact verification. */
  environment?: ShotSheetEnvironment;
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ShotSheetError("cancelled", "Shot sheet generation cancelled.");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  checkCancellation(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ShotSheetError("cancelled", "Shot sheet generation cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export const browserShotSheetEnvironment: ShotSheetEnvironment = {
  createCanvas: () => document.createElement("canvas"),
  async waitForFonts(signal) {
    // System fonts cover Unicode through platform fallback; no customer content
    // or font request is sent to an external renderer.
    if (document.fonts)
      await abortable(
        document.fonts.load(`25px ${SHEET_FONT_FAMILY}`).then(() => undefined),
        signal,
      );
  },
  loadImage(dataUrl, signal) {
    checkCancellation(signal);
    return new Promise((resolve, reject) => {
      const image = new Image();
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        image.src = "";
        reject(new ShotSheetError("cancelled", "Shot sheet generation cancelled."));
      };
      image.onload = () => {
        cleanup();
        resolve({
          source: image,
          width: image.naturalWidth,
          height: image.naturalHeight,
          close: () => {
            image.src = "";
          },
        });
      };
      image.onerror = () => {
        cleanup();
        image.src = "";
        reject(new Error("The saved image cannot be decoded."));
      };
      signal?.addEventListener("abort", abort, { once: true });
      image.src = dataUrl;
    });
  },
};

/** Read dimensions before decoding so a small compressed file cannot allocate a giant bitmap. */
export function inspectSheetImage(dataUrl: string): { width: number; height: number } {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2]!.length > (SHOT_SHEET_LIMITS.imageBytes * 4) / 3 + 4)
    throw new Error("Unsupported or oversized saved image.");
  let raw: string;
  try {
    raw = atob(match[2]!);
  } catch {
    throw new Error("Saved image has invalid base64 data.");
  }
  const bytes = Uint8Array.from(raw, (value) => value.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  let width = 0;
  let height = 0;
  if (
    match[1] === "png" &&
    bytes.length >= 24 &&
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (match[1] === "jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 7
      ) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    match[1] === "webp" &&
    bytes.length >= 30 &&
    view.getUint32(0) === 0x52494646 &&
    view.getUint32(8) === 0x57454250
  ) {
    const chunk = view.getUint32(12);
    if (chunk === 0x56503858) {
      width = 1 + bytes[24]! + bytes[25]! * 256 + bytes[26]! * 65536;
      height = 1 + bytes[27]! + bytes[28]! * 256 + bytes[29]! * 65536;
    } else if (
      chunk === 0x56503820 &&
      bytes[23] === 0x9d &&
      bytes[24] === 1 &&
      bytes[25] === 0x2a
    ) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else if (chunk === 0x5650384c && bytes[20] === 0x2f) {
      width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
      height = 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10);
    }
  }
  if (
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height > SHOT_SHEET_LIMITS.imagePixels
  ) {
    throw new Error("Saved image is corrupt or exceeds the 4-megapixel image limit.");
  }
  return { width, height };
}

async function decodeImage(
  dataUrl: string,
  environment: ShotSheetEnvironment,
  signal?: AbortSignal,
): Promise<SheetImage> {
  inspectSheetImage(dataUrl);
  const image = await environment.loadImage(dataUrl, signal);
  if (
    !Number.isFinite(image.width) ||
    !Number.isFinite(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width > 4096 ||
    image.height > 4096 ||
    image.width * image.height > SHOT_SHEET_LIMITS.imagePixels
  ) {
    image.close();
    throw new Error("The decoded image dimensions are invalid.");
  }
  if (signal?.aborted) {
    image.close();
    checkCancellation(signal);
  }
  return image;
}

function encode(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  return abortable(
    new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => {
        if (blob && blob.size && blob.type === "image/png") resolve(blob);
        else
          reject(new ShotSheetError("render", "The device could not encode the shot sheet image."));
      }, "image/png"),
    ),
    signal,
  );
}

function fileStem(title: string): string {
  return (
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "Oculo"
  );
}

/** Generates bounded PNG pages from one immutable snapshot, returning no partial result. */
export async function generateShotSheet(
  input: SheetDocument | SceneWorkspace,
  options: GenerateShotSheetOptions = {},
): Promise<GeneratedSheetPage[]> {
  const document = "kind" in input ? input : createShotSheet(input);
  const environment = options.environment ?? browserShotSheetEnvironment;
  const { signal, onProgress } = options;
  checkCancellation(signal);
  const issues: ShotSheetIssue[] = [...document.imageIssues];
  for (const [index, shot] of document.shots.entries()) {
    checkCancellation(signal);
    if (!issues.some((issue) => issue.shotId === shot.id)) {
      try {
        const image = await decodeImage(shot.imageDataUrl!, environment, signal);
        image.close();
      } catch (error) {
        checkCancellation(signal);
        issues.push({
          shotId: shot.id,
          reason: `${error instanceof Error ? error.message : "Saved image could not be read."} Recapture or exclude this shot.`,
        });
      }
    }
    onProgress?.({ phase: "images", completed: index + 1, total: document.shots.length });
  }
  if (issues.length)
    throw new ShotSheetError(
      "invalid-images",
      "Some included shots need a saved image. Recapture or exclude them, then generate again.",
      issues,
    );
  let canvas: HTMLCanvasElement | undefined;
  try {
    await environment.waitForFonts(signal);
    checkCancellation(signal);
    canvas = environment.createCanvas();
    canvas.width = SHOT_SHEET_LIMITS.width;
    canvas.height = SHOT_SHEET_LIMITS.height;
    const context = canvas.getContext("2d");
    if (!context)
      throw new ShotSheetError("render", "This device cannot create a 2D shot sheet canvas.");
    const font = (size: number, bold: boolean) =>
      `${bold ? "600" : "400"} ${size}px ${SHEET_FONT_FAMILY}`;
    const layouts = layoutShotSheet(document, (text, size, bold) => {
      context.font = font(size, bold);
      return context.measureText(text).width;
    });
    const pages: GeneratedSheetPage[] = [];
    let outputBytes = 0;
    for (const page of layouts) {
      checkCancellation(signal);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.textAlign = "left";
      context.textBaseline = "top";
      for (const element of page.elements) {
        checkCancellation(signal);
        if (element.kind === "text") {
          context.font = font(element.size, element.bold);
          context.fillStyle = element.color;
          context.direction = element.direction ?? "ltr";
          context.textAlign = element.direction === "rtl" ? "right" : "left";
          context.fillText(element.text, element.x, element.y);
        } else if (element.kind === "line") {
          context.fillStyle = "#dbe3d7";
          context.fillRect(element.x, element.y, element.width, 2);
        } else {
          const shot = document.shots.find((item) => item.id === element.shotId)!;
          const image = await decodeImage(shot.imageDataUrl!, environment, signal);
          try {
            context.fillStyle = "#f2f4f0";
            context.fillRect(element.x, element.y, element.width, element.height);
            const scale = Math.min(element.width / image.width, element.height / image.height);
            const width = image.width * scale;
            const height = image.height * scale;
            context.drawImage(
              image.source,
              element.x + (element.width - width) / 2,
              element.y + (element.height - height) / 2,
              width,
              height,
            );
          } finally {
            image.close();
          }
        }
      }
      const blob = await encode(canvas, signal);
      checkCancellation(signal);
      outputBytes += blob.size;
      if (outputBytes > SHOT_SHEET_LIMITS.outputBytes)
        throw new ShotSheetError("limits", "Generated pages exceed 64 MiB. Select fewer shots.");
      pages.push(
        Object.freeze({
          name: `${fileStem(document.title)}-shot-sheet-${String(page.number).padStart(2, "0")}.png`,
          mimeType: "image/png",
          blob,
          width: canvas.width,
          height: canvas.height,
          text: page.elements
            .filter((element) => element.kind === "text")
            .map((element) => element.text)
            .join("\n"),
        }),
      );
      onProgress?.({ phase: "pages", completed: page.number, total: layouts.length });
      // Let progress paint and cancellation run between bounded pages.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    checkCancellation(signal);
    return pages;
  } catch (error) {
    checkCancellation(signal);
    if (error instanceof ShotSheetError) throw error;
    throw new ShotSheetError(
      "render",
      error instanceof Error ? error.message : "Shot sheet generation failed.",
    );
  } finally {
    // Release the only drawing buffer; returned Blobs own the exact preview/share bytes.
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}
