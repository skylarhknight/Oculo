import { migrateScene } from "@oculo/scene-schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA, type SceneWorkspace } from "../../types/project";
import { shotFrom } from "../../test/projectFixtures";
import { createShotSheet, SHOT_SHEET_LIMITS, ShotSheetError } from "./model";
import { layoutShotSheet, sheetTextDirection, wrapSheetText } from "./layout";

export function sheetProject(): SceneWorkspace {
  return {
    sceneId: "scene",
    assetVersionId: "legacy-scene:scene",
    projectSceneId: "scene-1",
    projectSceneName: "Scene",
    id: "project",
    name: "Test film",
    updatedAt: 1,
    scene: migrateScene({
      id: "scene",
      name: "The café",
      source: "bundled",
      splatUrl: "https://example.com/scene.spz",
    }),
    camera: structuredClone(DEFAULT_CAMERA),
    shots: [1, 2, 3].map((number) =>
      shotFrom({
        assetVersionId: "legacy-scene:scene",
        id: `shot-${number}`,
        sceneId: "scene",
        name: `Saved ${number}`,
        notes: "",
        camera: { ...structuredClone(DEFAULT_CAMERA), focalLengthMm: number * 24 },
        createdAt: new Date(0).toISOString(),
        thumbnailDataUrl: "data:image/png;base64,placeholder",
      }),
    ),
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  };
}

const measure = (text: string, size: number) => [...text].length * size * 0.55;

describe("immutable shot sheet model", () => {
  it("includes provenance and scale while excluding private source locators", () => {
    const project = sheetProject();
    project.scene.provenance = {
      kind: "generated",
      sourceApp: "World Labs",
      sourceName: "/private/location.spz",
      importedAt: null,
      attribution: "Team scene",
    };
    project.scene.attribution = {
      text: "Team scene",
      url: "https://example.com/world?token=secret",
    };
    const sheet = createShotSheet(project);
    expect(sheet.attribution).toContain("generated (not a verified real location)");
    expect(sheet.attribution).toContain("Physical scale unknown");
    expect(sheet.attribution).toContain("World Labs");
    expect(sheet.attribution).toContain("Team scene");
    expect(sheet.attribution).not.toContain("/private/");
    expect(sheet.attribution).not.toContain("secret");
  });

  it("retains source credit and license on every generated page", () => {
    const project = sheetProject();
    project.scene.attribution = {
      text: "Small Garden by scbenoit",
      url: "https://superspl.at/scene/108dd868",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    };
    project.shots[0]!.notes = "A long blocking note. ".repeat(500);
    const sheet = createShotSheet(project);
    const pages = layoutShotSheet(sheet, measure);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      const header = page.elements
        .filter((item) => item.kind === "text" && item.role === "header")
        .map((item) => (item.kind === "text" ? item.text : ""))
        .join("");
      expect(header).toContain("Small Garden by scbenoit");
      expect(header).toContain("CC BY 4.0");
      expect(header).toContain("https://superspl.at/scene/108dd868");
      expect(header).toContain("https://creativecommons.org/licenses/by/4.0/");
    }
  });
  it("fits multiline contributor credits without losing attribution or blocking a short project header", () => {
    const project = sheetProject();
    project.name = "Film";
    project.scene.name = "Garden";
    const credit = Array.from({ length: 60 }, (_, index) => `Contributor ${index}`).join("\n");
    project.scene.attribution = { text: credit, license: "CC BY 4.0" };
    expect(credit.length).toBeLessThanOrEqual(1000);
    const document = createShotSheet(project);
    const pages = layoutShotSheet(document, measure);
    expect(pages.length).toBeGreaterThan(0);
    expect(
      pages.flatMap((page) => page.elements).filter((item) => item.kind === "image"),
    ).toHaveLength(project.shots.length);
    for (const page of pages) {
      const header = page.elements
        .filter((item) => item.kind === "text" && item.role === "header")
        .map((item) => (item.kind === "text" ? item.text : ""))
        .join("");
      expect(header).toContain(credit.replace(/\n/g, " "));
      expect(header).toContain("CC BY 4.0");
    }
    expect(project.scene.attribution.text).toBe(credit);
  });

  it("uses saved shots in their order, applies exclusions, and numbers the selected sequence", () => {
    const project = sheetProject();
    project.shots.reverse();
    Object.assign(project, { shotSheet: { version: 1, excludedShotIds: ["shot-2"] } });
    project.camera.focalLengthMm = 120;
    const sheet = createShotSheet(project, { generatedAt: new Date("2026-09-10T12:00:00Z") });
    expect(sheet.shots.map(({ id, number }) => [id, number])).toEqual([
      ["shot-3", 1],
      ["shot-1", 2],
    ]);
    expect(sheet.shots[0]!.camera.focalLengthMm).toBe(72);
    expect(sheet.generatedAt).toBe("2026-09-10T12:00:00.000Z");
    expect(sheet.shots[0]!.metadata).toContain("Sensor 36 × 24 mm · 16:9");
    expect(sheet.shots[0]!.metadata).toContain("Static, 3 s");
  });

  it("isolates every saved camera and text from later project mutations", () => {
    const project = sheetProject();
    const sheet = createShotSheet(project);
    project.name = "Later title";
    project.shots[0]!.name = "Changed";
    project.shots[0]!.keyframes[0]!.pose.position[0] = 99;
    project.shots[0]!.thumbnailDataUrl = "different";
    expect(sheet.title).toBe("Test film");
    expect(sheet.shots[0]!.name).toBe("Saved 1");
    expect(sheet.shots[0]!.camera.pose.position[0]).toBe(0);
    expect(sheet.shots[0]!.imageDataUrl).toContain("placeholder");
    expect(Object.isFrozen(sheet.shots[0]!.camera.pose.position)).toBe(true);
  });

  it("reports missing images in the snapshot without silently omitting a shot", () => {
    const project = sheetProject();
    delete project.shots[1]!.thumbnailDataUrl;
    const sheet = createShotSheet(project);
    expect(sheet.shots).toHaveLength(3);
    expect(sheet.imageIssues).toEqual([
      { shotId: "shot-2", reason: expect.stringContaining("missing") },
    ]);
  });

  it("rejects empty, invalid selections, and invalid cameras explicitly", () => {
    const project = sheetProject();
    expect(() => createShotSheet({ ...project, shots: [] })).toThrow(ShotSheetError);
    Object.assign(project, { shotSheet: { version: 1, excludedShotIds: ["no-such-shot"] } });
    expect(() => createShotSheet(project)).toThrow("selection");
    Object.assign(project, { shotSheet: undefined });
    project.shots[0]!.setup.output.aspectRatio = 0;
    expect(() => createShotSheet(project)).toThrow("invalid camera");
  });

  it("describes a moving shot's lens, timing and pulls on its own line", () => {
    const project = sheetProject();
    const shot = project.shots[0]!;
    shot.setup.lens = { kind: "zoom", minFocalLengthMm: 24, maxFocalLengthMm: 85 };
    shot.durationSeconds = 6;
    shot.keyframes.push({
      ...structuredClone(shot.keyframes[0]!),
      id: "end",
      timeSeconds: 6,
      focalLengthMm: 85,
      focusDistanceM: 1.5,
      apertureFStop: 5.6,
    });
    const [moving, still] = createShotSheet(project).shots;
    expect(moving!.metadata).toBe(
      "24–85mm zoom · 24 mm → 85 mm · Sensor 36 × 24 mm · 16:9 · Moving, 2 keyframes, 6 s · Focus 3 m → 1.5 m · f/2.8 → f/5.6",
    );
    expect(still!.metadata).toBe(
      "48mm prime · Sensor 36 × 24 mm · 16:9 · Static, 3 s · Focus 3 m · f/2.8",
    );
  });
});

describe("shot sheet pagination", () => {
  it("uses the first strong letter for paragraph direction and keeps RTL notes aligned together", () => {
    expect(sheetTextDirection("123 — حافظ على الباب")).toBe("rtl");
    expect(sheetTextDirection("Café 東京")).toBe("ltr");
    const project = sheetProject();
    project.shots[0]!.notes = "حافظ على الباب في يسار الإطار، ثم تحرك ببطء. ".repeat(30);
    const text = layoutShotSheet(createShotSheet(project), measure)
      .flatMap((page) => page.elements)
      .filter((element) => element.kind === "text" && element.role === "notes");
    expect(text.length).toBeGreaterThan(1);
    expect(
      text.every(
        (element) =>
          element.kind === "text" &&
          element.direction === "rtl" &&
          element.x === SHOT_SHEET_LIMITS.width - 80,
      ),
    ).toBe(true);
  });
  it("preserves Unicode, grapheme clusters and all wrapped note characters", () => {
    const note = "Café 東京 👩🏽‍💻 — көзқарас ".repeat(200);
    const lines = wrapSheetText(note, 200, (value) => [...value].length * 10);
    expect(lines.join("")).toBe(note);
    expect(lines.filter((line) => line.includes("👩")).every((line) => line.includes("👩🏽‍💻"))).toBe(
      true,
    );
    expect(wrapSheetText("First\n\nLast", 100, (value) => value.length)).toEqual([
      "First",
      "",
      "Last",
    ]);
  });

  it("continues long notes across pages with stable shot numbering and full text", () => {
    const project = sheetProject();
    const notes = "Keep the doorway at frame left. 東京 café 👩🏽‍💻 ".repeat(180);
    project.shots[0]!.notes = notes;
    const pages = layoutShotSheet(createShotSheet(project), measure);
    expect(pages.length).toBeGreaterThan(2);
    const noteElements = pages
      .flatMap(({ elements }) => elements)
      .filter((element) => element.kind === "text" && element.role === "notes");
    expect(
      noteElements.map((element) => (element.kind === "text" ? element.text : "")).join(""),
    ).toBe(notes);
    expect(
      pages
        .flatMap(({ elements }) => elements)
        .filter((element) => element.kind === "image")
        .map((element) => element.shotId),
    ).toEqual(["shot-1", "shot-2", "shot-3"]);
    for (const page of pages) {
      for (const element of page.elements) {
        expect(element.y).toBeGreaterThanOrEqual(0);
        expect(
          element.y +
            (element.kind === "image"
              ? element.height
              : element.kind === "text"
                ? element.size
                : 2),
        ).toBeLessThan(SHOT_SHEET_LIMITS.height);
      }
    }
    expect(
      pages[pages.length - 1]!.elements.some(
        (element) =>
          element.kind === "text" &&
          element.text.endsWith(`Page ${pages.length} / ${pages.length}`),
      ),
    ).toBe(true);
  });

  it("fails clearly when the page budget cannot fit the full content", () => {
    const project = sheetProject();
    project.shots[0]!.notes = "Long text ".repeat(8000);
    expect(() =>
      layoutShotSheet(createShotSheet(project), (text, size) => text.length * size * 2),
    ).toThrow("40 pages");
  });
});
