import { migrated, editFirstScene, shotFrom } from "../test/projectFixtures";
import { migrateScene } from "@oculo/scene-schema";
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { IndexedDBProjectStore } from "./ProjectStore";
import { SyncedProjectStore } from "./SyncedProjectStore";
import { sanitizeProjectForCloud, type CloudProjectRepository } from "./CloudProjectRepository";
import { DEFAULT_CAMERA, type Project } from "../types/project";

const databaseNames: string[] = [];

function makeProject(id: string, updatedAt: number): Project {
  return migrated({
    sceneId: "garden",
    assetVersionId: "legacy-scene:garden",
    schemaVersion: 2,
    id,
    name: `Project ${id}`,
    scene: migrateScene({
      id: "garden",
      name: "Garden",
      splatUrl: "https://example.com/scene.spz",
      source: "bundled",
    }),
    updatedAt,
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

class FakeCloudRepository implements CloudProjectRepository {
  readonly byUid = new Map<string, Map<string, Project>>();
  failing = false;
  beforeList?: (uid: string) => Promise<void>;
  beforePut?: (uid: string, project: Project) => Promise<void>;

  private bucket(uid: string): Map<string, Project> {
    let bucket = this.byUid.get(uid);
    if (bucket === undefined) {
      bucket = new Map();
      this.byUid.set(uid, bucket);
    }
    return bucket;
  }

  private maybeFail(): void {
    if (this.failing) throw new Error("simulated cloud failure");
  }

  async list(uid: string): Promise<Project[]> {
    this.maybeFail();
    const snapshot = [...this.bucket(uid).values()].map((project) => structuredClone(project));
    await this.beforeList?.(uid);
    return snapshot;
  }

  async put(uid: string, project: Project): Promise<void> {
    this.maybeFail();
    const snapshot = structuredClone(project);
    await this.beforePut?.(uid, snapshot);
    if ((this.bucket(uid).get(project.id)?.updatedAt ?? -Infinity) > snapshot.updatedAt) {
      throw new Error("A newer cloud version conflicts with local edits");
    }
    this.bucket(uid).set(project.id, sanitizeProjectForCloud(snapshot));
  }

  async delete(uid: string, projectId: string): Promise<void> {
    this.maybeFail();
    this.bucket(uid).delete(projectId);
  }

  async deleteAll(uid: string): Promise<void> {
    this.maybeFail();
    this.byUid.delete(uid);
  }
}

function makeStores() {
  const name = `oculo-sync-test-${crypto.randomUUID()}`;
  databaseNames.push(name);
  const local = new IndexedDBProjectStore(name);
  const cloud = new FakeCloudRepository();
  const synced = new SyncedProjectStore(local, cloud);
  return { local, cloud, synced };
}

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => indexedDB.deleteDatabase(name)));
});

describe("SyncedProjectStore", () => {
  it("keeps imported scene projects local through sign-in, editing, and explicit backup requests", async () => {
    const { local, synced, cloud } = makeStores();
    const asset = {
      version: 1 as const,
      id: "local-scene",
      filename: "scene.spz",
      format: "spz" as const,
      byteLength: 4,
    };
    const project = makeProject("import", 10);
    project.scenes[0]!.scene = migrateScene({
      id: "import-scene",
      name: "Imported",
      source: "imported",
      splatUrl: "oculo-asset:local-scene",
      localAsset: asset,
    });
    project.scenes[0]!.sceneId = project.scenes[0]!.scene.id;
    project.scenes[0]!.assetVersionId = project.scenes[0]!.scene.asset.versionId;
    await local.putImportedProject(project, {
      id: asset.id,
      descriptor: asset,
      data: new Blob(["test"]),
    });
    synced.setUser("user-1");
    await synced.syncNow();
    expect(await synced.listBackupCandidates()).toEqual([]);
    expect(await synced.listAdoptableProjects()).toEqual([]);
    await synced.put({ ...project, name: "Edited import" });
    await synced.flushDirty();
    expect(cloud.byUid.get("user-1")?.has("import")).toBeFalsy();
    await expect(synced.adoptLocalProjects([project.id])).rejects.toThrow("stay on this device");
    expect((await local.get(project.id))?.name).toBe("Edited import");
    expect((await local.getSceneAsset(asset.id))?.size).toBe(4);
  });

  it("adopts never-owned local projects only after an explicit backup action", async () => {
    const { synced, cloud } = makeStores();
    await synced.put(makeProject("local-only", 10));

    synced.setUser("user-1");
    await synced.syncNow();
    expect(cloud.byUid.get("user-1")?.has("local-only")).toBe(false);
    expect((await synced.listAdoptableProjects()).map(({ id }) => id)).toEqual(["local-only"]);
    await synced.adoptLocalProjects();

    expect(cloud.byUid.get("user-1")?.get("local-only")?.name).toBe("Project local-only");
  });

  it("pulls remote projects that do not exist locally", async () => {
    const { synced, cloud } = makeStores();
    await cloud.put("user-1", makeProject("remote-only", 5));

    synced.setUser("user-1");
    await synced.syncNow();

    expect((await synced.get("remote-only"))?.name).toBe("Project remote-only");
  });

  it("pulls newer remote work only when the owned local copy has no pending edits", async () => {
    const { synced, cloud } = makeStores();
    synced.setUser("user-1");
    await synced.syncNow();
    await synced.put({ ...makeProject("a", 10), name: "Local A" });
    await synced.flushDirty();
    await cloud.put("user-1", { ...makeProject("a", 20), name: "Remote A" });
    await synced.put({ ...makeProject("b", 30), name: "Local B" });
    await synced.syncNow();

    expect((await synced.get("a"))?.name).toBe("Remote A");
    expect((await synced.get("b"))?.name).toBe("Local B");
    expect(cloud.byUid.get("user-1")?.get("b")?.name).toBe("Local B");
  });

  it("pushes edits made while signed in", async () => {
    const { synced, cloud } = makeStores();
    synced.setUser("user-1");
    await synced.syncNow();

    await synced.put(makeProject("draft", 100));
    await synced.flushDirty();

    expect(cloud.byUid.get("user-1")?.has("draft")).toBe(true);
  });

  it("propagates local deletions of synced projects to the cloud", async () => {
    const { synced, cloud } = makeStores();
    synced.setUser("user-1");
    await synced.put(makeProject("doomed", 1));
    await synced.flushDirty();
    expect(cloud.byUid.get("user-1")?.has("doomed")).toBe(true);

    await synced.delete("doomed");
    await synced.flushDirty();

    expect(cloud.byUid.get("user-1")?.has("doomed")).toBe(false);
    expect(await synced.get("doomed")).toBeUndefined();
  });

  it("removes local projects that were deleted from another device", async () => {
    const { synced, cloud } = makeStores();
    synced.setUser("user-1");
    await synced.put(makeProject("shared", 1));
    await synced.syncNow();

    // Another device deletes the cloud copy.
    await cloud.delete("user-1", "shared");
    await synced.syncNow();

    expect(await synced.get("shared")).toBeUndefined();
  });

  it("keeps local state intact and dirty when the cloud fails", async () => {
    const { synced, cloud, local } = makeStores();
    synced.setUser("user-1");
    await synced.syncNow();

    cloud.failing = true;
    await synced.put(makeProject("resilient", 50));
    await synced.flushDirty();

    expect((await synced.get("resilient"))?.name).toBe("Project resilient");
    expect((await local.getSyncMeta("resilient"))?.dirty).toBe(true);

    // The cloud recovers; the next flush clears the backlog.
    cloud.failing = false;
    await synced.flushDirty();
    expect(cloud.byUid.get("user-1")?.has("resilient")).toBe(true);
    expect((await local.getSyncMeta("resilient"))?.dirty).toBe(false);
  });

  it("retains ownership and never re-adopts another account's projects after sign-out", async () => {
    const { synced, cloud } = makeStores();
    synced.setUser("user-1");
    await synced.put(makeProject("mine", 1));
    await synced.syncNow();

    await synced.clearSyncState();
    synced.setUser("user-2");
    await synced.syncNow();
    await synced.adoptLocalProjects(["mine"]);
    await synced.put({ ...makeProject("mine", 5), name: "Edited on this device" });
    await synced.flushDirty();
    expect((await synced.get("mine"))?.name).toBe("Edited on this device");
    expect(cloud.byUid.get("user-2")?.has("mine")).toBe(false);
    expect(await synced.listAdoptableProjects()).toEqual([]);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withImage(project: Project, image = "data:image/jpeg;base64,frame"): Project {
  return editFirstScene(project, (w) => ({
    ...w,
    shots: [
      shotFrom({
        assetVersionId: `legacy-scene:${w.scene.id}`,
        id: "shot",
        sceneId: w.scene.id,
        name: "Shot",
        camera: structuredClone(DEFAULT_CAMERA),
        createdAt: new Date(0).toISOString(),
        thumbnailDataUrl: image,
      }),
    ],
  }));
}

describe("sync image and concurrency protection", () => {
  it("preserves first-device imagery after a metadata-only edit on a second device", async () => {
    const { synced: first, cloud } = makeStores();
    first.setUser("user");
    await first.syncNow();
    const image = `data:image/jpeg;base64,${"x".repeat(950_000)}`;
    await first.put(withImage(makeProject("large", 1), image));
    await first.flushDirty();
    expect(
      cloud.byUid.get("user")?.get("large")?.scenes[0]!.shots[0]?.thumbnailDataUrl,
    ).toBeUndefined();

    const secondLocal = makeStores().local;
    const second = new SyncedProjectStore(secondLocal, cloud);
    second.setUser("user");
    await second.syncNow();
    const remote = (await second.get("large"))!;
    expect(remote.scenes[0]!.shots[0]?.thumbnailDataUrl).toBeUndefined();
    await second.put(
      editFirstScene({ ...remote, updatedAt: 2 }, (w) => ({
        ...w,
        shots: w.shots.map((shot) => ({ ...shot, notes: "Revised blocking" })),
      })),
    );
    await second.flushDirty();
    await first.syncNow();
    expect((await first.get("large"))?.scenes[0]!.shots[0]?.thumbnailDataUrl).toBe(image);
    expect((await first.get("large"))?.scenes[0]!.shots[0]?.notes).toBe("Revised blocking");
  });

  it("does not reuse a local frame after another device changes the saved camera", async () => {
    const { synced, cloud } = makeStores();
    synced.setUser("user");
    await synced.syncNow();
    await synced.put(withImage(makeProject("p", 1)));
    await synced.flushDirty();
    const remote = structuredClone(cloud.byUid.get("user")!.get("p")!);
    remote.updatedAt = 2;
    remote.scenes[0]!.shots[0]!.keyframes[0]!.pose.position[0] = 9;
    delete remote.scenes[0]!.shots[0]!.thumbnailDataUrl;
    await cloud.put("user", remote);
    await synced.syncNow();
    expect((await synced.get("p"))?.scenes[0]!.shots[0]?.thumbnailDataUrl).toBeUndefined();
  });

  it("does not mark a newer edit clean when an older upload finishes", async () => {
    const { synced, cloud, local } = makeStores();
    synced.setUser("user");
    await synced.syncNow();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    let uploads = 0;
    cloud.beforePut = async () => {
      uploads += 1;
      if (uploads === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      if (uploads === 2) {
        secondStarted.resolve();
        await releaseSecond.promise;
      }
    };
    await synced.put(makeProject("p", 1));
    await firstStarted.promise;
    await synced.put({ ...makeProject("p", 2), name: "Newer edit" });
    expect((await local.getSyncMeta("p"))?.dirty).toBe(true);
    releaseFirst.resolve();
    await secondStarted.promise;
    expect((await local.getSyncMeta("p"))?.dirty).toBe(true);
    expect((await synced.get("p"))?.name).toBe("Newer edit");
    releaseSecond.resolve();
    await synced.flushDirty();
    expect(cloud.byUid.get("user")?.get("p")?.name).toBe("Newer edit");
    expect((await local.getSyncMeta("p"))?.dirty).toBe(false);
  });

  it.each(["update", "delete"])(
    "retains an edit racing a remote %s response",
    async (remoteAction) => {
      const { synced, cloud } = makeStores();
      synced.setUser("user");
      await synced.syncNow();
      await synced.put(makeProject("p", 1));
      await synced.flushDirty();
      if (remoteAction === "delete") await cloud.delete("user", "p");
      else await cloud.put("user", { ...makeProject("p", 2), name: "Remote revision" });
      const started = deferred();
      const release = deferred();
      cloud.beforeList = async () => {
        started.resolve();
        await release.promise;
      };
      const pulling = synced.syncNow();
      await started.promise;
      await synced.put({ ...makeProject("p", 3), name: "Newest local revision" });
      release.resolve();
      await pulling;
      await synced.flushDirty();
      expect((await synced.get("p"))?.name).toBe("Newest local revision");
      expect(cloud.byUid.get("user")?.get("p")?.name).toBe("Newest local revision");
    },
  );

  it("propagates deletion even if the initial upload has not completed yet", async () => {
    const { synced, cloud } = makeStores();
    synced.setUser("user");
    await synced.syncNow();
    const started = deferred();
    const release = deferred();
    cloud.beforePut = async () => {
      started.resolve();
      await release.promise;
    };
    await synced.put(withImage(makeProject("p", 1)));
    await started.promise;
    await synced.delete("p");
    release.resolve();
    await synced.flushDirty();
    expect(await synced.get("p")).toBeUndefined();
    expect(cloud.byUid.get("user")?.has("p")).toBe(false);
  });

  it("rejects invalid or newer-schema remote records instead of treating them as deletion", async () => {
    const { synced, cloud } = makeStores();
    synced.setUser("user");
    await synced.syncNow();
    await synced.put(withImage(makeProject("p", 1)));
    await synced.flushDirty();
    cloud.byUid
      .get("user")!
      .set("p", { ...makeProject("p", 2), schemaVersion: 99 } as unknown as Project);
    await expect(synced.syncNow()).rejects.toThrow("Unsupported project");
    expect((await synced.get("p"))?.scenes[0]!.shots[0]?.thumbnailDataUrl).toBeDefined();
    expect(synced.getSyncState().status).toBe("error");
  });

  it("keeps dirty local work and reports a conflict when the remote clock is newer", async () => {
    const { synced, cloud, local } = makeStores();
    synced.setUser("user");
    await synced.syncNow();
    await synced.put(makeProject("p", 1));
    await synced.flushDirty();
    cloud.failing = true;
    await synced.put({ ...makeProject("p", 2), name: "Local work" });
    await synced.flushDirty();
    cloud.failing = false;
    await cloud.put("user", { ...makeProject("p", 10), name: "Remote work" });
    await expect(synced.syncNow()).rejects.toThrow("conflicts with local");
    expect((await synced.get("p"))?.name).toBe("Local work");
    expect((await local.getSyncMeta("p"))?.dirty).toBe(true);
    expect(synced.getSyncState().status).toBe("error");
    expect(cloud.byUid.get("user")?.get("p")?.name).toBe("Remote work");
  });

  it("rejects a previous account's pending download after switching accounts", async () => {
    const { synced, cloud } = makeStores();
    await cloud.put("first", withImage(makeProject("first-project", 1)));
    await cloud.put("second", makeProject("second-project", 1));
    const started = deferred();
    const release = deferred();
    cloud.beforeList = async (uid) => {
      if (uid === "first") {
        started.resolve();
        await release.promise;
      }
    };
    synced.setUser("first");
    await started.promise;
    synced.setUser("second");
    release.resolve();
    await synced.syncNow();
    expect(await synced.get("first-project")).toBeUndefined();
    expect((await synced.get("second-project"))?.name).toBe("Project second-project");
  });

  it("does not clean or transfer a previous account's pending upload after switching accounts", async () => {
    const { synced, cloud, local } = makeStores();
    synced.setUser("first");
    await synced.syncNow();
    const started = deferred();
    const release = deferred();
    cloud.beforePut = async () => {
      started.resolve();
      await release.promise;
    };
    await synced.put(makeProject("p", 1));
    await started.promise;
    synced.setUser("second");
    release.resolve();
    await synced.syncNow();
    expect((await local.getSyncMeta("p"))?.ownerUid).toBe("first");
    expect((await local.getSyncMeta("p"))?.dirty).toBe(true);
    expect(cloud.byUid.get("second")?.has("p")).toBe(false);
  });

  it("waits for a dispatched upload before deleting the account's cloud documents", async () => {
    const { synced, cloud } = makeStores();
    synced.setUser("user");
    await synced.syncNow();
    const started = deferred();
    const release = deferred();
    cloud.beforePut = async () => {
      started.resolve();
      await release.promise;
    };
    await synced.put(makeProject("p", 1));
    await started.promise;
    const deleting = synced.deleteCloudData();
    release.resolve();
    await deleting;
    expect(cloud.byUid.has("user")).toBe(false);
    expect(await synced.get("p")).toBeDefined();
  });

  it("retries failed cloud deletion even after the sync session was quiesced", async () => {
    const { synced, cloud } = makeStores();
    synced.setUser("user");
    await synced.syncNow();
    await synced.put(makeProject("p", 1));
    await synced.flushDirty();
    cloud.failing = true;
    await expect(synced.deleteCloudData()).rejects.toThrow("simulated");
    // A reauthentication notification cannot restart sync during the retry window.
    synced.setUser("user");
    cloud.failing = false;
    await synced.deleteCloudData();
    expect(cloud.byUid.has("user")).toBe(false);
    expect(await synced.get("p")).toBeDefined();
  });
});

describe("explicit backup and conflict recovery", () => {
  it("offers unknown legacy ownership only for explicit selection and never offers known owners", async () => {
    const { synced, local, cloud } = makeStores();
    await synced.put(withImage(makeProject("local", 1)));
    await synced.put(makeProject("legacy", 2));
    await local.putSyncMeta({
      id: "legacy",
      dirty: false,
      deleted: false,
      lastSyncedAt: 10,
      revision: 1,
    });
    await local.putOwned(makeProject("other", 1), "other-account");
    synced.setUser("user");
    await synced.syncNow();
    expect(await synced.listBackupCandidates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: "local",
          legacyOwnershipUnknown: false,
          missingImageCount: 0,
        }),
        expect.objectContaining({ projectId: "legacy", legacyOwnershipUnknown: true }),
      ]),
    );
    expect((await synced.listBackupCandidates()).map(({ projectId }) => projectId)).not.toContain(
      "other",
    );
    await synced.adoptLocalProjects();
    expect(cloud.byUid.get("user")?.has("legacy")).toBe(false);
    await synced.adoptLocalProjects(["legacy"]);
    expect(cloud.byUid.get("user")?.has("legacy")).toBe(true);
    expect(cloud.byUid.get("user")?.has("other")).toBe(false);
  });

  async function conflict() {
    const stores = makeStores();
    const { synced, cloud } = stores;
    synced.setUser("user");
    await synced.syncNow();
    await synced.put(withImage(makeProject("p", 1)));
    await synced.flushDirty();
    cloud.failing = true;
    await synced.put({ ...withImage(makeProject("p", 2)), name: "Local revision" });
    await synced.flushDirty();
    cloud.failing = false;
    await cloud.put("user", { ...makeProject("p", 10), name: "Cloud revision" });
    return stores;
  }

  it("lists a conflict without changing either version, then keeps both with local images intact", async () => {
    const { synced, cloud } = await conflict();
    expect(await synced.listConflicts()).toEqual([
      { projectId: "p", localName: "Local revision", remoteName: "Cloud revision" },
    ]);
    expect((await synced.get("p"))?.name).toBe("Local revision");
    await synced.recoverConflict("p");
    const all = await synced.list();
    const localCopy = all.find(({ id }) => id !== "p")!;
    expect(localCopy.name).toBe("Local revision (local copy)");
    expect(localCopy.scenes[0]!.shots[0]?.thumbnailDataUrl).toBe("data:image/jpeg;base64,frame");
    expect((await synced.get("p"))?.name).toBe("Cloud revision");
    expect(cloud.byUid.get("user")?.get("p")?.name).toBe("Cloud revision");
    expect(cloud.byUid.get("user")?.get(localCopy.id)?.name).toBe(localCopy.name);
    expect(await synced.listConflicts()).toEqual([]);
  });

  it("does not install a cloud version over edits made while recovery is fetching it", async () => {
    const { synced, cloud } = await conflict();
    const started = deferred();
    const release = deferred();
    cloud.beforeList = async () => {
      started.resolve();
      await release.promise;
    };
    const recovery = synced.recoverConflict("p");
    const rejected = expect(recovery).rejects.toThrow("changed during recovery");
    await started.promise;
    cloud.failing = true;
    await synced.put({ ...withImage(makeProject("p", 3)), name: "New edits during recovery" });
    await synced.flushDirty();
    release.resolve();
    await rejected;
    expect(await synced.list()).toHaveLength(1);
    expect((await synced.get("p"))?.name).toBe("New edits during recovery");
  });

  it("retains both copies locally and reports when backing up the copy fails", async () => {
    const { synced, cloud } = await conflict();
    cloud.beforePut = async () => {
      throw new Error("Upload interrupted");
    };
    await expect(synced.recoverConflict("p")).rejects.toThrow(
      "Both versions are kept on this device",
    );
    expect(await synced.list()).toHaveLength(2);
    expect((await synced.get("p"))?.name).toBe("Cloud revision");
    expect(
      (await synced.list()).find(({ id }) => id !== "p")?.scenes[0]!.shots[0]?.thumbnailDataUrl,
    ).toBeDefined();
  });

  it("surfaces an adoption upload failure so consent UI cannot announce backup success", async () => {
    const { synced, cloud } = makeStores();
    await synced.put(makeProject("p", 1));
    synced.setUser("user");
    await synced.syncNow();
    cloud.failing = true;
    await expect(synced.adoptLocalProjects(["p"])).rejects.toThrow("simulated cloud failure");
    expect(await synced.get("p")).toBeDefined();
    expect(synced.getSyncState().pendingCount).toBe(1);
  });
});
