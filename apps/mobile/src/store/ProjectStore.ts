import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from "idb";
import {
  parseProject,
  shotStartCamera,
  assertSameSceneBinding,
  assetContentSignature,
  sceneBindingSignature,
  verifyAssetBytes,
  parseAppPreferences,
  parseCameraPreset,
  AppPreferencesSchema,
  CameraPresetSchema,
  MAX_CAMERA_PRESETS,
  type AppPreferences,
  type CameraPreset,
  type LocalSceneAsset,
} from "@oculo/scene-schema";
import type { Project, ProjectScene, Shot } from "../types/project";

export function validateProject(input: unknown): Project {
  const project = parseProject(input);
  if (project.scenes.some((s) => s.scene.localAsset && s.scene.source !== "imported"))
    throw new Error("Imported projects must reference durable local scene assets");
  if (project.shotSheet) {
    const ids = new Set(project.scenes.flatMap((scene) => scene.shots.map((s) => s.id)));
    project.shotSheet.excludedShotIds = [...new Set(project.shotSheet.excludedShotIds)].filter(
      (id) => ids.has(id),
    );
  }
  return project;
}

export interface ProjectStore {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | undefined>;
  put(project: Project): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ProjectSyncMeta {
  id: string;
  dirty: boolean;
  deleted: boolean;
  /** Local monotonic revision; independent of clocks and remote timestamps. */
  revision?: number;
  /** Never cleared by sign-out. Undefined legacy ownership requires explicit adoption. */
  ownerUid?: string;
  lastSyncedAt?: number;
}

export interface LocalProjectSnapshot {
  id: string;
  revision: number;
  project?: Project;
  meta?: ProjectSyncMeta;
}

export type SyncCommit =
  | { kind: "remote"; project: Project; ownerUid: string }
  | { kind: "acknowledge" | "delete"; ownerUid: string };

export interface LocalProjectStore extends ProjectStore {
  putOwned(project: Project, ownerUid?: string): Promise<void>;
  listSyncSnapshots(): Promise<LocalProjectSnapshot[]>;
  commitSync(
    snapshot: LocalProjectSnapshot,
    change: SyncCommit,
    signal: AbortSignal,
  ): Promise<boolean>;
  adoptProject(
    id: string,
    ownerUid: string,
    signal: AbortSignal,
    includeLegacy?: boolean,
  ): Promise<boolean>;
  forkConflict(
    snapshot: LocalProjectSnapshot,
    remote: Project,
    copy: Project,
    ownerUid: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  getSyncMeta(id: string): Promise<ProjectSyncMeta | undefined>;
  listSyncMeta(): Promise<ProjectSyncMeta[]>;
  putSyncMeta(meta: ProjectSyncMeta): Promise<void>;
  deleteSyncMeta(id: string): Promise<void>;
}

interface ShotImage {
  key: string;
  projectId: string;
  shotId: string;
  signature: string;
  dataUrl: string;
}

export interface StoredSceneAsset {
  id: string;
  descriptor: LocalSceneAsset;
  data: Blob;
}

interface OculoDatabase extends DBSchema {
  projects: { key: string; value: Project; indexes: { "by-updated": number } };
  syncMeta: { key: string; value: ProjectSyncMeta };
  shotImages: { key: string; value: ShotImage; indexes: { "by-project": string } };
  sceneBindings: { key: string; value: { key: string; signature: string } };
  sceneAssets: { key: string; value: StoredSceneAsset };
  preferences: { key: string; value: { key: string; data: unknown } };
  cameraPresets: { key: string; value: CameraPreset; indexes: { "by-created": number } };
  galleryAssets: { key: string; value: GalleryAsset };
}

/** A downloaded scene-gallery file, verified on arrival and kept for offline use. */
export interface GalleryAsset {
  /** The descriptor's asset `versionId`. */
  versionId: string;
  sceneId: string;
  sha256: string;
  byteSize: number;
  savedAt: number;
  data: Blob;
}

/** Downloaded scene-gallery files. A cache: removing one never touches a project. */
export interface GalleryAssetRepository {
  getGalleryAsset(versionId: string): Promise<GalleryAsset | undefined>;
  putGalleryAsset(asset: GalleryAsset): Promise<void>;
  listGalleryAssets(): Promise<Omit<GalleryAsset, "data">[]>;
  deleteGalleryAsset(versionId: string): Promise<void>;
}

/** Device-local settings that never sync and never count as project data. */
export interface PreferencesRepository {
  getPreferences(): Promise<AppPreferences>;
  putPreferences(preferences: AppPreferences): Promise<void>;
  listCameraPresets(): Promise<CameraPreset[]>;
  putCameraPreset(preset: CameraPreset): Promise<void>;
  deleteCameraPreset(id: string): Promise<void>;
}

type ProjectTransaction = IDBPTransaction<
  OculoDatabase,
  ["projects", "syncMeta", "shotImages", "sceneAssets", "sceneBindings"],
  "readwrite"
>;

/** Identifies the exact scene and saved camera that produced a local image. */
export function shotImageSignature(owner: Pick<ProjectScene, "scene">, shot: Shot): string {
  const camera = shotStartCamera(shot);
  return JSON.stringify([
    1,
    shot.sceneId,
    owner.scene.id,
    sceneBindingSignature(owner.scene),
    camera.pose.position,
    camera.pose.quaternion,
    camera.focalLengthMm,
    camera.sensorWidthMm,
    camera.sensorHeightMm,
    camera.output.aspectRatio,
    camera.near,
    camera.far,
  ]);
}

function imageKey(projectId: string, owner: ProjectScene, shot: Shot): string {
  return JSON.stringify([projectId, shot.id, shotImageSignature(owner, shot)]);
}

function withoutImages(project: Project): Project {
  return {
    ...project,
    scenes: project.scenes.map((scene) => ({
      ...scene,
      shots: scene.shots.map((shot) => {
        const copy = { ...shot };
        delete copy.thumbnailDataUrl;
        return copy;
      }),
    })),
  };
}

function localAssetIds(project: Project): Set<string> {
  return new Set(
    project.scenes.flatMap((s) => (s.scene.localAsset ? [s.scene.localAsset.id] : [])),
  );
}

export class IndexedDBProjectStore
  implements LocalProjectStore, PreferencesRepository, GalleryAssetRepository
{
  private readonly database: Promise<IDBPDatabase<OculoDatabase>>;

  constructor(
    name = "oculo",
    private readonly projectLimit: () => number = () => Infinity,
  ) {
    this.database = openDB<OculoDatabase>(name, 7, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          database
            .createObjectStore("projects", { keyPath: "id" })
            .createIndex("by-updated", "updatedAt");
        }
        if (oldVersion < 2) database.createObjectStore("syncMeta", { keyPath: "id" });
        if (!database.objectStoreNames.contains("shotImages")) {
          database
            .createObjectStore("shotImages", { keyPath: "key" })
            .createIndex("by-project", "projectId");
        }
        if (!database.objectStoreNames.contains("sceneAssets"))
          database.createObjectStore("sceneAssets", { keyPath: "id" });
        if (!database.objectStoreNames.contains("sceneBindings"))
          database.createObjectStore("sceneBindings", { keyPath: "key" });
        if (!database.objectStoreNames.contains("preferences"))
          database.createObjectStore("preferences", { keyPath: "key" });
        if (!database.objectStoreNames.contains("cameraPresets"))
          database
            .createObjectStore("cameraPresets", { keyPath: "id" })
            .createIndex("by-created", "createdAt");
        if (!database.objectStoreNames.contains("galleryAssets"))
          database.createObjectStore("galleryAssets", { keyPath: "versionId" });
      },
    });
  }

  private async transact<T>(
    operation: (tx: ProjectTransaction) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new DOMException("Sync session changed", "AbortError");
    const tx = (await this.database).transaction(
      ["projects", "syncMeta", "shotImages", "sceneAssets", "sceneBindings"],
      "readwrite",
      {
        durability: "strict",
      },
    );
    const abort = () => {
      try {
        tx.abort();
      } catch {
        /* Already committed or aborted. */
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    // Always observe the transaction rejection, including aborts between IDB requests.
    void tx.done.catch(() => undefined);
    try {
      if (signal?.aborted) throw new DOMException("Sync session changed", "AbortError");
      const result = await operation(tx);
      if (signal?.aborted) throw new DOMException("Sync session changed", "AbortError");
      await tx.done;
      return result;
    } catch (error) {
      abort();
      await tx.done.catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Atomically migrates embedded legacy images, then hydrates matching media only. */
  private async hydrate(tx: ProjectTransaction, raw: Project): Promise<Project> {
    const project = validateProject(raw);
    const images = tx.objectStore("shotImages");
    // Pre-contract rows had one scene with a splat URL; they migrate into scenes[0].
    const rawScene = (raw as unknown as { scene?: object }).scene;
    const legacyScene =
      rawScene && "splatUrl" in rawScene
        ? (rawScene as { splatUrl: string; splatQuaternion?: number[] })
        : undefined;
    let embedded = false;
    const scenes: ProjectScene[] = [];
    for (const [index, owner] of project.scenes.entries()) {
      const shots: Shot[] = [];
      for (const shot of owner.shots) {
        const key = imageKey(project.id, owner, shot);
        if (shot.thumbnailDataUrl !== undefined) {
          embedded = true;
          await images.put({
            key,
            projectId: project.id,
            shotId: shot.id,
            signature: shotImageSignature(owner, shot),
            dataUrl: shot.thumbnailDataUrl,
          });
          shots.push(shot);
          continue;
        }
        let image = await images.get(key);
        // The feature branch stored frames separately before adopting asset contracts.
        // Match its exact old camera/scene signature so upgrades do not orphan those frames.
        if (!image && legacyScene && index === 0) {
          const camera = shotStartCamera(shot);
          const signature = JSON.stringify([
            1,
            shot.sceneId,
            owner.scene.id,
            legacyScene.splatUrl,
            legacyScene.splatQuaternion ?? null,
            camera.pose.position,
            camera.pose.quaternion,
            camera.focalLengthMm,
            camera.sensorWidthMm,
            camera.sensorHeightMm,
            camera.output.aspectRatio,
            camera.near,
            camera.far,
          ]);
          const previous = await images.get(JSON.stringify([project.id, shot.id, signature]));
          if (previous) {
            image = { ...previous, key, signature: shotImageSignature(owner, shot) };
            await images.put(image);
          }
        }
        shots.push(image ? { ...shot, thumbnailDataUrl: image.dataUrl } : shot);
      }
      scenes.push({ ...owner, shots });
    }
    if (embedded) await tx.objectStore("projects").put(withoutImages(project));
    return { ...project, scenes };
  }

  private async registerSceneBinding(tx: ProjectTransaction, owner: ProjectScene): Promise<void> {
    const projects = tx.objectStore("projects");
    const bindings = tx.objectStore("sceneBindings");
    const key = JSON.stringify([owner.scene.id, owner.assetVersionId]);
    const signature = sceneBindingSignature(owner.scene);
    const assetKey = `asset:${owner.assetVersionId}`;
    const assetSignature = assetContentSignature(owner.scene.asset);
    const registered = await bindings.get(key);
    const registeredAsset = await bindings.get(assetKey);
    if (registeredAsset && registeredAsset.signature !== assetSignature)
      throw new Error("Asset version content is immutable across scenes");
    if (registered && registered.signature !== signature)
      throw new Error("Scene version was already registered with different content or coordinates");
    if (!registered || !registeredAsset) {
      for (const raw of await projects.getAll()) {
        for (const previous of validateProject(raw).scenes) {
          if (
            previous.assetVersionId === owner.assetVersionId &&
            assetContentSignature(previous.scene.asset) !== assetSignature
          )
            throw new Error("Asset version content is immutable across scenes");
          if (
            previous.scene.id === owner.scene.id &&
            previous.assetVersionId === owner.assetVersionId
          )
            assertSameSceneBinding(previous.scene, owner.scene);
        }
      }
    }
    await bindings.put({ key, signature });
    await bindings.put({ key: assetKey, signature: assetSignature });
  }

  private async writeProject(tx: ProjectTransaction, project: Project): Promise<void> {
    const projects = tx.objectStore("projects");
    const existing = await projects.get(project.id);
    const previousProject = existing === undefined ? undefined : validateProject(existing);
    for (const owner of project.scenes) {
      const before = previousProject?.scenes.find((s) => s.id === owner.id);
      if (before) assertSameSceneBinding(before.scene, owner.scene);
      await this.registerSceneBinding(tx, owner);
    }
    if (existing !== undefined) {
      const previous = await this.hydrate(tx, existing);
      const previousShots = new Map(
        previous.scenes.flatMap((owner) => owner.shots.map((shot) => [shot.id, { owner, shot }])),
      );
      project = {
        ...project,
        scenes: project.scenes.map((owner) => ({
          ...owner,
          shots: owner.shots.map((shot) => {
            const old = previousShots.get(shot.id);
            // A metadata edit may carry the hydrated old frame back unchanged.
            // That known old image cannot become evidence for a different camera.
            if (
              old?.shot.thumbnailDataUrl !== undefined &&
              shot.thumbnailDataUrl === old.shot.thumbnailDataUrl &&
              shotImageSignature(old.owner, old.shot) !== shotImageSignature(owner, shot)
            ) {
              const copy = { ...shot };
              delete copy.thumbnailDataUrl;
              return copy;
            }
            return shot;
          }),
        })),
      };
    }
    // Save incoming frames before stripping them from the project document.
    await this.hydrate(tx, project);
    await projects.put(withoutImages(project));
    const referenced = new Set(
      project.scenes.flatMap((owner) =>
        owner.shots.map((shot) => imageKey(project.id, owner, shot)),
      ),
    );
    const images = tx.objectStore("shotImages");
    for (const image of await images.index("by-project").getAll(project.id)) {
      if (!referenced.has(image.key)) await images.delete(image.key);
    }
    if (previousProject) {
      const kept = localAssetIds(project);
      for (const id of localAssetIds(previousProject))
        if (!kept.has(id)) await this.removeUnreferencedAsset(tx, id);
    }
  }

  private async removeUnreferencedAsset(tx: ProjectTransaction, id: string): Promise<void> {
    // The transaction includes all project writers: concurrent duplicate/delete
    // operations cannot delete a Blob referenced by another project.
    const projects = await tx.objectStore("projects").getAll();
    if (!projects.some((project) => localAssetIds(validateProject(project)).has(id)))
      await tx.objectStore("sceneAssets").delete(id);
  }

  private async removeProject(tx: ProjectTransaction, id: string): Promise<void> {
    const previous = await tx.objectStore("projects").get(id);
    await tx.objectStore("projects").delete(id);
    const images = tx.objectStore("shotImages");
    for (const key of await images.index("by-project").getAllKeys(id)) await images.delete(key);
    if (previous)
      for (const asset of localAssetIds(validateProject(previous)))
        await this.removeUnreferencedAsset(tx, asset);
  }

  async list(): Promise<Project[]> {
    return this.transact(async (tx) => {
      const projects = await tx.objectStore("projects").index("by-updated").getAll();
      const hydrated: Project[] = [];
      for (const project of projects.reverse()) hydrated.push(await this.hydrate(tx, project));
      return hydrated;
    });
  }

  async get(id: string): Promise<Project | undefined> {
    return this.transact(async (tx) => {
      const project = await tx.objectStore("projects").get(id);
      return project === undefined ? undefined : this.hydrate(tx, project);
    });
  }

  put(project: Project): Promise<void> {
    return this.putOwned(project);
  }

  async putOwned(project: Project, ownerUid?: string): Promise<void> {
    const snapshot = structuredClone(validateProject(project));
    await this.transact(async (tx) => {
      await this.writeOwnedProject(tx, snapshot, ownerUid);
    });
  }

  private async writeOwnedProject(
    tx: ProjectTransaction,
    snapshot: Project,
    ownerUid?: string,
  ): Promise<void> {
    const metas = tx.objectStore("syncMeta");
    const existing = await metas.get(snapshot.id);
    const existed = await tx.objectStore("projects").getKey(snapshot.id);
    if (
      existed === undefined &&
      snapshot.tutorial !== true &&
      (await tx.objectStore("projects").getAll()).filter((p) => p.tutorial !== true).length >=
        this.projectLimit()
    ) {
      throw new Error(
        "Your free project is already saved. Unlock Oculo Pro for additional projects, or return to your library and delete a project to free the slot.",
      );
    }
    // Signing in never implicitly claims a retained project merely because it was edited.
    const owner =
      existing?.ownerUid ??
      (existed === undefined && existing === undefined ? ownerUid : undefined);
    await this.writeProject(tx, snapshot);
    await metas.put({
      ...existing,
      id: snapshot.id,
      dirty: true,
      deleted: false,
      revision: (existing?.revision ?? 0) + 1,
      ...(owner === undefined ? {} : { ownerUid: owner }),
    });
  }

  /** Commits imported bytes and the project (new or gaining a scene) together, or neither. */
  async putImportedProject(
    project: Project,
    asset: StoredSceneAsset,
    signal?: AbortSignal,
    ownerUid?: string,
  ): Promise<void> {
    const snapshot = structuredClone(validateProject(project));
    const owner = snapshot.scenes.find((s) => s.scene.localAsset?.id === asset.id);
    const descriptor = owner?.scene.localAsset;
    if (
      !owner ||
      !descriptor ||
      owner.scene.source !== "imported" ||
      asset.id !== descriptor.id ||
      asset.descriptor.id !== descriptor.id ||
      asset.descriptor.version !== descriptor.version ||
      asset.descriptor.format !== descriptor.format ||
      asset.descriptor.filename !== descriptor.filename ||
      asset.descriptor.byteLength !== descriptor.byteLength ||
      asset.data.size !== descriptor.byteLength
    )
      throw new Error("Imported scene metadata does not match its file");
    // Blob contents are immutable; capture the caller's mutable wrapper before
    // the first await, just as putOwned captures project edits at call time.
    const stored = { id: asset.id, descriptor, data: asset.data };
    await verifyAssetBytes(owner.scene.asset, new Uint8Array(await stored.data.arrayBuffer()));
    await this.transact(async (tx) => {
      if (await tx.objectStore("sceneAssets").getKey(stored.id))
        throw new Error("This scene asset is already stored. Use a new asset ID.");
      await tx.objectStore("sceneAssets").put(stored);
      await this.writeOwnedProject(tx, snapshot, ownerUid);
    }, signal);
  }

  async getSceneAsset(id: string): Promise<Blob | undefined> {
    return (await (await this.database).get("sceneAssets", id))?.data;
  }

  /** Copies metadata and local shot frames while sharing immutable scene bytes. */
  async duplicateProject(
    id: string,
    newId: string,
    name: string,
    ownerUid?: string,
  ): Promise<Project> {
    if (!newId || !name.trim()) throw new Error("A copy needs a project ID and name");
    return this.transact(async (tx) => {
      const raw = await tx.objectStore("projects").get(id);
      if (!raw) throw new Error("The project to duplicate no longer exists");
      if (
        (await tx.objectStore("projects").getKey(newId)) ||
        (await tx.objectStore("syncMeta").getKey(newId))
      )
        throw new Error("The new project ID is already in use");
      const project = await this.hydrate(tx, raw);
      const { tutorial: _tutorial, ...rest } = project;
      void _tutorial;
      const now = Date.now();
      // A copy of the tutorial is ordinary work and counts toward the project limit.
      const copy: Project = {
        ...rest,
        id: newId,
        name: name.trim(),
        createdAt: now,
        updatedAt: now,
      };
      const sourceMeta = await tx.objectStore("syncMeta").get(id);
      await this.writeOwnedProject(tx, copy, sourceMeta?.ownerUid ?? ownerUid);
      return copy;
    });
  }

  async delete(id: string): Promise<void> {
    await this.transact(async (tx) => {
      const existing = await tx.objectStore("syncMeta").get(id);
      await this.removeProject(tx, id);
      // Keep a tombstone even when an initial upload is still in flight.
      await tx.objectStore("syncMeta").put({
        ...existing,
        id,
        dirty: true,
        deleted: true,
        revision: (existing?.revision ?? 0) + 1,
      });
    });
  }

  async listSyncSnapshots(): Promise<LocalProjectSnapshot[]> {
    return this.transact(async (tx) => {
      const projects = await tx.objectStore("projects").getAll();
      const metas = new Map(
        (await tx.objectStore("syncMeta").getAll()).map((meta) => [meta.id, meta]),
      );
      const result: LocalProjectSnapshot[] = [];
      for (const raw of projects) {
        const meta = metas.get(raw.id);
        result.push({
          id: raw.id,
          revision: meta?.revision ?? 0,
          project: await this.hydrate(tx, raw),
          ...(meta === undefined ? {} : { meta }),
        });
        metas.delete(raw.id);
      }
      for (const meta of metas.values())
        result.push({ id: meta.id, revision: meta.revision ?? 0, meta });
      return result;
    });
  }

  async commitSync(
    snapshot: LocalProjectSnapshot,
    change: SyncCommit,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.transact(async (tx) => {
      const metas = tx.objectStore("syncMeta");
      const current = await metas.get(snapshot.id);
      if (
        (current?.revision ?? 0) !== snapshot.revision ||
        (current?.ownerUid !== undefined && current.ownerUid !== change.ownerUid)
      )
        return false;
      if (change.kind !== "acknowledge" && current?.dirty === true) return false;
      if (change.kind === "remote") await this.writeProject(tx, validateProject(change.project));
      if (change.kind === "delete") await this.removeProject(tx, snapshot.id);
      await metas.put({
        ...current,
        id: snapshot.id,
        ownerUid: change.ownerUid,
        revision: snapshot.revision + 1,
        dirty: false,
        deleted:
          change.kind === "delete" || (change.kind === "acknowledge" && current?.deleted === true),
        lastSyncedAt: Date.now(),
      });
      return true;
    }, signal);
  }

  async adoptProject(
    id: string,
    ownerUid: string,
    signal: AbortSignal,
    includeLegacy = false,
  ): Promise<boolean> {
    return this.transact(async (tx) => {
      const metas = tx.objectStore("syncMeta");
      const existing = await metas.get(id);
      if (
        existing?.ownerUid !== undefined ||
        existing?.deleted === true ||
        (!includeLegacy && existing?.lastSyncedAt !== undefined) ||
        (await tx.objectStore("projects").getKey(id)) === undefined
      )
        return false;
      await metas.put({
        ...existing,
        id,
        ownerUid,
        dirty: true,
        deleted: false,
        revision: (existing?.revision ?? 0) + 1,
      });
      return true;
    }, signal);
  }

  /** Explicit recovery keeps the local snapshot before installing cloud metadata, in one transaction. */
  async forkConflict(
    snapshot: LocalProjectSnapshot,
    remote: Project,
    copy: Project,
    ownerUid: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const validatedRemote = structuredClone(validateProject(remote));
    const validatedCopy = structuredClone(validateProject(copy));
    if (validatedRemote.id !== snapshot.id || validatedCopy.id === snapshot.id)
      throw new Error("Invalid conflict recovery IDs");
    return this.transact(async (tx) => {
      const metas = tx.objectStore("syncMeta");
      const current = await metas.get(snapshot.id);
      if (
        current?.revision !== snapshot.revision ||
        current.ownerUid !== ownerUid ||
        current.deleted ||
        !current.dirty
      )
        return false;
      if (
        (await tx.objectStore("projects").getKey(validatedCopy.id)) !== undefined ||
        (await metas.getKey(validatedCopy.id)) !== undefined
      ) {
        throw new Error("The recovery copy ID is already in use. Try again.");
      }
      await this.writeProject(tx, validatedCopy);
      await metas.put({ id: validatedCopy.id, ownerUid, dirty: true, deleted: false, revision: 1 });
      await this.writeProject(tx, validatedRemote);
      await metas.put({
        ...current,
        revision: snapshot.revision + 1,
        dirty: false,
        deleted: false,
        lastSyncedAt: Date.now(),
      });
      return true;
    }, signal);
  }

  async getSyncMeta(id: string): Promise<ProjectSyncMeta | undefined> {
    return (await this.database).get("syncMeta", id);
  }
  async listSyncMeta(): Promise<ProjectSyncMeta[]> {
    return (await this.database).getAll("syncMeta");
  }
  async putSyncMeta(meta: ProjectSyncMeta): Promise<void> {
    await (await this.database).put("syncMeta", structuredClone(meta));
  }
  async deleteSyncMeta(id: string): Promise<void> {
    await (await this.database).delete("syncMeta", id);
  }

  async getPreferences(): Promise<AppPreferences> {
    const stored = await (await this.database).get("preferences", "app");
    return parseAppPreferences(stored?.data);
  }
  async putPreferences(preferences: AppPreferences): Promise<void> {
    const data = structuredClone(AppPreferencesSchema.parse(preferences));
    await (await this.database).put("preferences", { key: "app", data });
  }
  async listCameraPresets(): Promise<CameraPreset[]> {
    const rows = await (await this.database).getAllFromIndex("cameraPresets", "by-created");
    return rows.map((row) => parseCameraPreset(row));
  }
  async putCameraPreset(preset: CameraPreset): Promise<void> {
    const value = structuredClone(CameraPresetSchema.parse(preset));
    const tx = (await this.database).transaction("cameraPresets", "readwrite");
    const exists = await tx.store.getKey(value.id);
    if (exists === undefined && (await tx.store.count()) >= MAX_CAMERA_PRESETS)
      throw new Error(`You can keep up to ${MAX_CAMERA_PRESETS} camera presets. Delete one first.`);
    await tx.store.put(value);
    await tx.done;
  }
  async deleteCameraPreset(id: string): Promise<void> {
    await (await this.database).delete("cameraPresets", id);
  }
  async getGalleryAsset(versionId: string): Promise<GalleryAsset | undefined> {
    return (await this.database).get("galleryAssets", versionId);
  }
  async putGalleryAsset(asset: GalleryAsset): Promise<void> {
    await (await this.database).put("galleryAssets", asset);
  }
  async listGalleryAssets(): Promise<Omit<GalleryAsset, "data">[]> {
    const rows = await (await this.database).getAll("galleryAssets");
    return rows.map(({ versionId, sceneId, sha256, byteSize, savedAt }) => ({
      versionId,
      sceneId,
      sha256,
      byteSize,
      savedAt,
    }));
  }
  async deleteGalleryAsset(versionId: string): Promise<void> {
    await (await this.database).delete("galleryAssets", versionId);
  }
}
