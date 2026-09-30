import { describe, expect, it } from "vitest";
import {
  AssetSchema,
  assertSameSceneBinding,
  createAssetVersion,
  fingerprintBytes,
  parseProject,
  stringifyProject,
  stringifyShotPlan,
  parseShotPlan,
  verifyAssetBytes,
  ProjectSchema,
  SceneDescriptorSchema,
  ShotSchema,
  SceneWorkspaceSchema,
  applySceneWorkspace,
  sceneWorkspace,
  type Project,
} from "./index";

const workspaceOf = (project: Project) => sceneWorkspace(project, project.scenes[0]!.id);
const parseWorkspace = (value: unknown) => workspaceOf(parseProject(value));

const legacyCamera = {
  pose: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] },
  focalLengthMm: 50,
  sensorWidthMm: 36,
  sensorHeightMm: 24,
  near: 0.01,
  far: 200,
};
function legacyProject() {
  return {
    schemaVersion: 1,
    id: "legacy",
    name: "Doorway",
    updatedAt: 5,
    durationSeconds: 8,
    scene: {
      id: "room",
      name: "Room",
      splatUrl: "https://example.com/room.spz?token=private",
      splatQuaternion: [1, 0, 0, 0],
      source: "bundled",
      metricScaleFactor: 12,
      groundPlaneOffset: 4,
      colliderUrl: "https://example.com/private-collider",
    },
    camera: legacyCamera,
    shots: [
      {
        id: "shot",
        sceneId: "room",
        name: "Door",
        camera: legacyCamera,
        notes: "Hold here",
        createdAt: "2026-08-12T08:00:00.000Z",
        thumbnailDataUrl: "data:image/jpeg;base64,abc",
      },
    ],
    path: {
      id: "move",
      name: "Push",
      keyframes: [
        { timeSeconds: 0, camera: legacyCamera },
        { timeSeconds: 8, camera: legacyCamera },
      ],
    },
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  };
}

describe("durable scene contracts", () => {
  it("migrates a v1 project without mutating it or inventing evidence", () => {
    const raw = legacyProject();
    const original = structuredClone(raw);
    const project = parseProject(raw);
    const p = workspaceOf(project);
    expect(raw).toEqual(original);
    expect(project.schemaVersion).toBe(4);
    expect(project.scenes).toHaveLength(1);
    expect(p.scene.asset.fingerprint).toEqual({ status: "unknown" });
    expect(p.scene.asset.byteSize).toBeNull();
    expect(p.scene.metricScale).toEqual({ status: "unknown" });
    expect(p.scene.legacyMetadata?.metricScaleFactor).toBe(12);
    expect(p.scene.provenance.kind).toBe("unknown");
    expect(p.scene.assetToScene.rotation).toEqual([1, 0, 0, 0]);
    expect(p.scene.source).toBe("remote");
    expect(p.camera.output.aspectRatio).toBe(1.5);
    expect(p.shots[0]?.thumbnailDataUrl).toBe(original.shots[0]?.thumbnailDataUrl);
    expect(p.shots.map((s) => s.name)).toEqual(["Door", "Camera move"]);
    for (const ref of [p, ...p.shots]) {
      expect(ref.sceneId).toBe("room");
      expect(ref.assetVersionId).toBe(p.scene.asset.versionId);
    }
    expect(parseProject(stringifyProject(project))).toEqual(project);
  });

  it("rejects inconsistent scene references and future data without modifying it", () => {
    const project = parseProject(legacyProject());
    const p = workspaceOf(project);
    const foreign = p.shots.map((s) => ({ ...s, assetVersionId: "other" }));
    expect(() => SceneWorkspaceSchema.parse({ ...p, shots: foreign })).toThrow();
    expect(() =>
      ProjectSchema.parse({
        ...project,
        scenes: [{ ...project.scenes[0]!, shots: foreign }],
      }),
    ).toThrow();
    expect(() => parseProject({ ...project, schemaVersion: 5 })).toThrow("Unsupported");
    const raw = legacyProject();
    raw.shots[0]!.sceneId = "another-room";
    expect(() => parseProject(raw)).toThrow("another scene");
  });

  it("hashes the original bytes, gives revisions new identities, and detects changed bytes", async () => {
    const bytes = new TextEncoder().encode("abc");
    const original = bytes.slice();
    const metadata = {
      format: { name: "spz" as const, version: "2" },
      locator: { kind: "local" as const, relativePath: "scenes/one.spz" },
    };
    const asset = await createAssetVersion(bytes, metadata);
    expect(bytes).toEqual(original);
    expect(await fingerprintBytes(bytes)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(asset.byteSize).toBe(3);
    await expect(verifyAssetBytes(asset, bytes)).resolves.toBeUndefined();
    await expect(verifyAssetBytes(asset, new TextEncoder().encode("abd"))).rejects.toThrow(
      "fingerprint",
    );
    await expect(verifyAssetBytes(asset, new Uint8Array(4))).rejects.toThrow("size");
    const changed = await createAssetVersion(new TextEncoder().encode("abd"), metadata);
    expect(changed.versionId).not.toBe(asset.versionId);
    expect(changed.fingerprint).not.toEqual(asset.fingerprint);
  });

  it("permits verified relinks but rejects coordinate/scale/content rebinding", async () => {
    const scene = parseWorkspace(legacyProject()).scene;
    scene.asset = await createAssetVersion(new Uint8Array([1]), {
      format: { name: "spz", version: null },
      locator: { kind: "local", relativePath: "scenes/a.spz" },
    });
    const moved = structuredClone(scene);
    moved.asset.locator = { kind: "local", relativePath: "scenes/b.spz" };
    expect(() => assertSameSceneBinding(scene, moved)).not.toThrow();
    for (const change of [
      (s: typeof scene) => {
        s.assetToScene.translation[0] = 2;
      },
      (s: typeof scene) => {
        s.assetToScene.rotation = [0, 0, 0, 1];
      },
      (s: typeof scene) => {
        s.assetToScene.scale = [2, 2, 2];
      },
      (s: typeof scene) => {
        s.metricScale = {
          status: "known",
          metersPerSceneUnit: 2,
          evidence: { kind: "calibration", description: "Measured baseline" },
        };
      },
      (s: typeof scene) => {
        s.asset.byteSize = 5;
      },
    ]) {
      const other = structuredClone(scene);
      change(other);
      expect(() => assertSameSceneBinding(scene, other)).toThrow("immutable");
    }
  });

  it("rejects traversal, absolute and temporary paths, and unsupported scale claims", () => {
    const asset = parseWorkspace(legacyProject()).scene.asset;
    for (const relativePath of [
      "../a.spz",
      "/private/a.spz",
      "a/../b",
      "a//b",
      "blob:abc",
      "a/%2e%2e/b",
      "C:\\a.spz",
    ]) {
      expect(() =>
        AssetSchema.parse({ ...asset, locator: { kind: "local", relativePath } }),
      ).toThrow();
    }
    const scene = parseWorkspace(legacyProject()).scene;
    expect(() =>
      SceneDescriptorSchema.parse({
        ...scene,
        metricScale: { status: "known", metersPerSceneUnit: 1 },
      }),
    ).toThrow();
    expect(() =>
      SceneDescriptorSchema.parse({ ...scene, coordinates: { ...scene.coordinates, up: "+Z" } }),
    ).toThrow();
  });

  it("exports portable camera data without asset paths, access URLs or harvested source paths", () => {
    const p = parseWorkspace(legacyProject());
    p.scene.provenance = {
      kind: "captured",
      importedAt: "2026-09-08T00:00:00Z",
      sourceApp: "Capture app",
      sourceName: "/Users/private/room.spz",
      attribution: "https://example.com/?token=secret",
    };
    p.camera.output.aspectRatio = 2.39;
    const json = stringifyShotPlan(p);
    const exported = parseShotPlan(json).project;
    expect(json).not.toMatch(/private|secret|colliderUrl|thumbnailDataUrl|locator/);
    expect(exported.camera).toEqual(p.camera);
    expect(exported.shots).toEqual(
      p.shots.map(({ thumbnailDataUrl: _t, ...shot }) => {
        void _t;
        return shot;
      }),
    );
    expect(exported.shots[1]!.keyframes).toHaveLength(2);
    expect(exported.scene.assetToScene).toEqual(p.scene.assetToScene);
    expect(exported.scene.asset.versionId).toBe(p.assetVersionId);
    expect(exported.scene.provenance.sourceApp).toBe("Capture app");
    expect(exported.scene.provenance.sourceName).toBeNull();
    expect(exported.scene.provenance.attribution).toBe("https://example.com/");
    expect(p.scene.provenance.sourceName).toBe("/Users/private/room.spz");
    expect(() => parseShotPlan({ ...JSON.parse(json), schemaVersion: 99 })).toThrow();
  });

  describe("shots and their movement", () => {
    const camera = {
      pose: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] },
      focalLengthMm: 50,
      sensorWidthMm: 36,
      sensorHeightMm: 24,
      output: { aspectRatio: 1.5, crop: "center-inside-sensor" as const },
      near: 0.01,
      far: 200,
    };
    const legacy = () => {
      const s = parseProject(legacyProject()).scenes[0]!;
      const ref = { sceneId: s.sceneId, assetVersionId: s.assetVersionId };
      return {
        scene: s.scene,
        ...ref,
        camera,
        shots: [
          {
            id: "shot",
            ...ref,
            name: "Door",
            camera,
            notes: "Hold here",
            createdAt: "2026-08-12T08:00:00.000Z",
            thumbnailDataUrl: "data:image/jpeg;base64,abc",
          },
        ],
        path: {
          id: "move",
          ...ref,
          name: "Push",
          keyframes: [
            { timeSeconds: 2, camera },
            {
              timeSeconds: 10,
              camera: { ...camera, focalLengthMm: 85 },
              speedCurve: {
                version: 1 as const,
                points: [
                  { time: 0, speed: 1, intensity: 0 },
                  { time: 1, speed: 1, intensity: 0 },
                ],
              },
            },
          ],
        },
      };
    };
    const v2 = () => ({
      schemaVersion: 2,
      id: "legacy",
      name: "Doorway",
      updatedAt: 5,
      durationSeconds: 10,
      settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
      shotSheet: { version: 1, excludedShotIds: ["shot"] },
      ...legacy(),
    });
    const v3 = (path?: ReturnType<typeof legacy>["path"]) => {
      const { scene, sceneId, assetVersionId, shots, path: legacyPath } = legacy();
      return {
        schemaVersion: 3,
        id: "legacy",
        name: "Doorway",
        createdAt: 1,
        updatedAt: 5,
        settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
        scenes: [
          {
            id: "scene-a",
            name: "Room",
            createdAt: 1,
            updatedAt: 5,
            scene,
            sceneId,
            assetVersionId,
            durationSeconds: 10,
            camera,
            shots,
            path: path ?? legacyPath,
          },
        ],
      };
    };

    it("turns stills into static shots and a v3 move into one moving shot", () => {
      const project = parseProject(v3());
      const [still, move] = project.scenes[0]!.shots;
      expect(still).toMatchObject({
        id: "shot",
        name: "Door",
        notes: "Hold here",
        thumbnailDataUrl: "data:image/jpeg;base64,abc",
        durationSeconds: 3,
        setup: { lens: { kind: "prime", focalLengthMm: 50 } },
      });
      expect(still!.keyframes).toEqual([
        {
          id: "shot-k0",
          timeSeconds: 0,
          pose: camera.pose,
          focalLengthMm: 50,
          focusDistanceM: 3,
          apertureFStop: 2.8,
        },
      ]);
      expect(move!.id).toBe("move-move");
      expect(move!.name).toBe("Camera move");
      expect(move!.durationSeconds).toBe(10);
      expect(move!.setup.lens).toEqual({
        kind: "zoom",
        minFocalLengthMm: 50,
        maxFocalLengthMm: 85,
      });
      // A move that began late now starts at 0 and keeps its timing.
      expect(move!.keyframes.map((k) => k.timeSeconds)).toEqual([0, 8]);
      expect(move!.keyframes[1]!.speedCurve).toBeDefined();
      expect(move!.thumbnailDataUrl).toBeUndefined();
      expect(parseProject(v3()).scenes[0]!.shots[1]!.id).toBe(move!.id);
      expect(parseProject(stringifyProject(project))).toEqual(project);
    });

    it("keeps stills only when a v3 move has fewer than two keyframes", () => {
      const path = legacy().path;
      for (const keyframes of [[], path.keyframes.slice(0, 1)]) {
        const project = parseProject(v3({ ...path, keyframes }));
        expect(project.scenes[0]!.shots.map((s) => s.name)).toEqual(["Door"]);
      }
    });

    it("enforces keyframe timing and the shot's lens", () => {
      const shot = parseProject(v3()).scenes[0]!.shots[1]!;
      expect(ShotSchema.parse(shot)).toEqual(shot);
      const late = structuredClone(shot);
      late.keyframes[0]!.timeSeconds = 1;
      expect(() => ShotSchema.parse(late)).toThrow("first keyframe");
      const long = structuredClone(shot);
      long.durationSeconds = 5;
      expect(() => ShotSchema.parse(long)).toThrow("exceeds shot duration");
      const prime = structuredClone(shot);
      prime.setup.lens = { kind: "prime", focalLengthMm: 50 };
      expect(() => ShotSchema.parse(prime)).toThrow("outside the shot's lens");
      const zoom = structuredClone(shot);
      zoom.setup.lens = { kind: "zoom", minFocalLengthMm: 85, maxFocalLengthMm: 50 };
      expect(() => ShotSchema.parse(zoom)).toThrow("longer maximum");
      const reversed = structuredClone(shot);
      reversed.keyframes[1]!.timeSeconds = 0;
      expect(() => ShotSchema.parse(reversed)).toThrow("must increase");
    });

    it("migrates a v2 project into one scene of v4 shots without losing work", () => {
      const raw = v2();
      const project = parseProject(raw);
      expect(project.schemaVersion).toBe(4);
      expect(project.scenes.map((s) => s.id)).toEqual([`scene-${raw.id}`]);
      expect(parseProject(raw).scenes[0]!.id).toBe(project.scenes[0]!.id);
      const w = workspaceOf(project);
      expect(w.shots.map((s) => s.id)).toEqual(["shot", "move-move"]);
      expect(w.shotSheet?.excludedShotIds).toEqual(raw.shotSheet.excludedShotIds);
      expect(project.createdAt).toBe(raw.updatedAt);
    });
  });

  describe("multi-scene projects", () => {
    const v2 = () => ({
      schemaVersion: 2,
      ...(() => {
        const { schemaVersion: _v, createdAt: _c, scenes, ...rest } = parseProject(legacyProject());
        void _v;
        void _c;
        const s = scenes[0]!;
        return {
          ...rest,
          scene: s.scene,
          sceneId: s.sceneId,
          assetVersionId: s.assetVersionId,
          durationSeconds: 8,
          camera: s.camera,
          shots: [],
          path: {
            id: "move",
            sceneId: s.sceneId,
            assetVersionId: s.assetVersionId,
            name: "Push",
            keyframes: [],
          },
        };
      })(),
    });
    const withShot = () => {
      const project = parseProject(v2());
      const legacyShots = parseProject(legacyProject()).scenes[0]!.shots;
      return ProjectSchema.parse({
        ...project,
        scenes: [{ ...project.scenes[0]!, shots: legacyShots.slice(0, 1) }],
      });
    };

    it("rejects duplicate scene and project-wide duplicate shot IDs", () => {
      const project = withShot();
      const scene = project.scenes[0]!;
      expect(() => ProjectSchema.parse({ ...project, scenes: [scene, scene] })).toThrow(
        "Scene IDs",
      );
      expect(() =>
        ProjectSchema.parse({ ...project, scenes: [scene, { ...scene, id: "second" }] }),
      ).toThrow("Shot IDs");
      expect(() => ProjectSchema.parse({ ...project, scenes: [] })).toThrow();
    });

    it("applies a workspace to its scene only and keeps other scenes' export choices", () => {
      const base = withShot();
      const first = base.scenes[0]!;
      const second = {
        ...structuredClone(first),
        id: "second",
        name: "Second",
        shots: first.shots.map((s) => ({ ...s, id: `${s.id}-b` })),
      };
      const project = ProjectSchema.parse({
        ...base,
        scenes: [first, second],
        shotSheet: { version: 1, excludedShotIds: [first.shots[0]!.id, second.shots[0]!.id] },
      });
      const w = sceneWorkspace(project, "second");
      expect(w.shotSheet?.excludedShotIds).toEqual([second.shots[0]!.id]);
      const next = applySceneWorkspace(project, {
        ...w,
        projectSceneName: "Renamed",
        updatedAt: project.updatedAt + 5,
        shotSheet: { version: 1, excludedShotIds: [] },
      });
      expect(ProjectSchema.parse(next)).toEqual(next);
      expect(next.scenes[0]).toEqual(first);
      expect(next.scenes[1]!.name).toBe("Renamed");
      expect(next.updatedAt).toBe(project.updatedAt + 5);
      expect(next.shotSheet?.excludedShotIds).toEqual([first.shots[0]!.id]);
      expect(() => sceneWorkspace(project, "missing")).toThrow("no longer part");
    });
  });
});
