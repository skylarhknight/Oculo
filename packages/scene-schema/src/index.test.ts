import {
  CameraSpeedCurveSchema,
  MAX_SPEED_CURVE_POINTS,
  MAX_SPEED_WEIGHT,
  type CameraSpeedCurve,
} from "./index";
import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  migrateScene,
  parseCameraPath,
  parseCameraPose,
  parseCinematicCamera,
  parseSavedShot,
  parseSceneDescriptor,
  parseShot,
  stringifyShot,
  type Shot,
  stringifyCameraPath,
  stringifyCameraPose,
  stringifyCinematicCamera,
  stringifySavedShot,
  stringifySceneDescriptor,
  upgradePersistenceEnvelope,
  type CameraPath,
  type CameraPose,
  type CinematicCamera,
  type SavedShot,
  type SceneDescriptor,
} from "./index";

const pose: CameraPose = {
  position: [1, 2, 3],
  quaternion: [0, 0, 0, 1],
};

const camera: CinematicCamera = {
  pose,
  focalLengthMm: 50,
  sensorWidthMm: 36,
  sensorHeightMm: 24,
  output: { aspectRatio: 1.5, crop: "center-inside-sensor" },
  near: 0.1,
  far: 1_000,
};

const shot: SavedShot = {
  id: "shot-1",
  sceneId: "scene-1",
  assetVersionId: "legacy-scene:scene-1",
  name: "Opening frame",
  camera,
  thumbnailDataUrl: "data:image/jpeg;base64,abc",
  notes: "Hold on the doorway",
  createdAt: "2026-08-12T08:00:00.000Z",
};

const path: CameraPath = {
  id: "path-1",
  sceneId: "scene-1",
  assetVersionId: "legacy-scene:scene-1",
  name: "Push in",
  keyframes: [
    { timeSeconds: 0, camera },
    {
      timeSeconds: 3,
      camera: {
        ...camera,
        pose: {
          position: [4, 5, 6],
          quaternion: [0, 0.7071068, 0, 0.7071068],
        },
        focalLengthMm: 85,
      },
    },
  ],
};

const scene: SceneDescriptor = migrateScene({
  id: "scene-1",
  name: "Upright scene",
  splatUrl: "https://example.com/scene.spz",
  splatQuaternion: [1, 0, 0, 0],
  initialCameraPose: {
    position: [0, 0, 3],
    quaternion: [0, 0, 0, 1],
  },
  source: "bundled",
});

describe("versioned serialization", () => {
  it("round-trips scene orientation and initial camera metadata", () => {
    expect(parseSceneDescriptor(stringifySceneDescriptor(scene))).toEqual(scene);
  });

  it("round-trips a CameraPose", () => {
    const serialized = stringifyCameraPose(pose);

    expect(JSON.parse(serialized)).toMatchObject({
      version: CURRENT_SCHEMA_VERSION,
      type: "CameraPose",
    });
    expect(parseCameraPose(serialized)).toEqual(pose);
  });

  it("round-trips a CinematicCamera", () => {
    expect(parseCinematicCamera(stringifyCinematicCamera(camera))).toEqual(camera);
  });

  it("round-trips a SavedShot", () => {
    expect(parseSavedShot(stringifySavedShot(shot))).toEqual(shot);
  });

  it("round-trips a Shot with focus, aperture and speed", () => {
    const moving: Shot = {
      id: "shot-2",
      sceneId: "scene-1",
      assetVersionId: "legacy-scene:scene-1",
      name: "Push in",
      createdAt: "2026-08-12T08:00:00.000Z",
      durationSeconds: 4,
      setup: {
        lens: { kind: "zoom", minFocalLengthMm: 24, maxFocalLengthMm: 70 },
        sensorWidthMm: 36,
        sensorHeightMm: 24,
        output: { aspectRatio: 1.5, crop: "center-inside-sensor" },
        near: 0.1,
        far: 1_000,
      },
      keyframes: [
        { id: "a", timeSeconds: 0, pose, focalLengthMm: 24, focusDistanceM: 5, apertureFStop: 2.8 },
        {
          id: "b",
          timeSeconds: 4,
          pose,
          focalLengthMm: 70,
          focusDistanceM: 1.5,
          apertureFStop: 5.6,
        },
      ],
    };
    expect(parseShot(stringifyShot(moving))).toEqual(moving);
  });

  it("round-trips a CameraPath", () => {
    expect(parseCameraPath(stringifyCameraPath(path))).toEqual(path);
  });

  it("rejects future and otherwise unsupported versions", () => {
    const futureEnvelope = {
      version: CURRENT_SCHEMA_VERSION + 1,
      type: "CameraPose",
      data: pose,
    };
    const unsupportedEnvelope = {
      version: -1,
      type: "CameraPose",
      data: pose,
    };

    expect(() => parseCameraPose(futureEnvelope)).toThrow(
      `Unsupported schema version: ${CURRENT_SCHEMA_VERSION + 1}`,
    );
    expect(() => parseCameraPose(unsupportedEnvelope)).toThrow("Unsupported schema version: -1");
  });

  it("upgrades and parses a v0 payload envelope", () => {
    const legacyEnvelope = {
      version: 0,
      type: "CameraPose",
      payload: pose,
    };

    expect(upgradePersistenceEnvelope(legacyEnvelope)).toEqual({
      version: CURRENT_SCHEMA_VERSION,
      type: "CameraPose",
      data: pose,
    });
    expect(parseCameraPose(JSON.stringify(legacyEnvelope))).toEqual(pose);
  });

  it("rejects mismatched entity types", () => {
    expect(() => parseSavedShot(stringifyCameraPose(pose))).toThrow(
      "Expected persisted SavedShot, received CameraPose",
    );
  });

  it("validates domain invariants at runtime", () => {
    expect(() =>
      stringifyCinematicCamera({
        ...camera,
        far: camera.near,
      }),
    ).toThrow("Far clipping plane must be greater than near clipping plane");

    expect(() =>
      stringifyCameraPose({
        ...pose,
        quaternion: [0, 0, 0, 0],
      }),
    ).toThrow("Quaternion must have a non-zero length");
  });
});

const speedCurve: CameraSpeedCurve = {
  version: 1,
  points: [
    { time: 0, speed: 0, intensity: 0.7 },
    { time: 0.4, speed: 2, intensity: 0.3 },
    { time: 1, speed: 1, intensity: 0 },
  ],
};

describe("camera speed curve validation", () => {
  it("accepts the point limit, boundary values, and stationary sections", () => {
    const points = Array.from({ length: MAX_SPEED_CURVE_POINTS }, (_, index) => ({
      time: index / (MAX_SPEED_CURVE_POINTS - 1),
      speed: index === 0 ? MAX_SPEED_WEIGHT : 0,
      intensity: index % 2,
    }));
    expect(CameraSpeedCurveSchema.parse({ version: 1, points })).toEqual({
      version: 1,
      points,
    });
  });

  it.each([
    ["unknown version", { ...speedCurve, version: 2 }],
    ["missing version", { points: speedCurve.points }],
    ["unknown curve field", { ...speedCurve, privateMetadata: "unexpected" }],
    [
      "unknown point field",
      {
        ...speedCurve,
        points: speedCurve.points.map((point) => ({ ...point, extra: true })),
      },
    ],
    ["empty curve", { ...speedCurve, points: [] }],
    ["single point", { ...speedCurve, points: [speedCurve.points[0]] }],
    [
      "too many points",
      {
        ...speedCurve,
        points: Array.from({ length: MAX_SPEED_CURVE_POINTS + 1 }, (_, index) => ({
          time: index / MAX_SPEED_CURVE_POINTS,
          speed: 1,
          intensity: 0,
        })),
      },
    ],
    [
      "missing start endpoint",
      {
        ...speedCurve,
        points: speedCurve.points.map((point, index) =>
          index === 0 ? { ...point, time: 0.1 } : point,
        ),
      },
    ],
    [
      "missing end endpoint",
      {
        ...speedCurve,
        points: speedCurve.points.map((point, index) =>
          index === 2 ? { ...point, time: 0.9 } : point,
        ),
      },
    ],
    [
      "duplicate times",
      {
        ...speedCurve,
        points: speedCurve.points.map((point, index) =>
          index === 1 ? { ...point, time: 0 } : point,
        ),
      },
    ],
    [
      "unordered times",
      {
        ...speedCurve,
        points: [
          { time: 0, speed: 1, intensity: 0 },
          { time: 0.7, speed: 1, intensity: 0 },
          { time: 0.3, speed: 1, intensity: 0 },
          { time: 1, speed: 1, intensity: 0 },
        ],
      },
    ],
    [
      "all zero speeds",
      { ...speedCurve, points: speedCurve.points.map((point) => ({ ...point, speed: 0 })) },
    ],
  ])("rejects %s at the persistence boundary", (_reason, invalidCurve) => {
    expect(() =>
      parseCameraPath({
        version: 2,
        type: "CameraPath",
        data: {
          ...path,
          keyframes: [{ ...path.keyframes[0], speedCurve: invalidCurve }, path.keyframes[1]],
        },
      }),
    ).toThrow();
  });

  it.each([
    ["time", -0.1],
    ["time", 1.1],
    ["time", NaN],
    ["time", Infinity],
    ["speed", -0.1],
    ["speed", MAX_SPEED_WEIGHT + 0.1],
    ["speed", NaN],
    ["speed", Infinity],
    ["intensity", -0.1],
    ["intensity", 1.1],
    ["intensity", NaN],
    ["intensity", Infinity],
    ["intensity", undefined],
  ])("rejects invalid %s value %s", (field, value) => {
    expect(() =>
      CameraSpeedCurveSchema.parse({
        ...speedCurve,
        points: speedCurve.points.map((point, index) =>
          index === 1 ? { ...point, [field]: value } : point,
        ),
      }),
    ).toThrow();
  });
});

describe("local scene asset metadata", () => {
  const scene: SceneDescriptor = migrateScene({
    id: "import-123",
    name: "Own location",
    source: "imported",
    splatUrl: "oculo-asset:123",
    localAsset: { version: 1, id: "123", filename: "location.spz", format: "spz", byteLength: 100 },
  });
  it("round-trips an app-owned reference without source bytes", () => {
    expect(parseSceneDescriptor(stringifySceneDescriptor(scene))).toEqual(scene);
  });
  it.each([
    { id: "../secret" },
    { filename: "/Users/name/scene.spz" },
    { filename: "C:\\scene.spz" },
    { filename: "bad\nname.spz" },
    { byteLength: -1 },
    { byteLength: 2.5 },
    { version: 2 },
    { format: "ply" },
    { sourceBytes: "private" },
  ])("rejects invalid asset references %j", (change) => {
    expect(() =>
      stringifySceneDescriptor({
        ...scene,
        localAsset: { ...scene.localAsset, ...change },
      } as SceneDescriptor),
    ).toThrow();
  });
});

describe("app preferences and camera presets", () => {
  it("defaults missing preferences and rejects future versions", async () => {
    const { parseAppPreferences, DEFAULT_APP_PREFERENCES, parseCameraPreset } =
      await import("./preferences");
    expect(parseAppPreferences(undefined)).toEqual(DEFAULT_APP_PREFERENCES);
    expect(
      parseAppPreferences({ ...DEFAULT_APP_PREFERENCES, gallerySort: "name" }).gallerySort,
    ).toBe("name");
    expect(() => parseAppPreferences({ ...DEFAULT_APP_PREFERENCES, version: 2 })).toThrow(
      "Unsupported",
    );
    // Records saved before the Appearance setting existed follow the system.
    const older: Partial<typeof DEFAULT_APP_PREFERENCES> = { ...DEFAULT_APP_PREFERENCES };
    delete older.appearance;
    expect(parseAppPreferences(older).appearance).toBe("system");
    expect(parseAppPreferences({ ...older, appearance: "light" }).appearance).toBe("light");
    expect(() => parseAppPreferences({ ...older, appearance: "sepia" })).toThrow();
    const preset = {
      version: 1,
      id: "p",
      name: "A-cam 35",
      focalLengthMm: 35,
      sensorWidthMm: 36,
      sensorHeightMm: 24,
      aspectRatio: 2.39,
      createdAt: 1,
    };
    expect(parseCameraPreset(preset)).toEqual(preset);
    expect(() => parseCameraPreset({ ...preset, version: 2 })).toThrow("Unsupported");
    expect(() => parseCameraPreset({ ...preset, name: " " })).toThrow();
  });
});
