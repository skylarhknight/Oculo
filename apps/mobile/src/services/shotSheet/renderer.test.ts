import { shotFrom } from "../../test/projectFixtures";
import { migrateScene } from "@oculo/scene-schema";
/// <reference types="node" />
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA, type SceneWorkspace } from "../../types/project";
import { createShotSheet, SHOT_SHEET_LIMITS, ShotSheetError, type SheetDocument } from "./model";
import { layoutShotSheet } from "./layout";
import {
  generateShotSheet,
  inspectSheetImage,
  SHEET_FONT_FAMILY,
  type ShotSheetEnvironment,
  type ShotSheetProgress,
} from "./renderer";

function frameImage(aspect: number, label: string): string {
  const width = aspect >= 1 ? 480 : Math.round(480 * aspect);
  const height = aspect >= 1 ? Math.round(480 / aspect) : 480;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#d1e1d8";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#8aaf9b";
  context.lineWidth = 2;
  for (let x = 40; x < width; x += 40) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 40; y < height; y += 40) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, 20, 20);
  context.fillStyle = "#00ff00";
  context.fillRect(width - 20, 0, 20, 20);
  context.fillStyle = "#0000ff";
  context.fillRect(0, height - 20, 20, 20);
  context.fillStyle = "#ff00ff";
  context.fillRect(width - 20, height - 20, 20, 20);
  context.fillStyle = "#163026";
  context.font = "bold 27px Arial";
  context.fillText(label, 30, height / 2);
  return canvas.toDataURL("image/png");
}

function projectFixture(longNotes = false): SceneWorkspace {
  return {
    sceneId: "station",
    assetVersionId: "legacy-scene:station",
    projectSceneId: "scene-1",
    projectSceneName: "Scene",
    id: "sheet-qa",
    name: "The Quiet Station",
    updatedAt: 1,
    scene: migrateScene({
      id: "station",
      name: "Old station / Café 東京 / مقهى المحطة",
      source: "bundled",
      splatUrl: "https://example.com/station.spz",
    }),
    camera: structuredClone(DEFAULT_CAMERA),
    shots: [16 / 9, 4 / 3, 1, 9 / 16].map((aspect, index) =>
      shotFrom({
        assetVersionId: "legacy-scene:station",
        id: `shot-${index + 1}`,
        sceneId: "station",
        name: ["Arrival — establish the platform", "Find the doorway", "The pause", "Look up"][
          index
        ]!,
        notes:
          index === 1 && longNotes
            ? "Hold the doorway at frame left. Café 東京 👩🏽‍💻 — repeat the move slowly; keep all four corner markers visible. ".repeat(
                70,
              ) +
              "\nحافظ على الباب في يسار الإطار، ثم تحرك ببطء.\nFinal note: this sentence must remain visible."
            : "Keep all four colored corners visible. Natural light; reference framing only.",
        camera: {
          ...structuredClone(DEFAULT_CAMERA),
          focalLengthMm: [24, 35, 50, 70][index]!,
          output: { aspectRatio: aspect, crop: "center-inside-sensor" as const },
        },
        createdAt: new Date(0).toISOString(),
        thumbnailDataUrl: frameImage(aspect, ["16:9", "4:3", "1:1", "9:16"][index]!),
      }),
    ),
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  };
}

function nativeEnvironment() {
  const canvases: Canvas[] = [];
  const paintedPages: string[][] = [];
  let activeImages = 0;
  let maxActiveImages = 0;
  const environment: ShotSheetEnvironment = {
    createCanvas() {
      const canvas = createCanvas(1, 1);
      canvases.push(canvas);
      const context = canvas.getContext("2d");
      const fillText = context.fillText.bind(context);
      const paintedText: string[] = [];
      context.fillText = (...args) => {
        paintedText.push(args[0]);
        fillText(...args);
      };
      // Native Canvas implements the renderer-used HTMLCanvasElement subset.
      const htmlCanvas = canvas as unknown as HTMLCanvasElement;
      const toBlob = htmlCanvas.toBlob.bind(htmlCanvas);
      htmlCanvas.toBlob = (callback, type, quality) => {
        paintedPages.push([...paintedText]);
        paintedText.length = 0;
        toBlob(callback, type, quality);
      };
      return htmlCanvas;
    },
    async loadImage(dataUrl) {
      const image = await loadImage(dataUrl);
      activeImages += 1;
      maxActiveImages = Math.max(maxActiveImages, activeImages);
      let closed = false;
      return {
        source: image as unknown as CanvasImageSource,
        width: image.width,
        height: image.height,
        close() {
          if (!closed) {
            activeImages -= 1;
            closed = true;
          }
        },
      };
    },
    async waitForFonts() {},
  };
  return {
    environment,
    canvases,
    paintedPages,
    active: () => activeImages,
    maximum: () => maxActiveImages,
  };
}

function nativeLayout(document: SheetDocument) {
  const context = createCanvas(1, 1).getContext("2d");
  return layoutShotSheet(document, (text, size, bold) => {
    context.font = `${bold ? "600" : "400"} ${size}px ${SHEET_FONT_FAMILY}`;
    return context.measureText(text).width;
  });
}

describe("bounded PNG shot sheet rendering", () => {
  it("renders real PNG pages with uncropped mixed-aspect frames and exact preview bytes", async () => {
    const native = nativeEnvironment();
    const document = createShotSheet(projectFixture(), {
      generatedAt: new Date("2026-09-10T12:00:00Z"),
    });
    const progress: ShotSheetProgress[] = [];
    const pages = await generateShotSheet(document, {
      environment: native.environment,
      onProgress: (value) => progress.push(value),
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(native.canvases).toHaveLength(1);
    expect(native.canvases[0]!.width).toBe(1);
    expect(native.maximum()).toBe(1);
    expect(native.active()).toBe(0);
    expect(progress.at(-1)).toEqual({
      phase: "pages",
      completed: pages.length,
      total: pages.length,
    });
    const layout = nativeLayout(document);
    for (const [index, page] of pages.entries()) {
      expect(Object.isFrozen(page)).toBe(true);
      expect(page.text).toBe(native.paintedPages[index]!.join("\n"));
      expect(page.text).toBe(
        layout[index]!.elements.filter((element) => element.kind === "text")
          .map((element) => element.text)
          .join("\n"),
      );
      const bytes = Buffer.from(await page.blob.arrayBuffer());
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(page.name).toBe(
        `The-Quiet-Station-shot-sheet-${String(index + 1).padStart(2, "0")}.png`,
      );
      const decoded = await loadImage(bytes);
      expect([decoded.width, decoded.height]).toEqual([
        SHOT_SHEET_LIMITS.width,
        SHOT_SHEET_LIMITS.height,
      ]);
      const canvas = createCanvas(decoded.width, decoded.height);
      const context = canvas.getContext("2d");
      context.drawImage(decoded, 0, 0);
      for (const element of layout[index]!.elements) {
        if (element.kind !== "image") continue;
        const shot = document.shots.find((shot) => shot.id === element.shotId)!;
        const dimensions = inspectSheetImage(shot.imageDataUrl!);
        const scale = Math.min(
          element.width / dimensions.width,
          element.height / dimensions.height,
        );
        const width = dimensions.width * scale;
        const height = dimensions.height * scale;
        const x = element.x + (element.width - width) / 2;
        const y = element.y + (element.height - height) / 2;
        const pixel = (px: number, py: number) =>
          [...context.getImageData(Math.round(px), Math.round(py), 1, 1).data].slice(0, 3);
        expect(pixel(x + 5, y + 5)).toEqual([255, 0, 0]);
        expect(pixel(x + width - 5, y + 5)).toEqual([0, 255, 0]);
        expect(pixel(x + 5, y + height - 5)).toEqual([0, 0, 255]);
        expect(pixel(x + width - 5, y + height - 5)).toEqual([255, 0, 255]);
      }
    }
  });

  it("describes selected shots in order with complete Unicode notes and page credits", async () => {
    const native = nativeEnvironment();
    const project = projectFixture(true);
    project.shots = [project.shots[3]!, project.shots[1]!, project.shots[0]!];
    project.shotSheet = { version: 1, excludedShotIds: ["shot-1"] };
    project.scene.attribution = {
      text: "Station scan by Café 東京",
      url: "https://example.com/station",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    };
    const document = createShotSheet(project, {
      generatedAt: new Date("2026-09-10T12:00:00Z"),
    });
    const pages = await generateShotSheet(document, { environment: native.environment });
    const layouts = nativeLayout(document);
    expect(pages.length).toBeGreaterThan(2);
    expect(native.maximum()).toBe(1);
    expect(native.active()).toBe(0);
    const allText = pages.map((page) => page.text).join("\n");
    expect(allText).toContain(`SHOT 01\n${document.shots[0]!.name}`);
    expect(allText).toContain(`SHOT 02\n${document.shots[1]!.name}`);
    expect(allText.indexOf(document.shots[0]!.name)).toBeLessThan(
      allText.indexOf(document.shots[1]!.name),
    );
    expect(allText).not.toContain(project.shots[2]!.name);
    expect(allText).not.toContain("SHOT 03");
    expect(allText).toContain("SHOT 02 / CONTINUED");
    for (const shot of document.shots) expect(allText).toContain(shot.metadata);
    const fullNotes: string[] = [];
    for (const [index, page] of pages.entries()) {
      expect(page.text).toBe(native.paintedPages[index]!.join("\n"));
      const textLines = page.text!.split("\n");
      expect(textLines.slice(0, 2)).toEqual(["OCULO / SHOT SHEET", document.title]);
      expect(page.text).toContain(`Location: ${document.location}`);
      expect(page.text).toContain("Generated 2026-09-10 (UTC) · 2 shots");
      expect(page.text!.replace(/\n/g, "")).toContain(document.attribution);
      expect(textLines.at(-1)).toBe(
        `Digital reference images · Oculo                                      Page ${index + 1} / ${pages.length}`,
      );
      const textElements = layouts[index]!.elements.filter((element) => element.kind === "text");
      expect(textLines).toEqual(textElements.map((element) => element.text));
      for (const [lineIndex, element] of textElements.entries()) {
        if (element.role === "notes" && element.shotId === "shot-2")
          fullNotes.push(textLines[lineIndex]!);
      }
    }
    expect(fullNotes.join("")).toBe(document.shots[1]!.notes.replace(/\n/g, ""));
    if (process.env.OCULO_SHOT_SHEET_ARTIFACTS) {
      const directory = "/tmp/oculo-shot-sheet-qa";
      await mkdir(directory, { recursive: true });
      for (const page of pages)
        await writeFile(`${directory}/${page.name}`, new Uint8Array(await page.blob.arrayBuffer()));
      await writeFile(`${directory}/expected-notes.txt`, document.shots[1]!.notes);
    }
  });

  it("reports all missing and corrupt included images before creating a page", async () => {
    const project = projectFixture();
    delete project.shots[0]!.thumbnailDataUrl;
    project.shots[1]!.thumbnailDataUrl = "data:image/png;base64,not-an-image";
    const native = nativeEnvironment();
    try {
      await generateShotSheet(createShotSheet(project), { environment: native.environment });
      expect.fail("Generation should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ShotSheetError);
      expect((error as ShotSheetError).code).toBe("invalid-images");
      expect((error as ShotSheetError).shotIds).toEqual(["shot-1", "shot-2"]);
    }
    expect(native.canvases).toHaveLength(0);
    expect(native.active()).toBe(0);
  });

  it("rejects dangerous compressed-image dimensions before allocating an image", () => {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32BE(0x89504e47, 0);
    bytes.writeUInt32BE(0x0d0a1a0a, 4);
    bytes.writeUInt32BE(0x49484452, 12);
    bytes.writeUInt32BE(40_000, 16);
    bytes.writeUInt32BE(40_000, 20);
    expect(() => inspectSheetImage(`data:image/png;base64,${bytes.toString("base64")}`)).toThrow(
      "4-megapixel",
    );
  });

  it("supports cancellation before work and between pages without returning a partial result", async () => {
    const controller = new AbortController();
    controller.abort();
    const native = nativeEnvironment();
    await expect(
      generateShotSheet(projectFixture(), {
        environment: native.environment,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
    expect(native.canvases).toHaveLength(0);
    const active = new AbortController();
    await expect(
      generateShotSheet(projectFixture(), {
        environment: native.environment,
        signal: active.signal,
        onProgress(progress) {
          if (progress.phase === "pages") active.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(native.canvases[0]!.width).toBe(1);
    expect(native.active()).toBe(0);
  });

  it("rejects a later encoding failure without returning the completed page and releases the buffer", async () => {
    const native = nativeEnvironment();
    const makeCanvas = native.environment.createCanvas;
    const progress: ShotSheetProgress[] = [];
    let encoded = 0;
    native.environment.createCanvas = () => {
      const canvas = makeCanvas();
      const toBlob = canvas.toBlob.bind(canvas);
      canvas.toBlob = (callback, type, quality) => {
        encoded += 1;
        if (encoded === 2) callback(null);
        else toBlob(callback, type, quality);
      };
      return canvas;
    };
    await expect(
      generateShotSheet(projectFixture(), {
        environment: native.environment,
        onProgress: (value) => progress.push(value),
      }),
    ).rejects.toMatchObject({ code: "render" });
    expect(encoded).toBe(2);
    expect(progress.filter((value) => value.phase === "pages")).toEqual([
      { phase: "pages", completed: 1, total: 2 },
    ]);
    expect(native.canvases[0]!.width).toBe(1);
    expect(native.active()).toBe(0);
  });
});
