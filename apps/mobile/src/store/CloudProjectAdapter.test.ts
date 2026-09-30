import { migrated } from "../test/projectFixtures";
import { migrateScene } from "@oculo/scene-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirebaseApp } from "firebase/app";
import { FirestoreProjectRepository } from "./CloudProjectRepository";
import { DEFAULT_CAMERA, type Project } from "../types/project";

const sdk = vi.hoisted(() => ({
  getDocs: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  commit: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  getFirestore: () => ({}),
  collection: (...parts: unknown[]) => parts,
  doc: (...parts: unknown[]) => parts,
  getDocs: sdk.getDocs,
  deleteDoc: sdk.delete,
  writeBatch: () => ({ delete: sdk.delete, commit: sdk.commit }),
  runTransaction: async (
    _db: unknown,
    work: (tx: { get: typeof sdk.get; set: typeof sdk.set }) => Promise<void>,
  ) => work({ get: sdk.get, set: sdk.set }),
}));

function project(): Project {
  return migrated({
    sceneId: "scene",
    assetVersionId: "legacy-scene:scene",
    schemaVersion: 2,
    id: "p",
    name: "Project",
    updatedAt: 1,
    durationSeconds: 8,
    scene: migrateScene({
      id: "scene",
      name: "Scene",
      splatUrl: "https://example.com/scene.spz",
      source: "bundled",
    }),
    camera: DEFAULT_CAMERA,
    shots: [],
    path: {
      sceneId: "scene",
      assetVersionId: "legacy-scene:scene",
      id: "path",
      name: "Move",
      keyframes: [],
    },
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  sdk.commit.mockResolvedValue(undefined);
});

const repository = () => new FirestoreProjectRepository({} as FirebaseApp);

describe("Firestore project safety boundary", () => {
  it.each([
    { schemaVersion: 99 },
    { camera: { focalLengthMm: "broken" } },
    { id: "different-document" },
  ])("rejects an incomplete listing containing invalid data %o", async (patch) => {
    sdk.getDocs.mockResolvedValue({
      docs: [
        { id: "valid", data: () => ({ ...project(), id: "valid" }) },
        { id: "p", data: () => ({ ...project(), ...patch }) },
      ],
    });
    await expect(repository().list("user")).rejects.toMatchObject({ code: "invalid-data" });
  });

  it("checks remote freshness inside the transaction before overwriting a document", async () => {
    sdk.get.mockResolvedValue({
      exists: () => true,
      data: () => ({ ...project(), updatedAt: 10 }),
    });
    await expect(repository().put("user", { ...project(), updatedAt: 2 })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(sdk.set).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer schema even if it was not present at the earlier sync listing", async () => {
    sdk.get.mockResolvedValue({
      exists: () => true,
      data: () => ({ ...project(), schemaVersion: 99 }),
    });
    await expect(repository().put("user", project())).rejects.toMatchObject({
      code: "invalid-data",
    });
    expect(sdk.set).not.toHaveBeenCalled();
  });

  it("writes the validated payload after the remote transaction check passes", async () => {
    sdk.get.mockResolvedValue({ exists: () => true, data: () => project() });
    await repository().put("user", { ...project(), updatedAt: 2 });
    expect(sdk.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "p", updatedAt: 2 }),
    );
  });

  it("deletes large accounts in bounded batches that can be retried after partial completion", async () => {
    sdk.getDocs.mockResolvedValue({
      empty: false,
      docs: Array.from({ length: 901 }, (_, id) => ({ ref: id })),
    });
    await repository().deleteAll("user");
    expect(sdk.delete).toHaveBeenCalledTimes(901);
    expect(sdk.commit).toHaveBeenCalledTimes(3);
  });
});
