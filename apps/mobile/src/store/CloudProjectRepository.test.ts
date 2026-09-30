import { migrated, editFirstScene, movingShot, shotFrom } from "../test/projectFixtures";
import { migrateScene } from "@oculo/scene-schema";
import { describe, expect, it } from "vitest";
import { sanitizeProjectForCloud } from "./CloudProjectRepository";
import { DEFAULT_CAMERA, type Project } from "../types/project";
import { DEMO_SCENES } from "../config/demoScenes";
import type { CameraSpeedCurve } from "@oculo/scene-schema";

const speedCurve: CameraSpeedCurve = {
  version: 1,
  points: [
    { time: 0, speed: 0, intensity: 1 },
    { time: 0.3, speed: 3, intensity: 0.5 },
    { time: 1, speed: 1, intensity: 0 },
  ],
};

function makeProject(): Project {
  return migrated({
    sceneId: "garden",
    assetVersionId: "legacy-scene:garden",
    schemaVersion: 2,
    id: "p1",
    name: "Project",
    scene: migrateScene({
      id: "garden",
      name: "Garden",
      splatUrl: "https://example.com/scene.spz",
      source: "bundled",
    }),
    updatedAt: 1,
    durationSeconds: 8,
    camera: DEFAULT_CAMERA,
    shots: [],
    path: {
      sceneId: "garden",
      assetVersionId: "legacy-scene:garden",
      id: "path",
      name: "Main path",
      keyframes: [],
    },
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  });
}

describe("sanitizeProjectForCloud", () => {
  it("preserves versioned speed curves and waypoint arrival times in cloud metadata", () => {
    const project = makeProject();
    project.scenes[0]!.shots = [
      movingShot(project.scenes[0]!, [
        { timeSeconds: 0, camera: DEFAULT_CAMERA, speedCurve: structuredClone(speedCurve) },
        { timeSeconds: 8, camera: DEFAULT_CAMERA },
      ]),
    ];
    const original = structuredClone(project);
    const sanitized = sanitizeProjectForCloud(project);
    const { legacyMetadata: _legacy, ...scene } = original.scenes[0]!.scene;
    void _legacy;
    expect(sanitized).toEqual({ ...original, scenes: [{ ...original.scenes[0]!, scene }] });
    expect(sanitized.schemaVersion).toBe(4);
    sanitized.scenes[0]!.shots[0]!.keyframes[0]!.speedCurve!.points[1]!.speed = 4;
    expect(project).toEqual(original);
  });

  it.each([
    { ...speedCurve, version: 2 },
    { ...speedCurve, points: speedCurve.points.map((point) => ({ ...point, speed: 0 })) },
  ])("rejects unsupported or invalid speed curves instead of dropping them", (invalidCurve) => {
    const project = makeProject();
    const invalid = {
      ...project,
      scenes: [
        {
          ...project.scenes[0]!,
          shots: [
            {
              ...movingShot(project.scenes[0]!, [
                { timeSeconds: 0, camera: DEFAULT_CAMERA },
                { timeSeconds: 8, camera: DEFAULT_CAMERA },
              ]),
              keyframes: movingShot(project.scenes[0]!, [
                { timeSeconds: 0, camera: DEFAULT_CAMERA },
                { timeSeconds: 8, camera: DEFAULT_CAMERA },
              ]).keyframes.map((frame, index) =>
                index === 0 ? { ...frame, speedCurve: invalidCurve } : frame,
              ),
            },
          ],
        },
      ],
    } as unknown as Project;
    expect(() => sanitizeProjectForCloud(invalid)).toThrow();
  });

  it("backs up known shared bundle references without allowing arbitrary device files", () => {
    const project = makeProject();
    project.scenes[0]!.scene = structuredClone(
      DEMO_SCENES.find((scene) => scene.availableOffline)!.descriptor,
    );
    project.scenes[0]!.sceneId = project.scenes[0]!.scene.id;
    project.scenes[0]!.assetVersionId = project.scenes[0]!.scene.asset.versionId;
    expect(sanitizeProjectForCloud(project).scenes[0]!.scene.asset).toEqual(
      project.scenes[0]!.scene.asset,
    );
    project.scenes[0]!.scene.asset.locator = {
      kind: "local",
      relativePath: "private/customer-data.bin",
    };
    expect(() => sanitizeProjectForCloud(project)).toThrow("device-local");
    project.scenes[0]!.scene.asset.locator = structuredClone(
      DEMO_SCENES[0]!.descriptor.asset.locator,
    );
    project.scenes[0]!.scene.id = "unrecognized-scene";
    project.scenes[0]!.sceneId = project.scenes[0]!.scene.id;
    expect(() => sanitizeProjectForCloud(project)).toThrow("device-local");
  });
  it("keeps thumbnails when the document is small enough", () => {
    const project = makeProject();
    project.scenes[0]!.shots = [
      shotFrom({
        assetVersionId: "legacy-scene:garden",
        id: "s1",
        sceneId: "garden",
        name: "Shot 01",
        createdAt: new Date(0).toISOString(),
        camera: DEFAULT_CAMERA,
        thumbnailDataUrl: "data:image/jpeg;base64,small",
      }),
    ];
    const sanitized = sanitizeProjectForCloud(project);
    expect(sanitized.scenes[0]!.shots[0]?.thumbnailDataUrl).toBe("data:image/jpeg;base64,small");
  });

  it("strips shot thumbnails when the document would exceed the size limit", () => {
    const project = makeProject();
    project.scenes[0]!.shots = [
      shotFrom({
        assetVersionId: "legacy-scene:garden",
        id: "s1",
        sceneId: "garden",
        name: "Shot 01",
        createdAt: new Date(0).toISOString(),
        camera: DEFAULT_CAMERA,
        thumbnailDataUrl: `data:image/jpeg;base64,${"x".repeat(1_000_000)}`,
      }),
    ];
    const sanitized = sanitizeProjectForCloud(project);
    expect(sanitized.scenes[0]!.shots[0]?.thumbnailDataUrl).toBeUndefined();
    expect(sanitized.scenes[0]!.shots[0]?.name).toBe("Shot 01");
    // The original project is untouched.
    expect(project.scenes[0]!.shots[0]?.thumbnailDataUrl).toBeDefined();
  });

  it("measures UTF-8 bytes rather than JavaScript string length", () => {
    const project = makeProject();
    project.name = "界".repeat(250_000);
    project.scenes[0]!.shots = [
      shotFrom({
        assetVersionId: "legacy-scene:garden",
        id: "s",
        sceneId: "garden",
        name: "Shot",
        camera: DEFAULT_CAMERA,
        createdAt: new Date(0).toISOString(),
        thumbnailDataUrl: `data:image/jpeg;base64,${"x".repeat(200_000)}`,
      }),
    ];
    expect(JSON.stringify(project).length).toBeLessThan(900_000);
    expect(sanitizeProjectForCloud(project).scenes[0]!.shots[0]?.thumbnailDataUrl).toBeUndefined();
  });

  it("keeps oversized metadata local instead of sending another over-limit document", () => {
    const project = makeProject();
    project.name = "界".repeat(310_000);
    expect(() => sanitizeProjectForCloud(project)).toThrow("metadata is too large");
  });

  it("does not expose local asset paths or internal media metadata", () => {
    const project = makeProject();
    expect(() =>
      sanitizeProjectForCloud(
        editFirstScene(project, (w) => ({
          ...w,
          scene: {
            ...w.scene,
            asset: {
              ...w.scene.asset,
              locator: { kind: "local", relativePath: "private/user/scene.spz" },
            },
          },
        })),
      ),
    ).toThrow("device-local");
    expect(() =>
      sanitizeProjectForCloud({
        ...project,
        ownerUid: "private-owner",
        localMediaPath: "/private/frames",
      } as Project),
    ).toThrow();
    project.scenes[0]!.shots = [
      shotFrom({
        assetVersionId: "legacy-scene:garden",
        id: "s",
        sceneId: "garden",
        name: "Shot",
        camera: DEFAULT_CAMERA,
        createdAt: new Date(0).toISOString(),
        thumbnailDataUrl: "blob:device-frame",
      }),
    ];
    expect(sanitizeProjectForCloud(project).scenes[0]!.shots[0]?.thumbnailDataUrl).toBeUndefined();
  });
});
