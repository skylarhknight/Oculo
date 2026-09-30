import { allProjectShots } from "@oculo/scene-schema";
import type { Project } from "../types/project";
import { CloudSyncError, type CloudProjectRepository } from "./CloudProjectRepository";
import {
  validateProject,
  type LocalProjectSnapshot,
  type LocalProjectStore,
  type ProjectStore,
} from "./ProjectStore";

export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "error";
export interface SyncState {
  status: SyncStatus;
  pendingCount: number;
  error?: string;
}
export interface BackupProjectCandidate {
  projectId: string;
  name: string;
  shotCount: number;
  missingImageCount: number;
  legacyOwnershipUnknown: boolean;
}
export interface SyncConflict {
  projectId: string;
  localName: string;
  remoteName: string;
}
interface SyncSession {
  uid: string;
  controller: AbortController;
  epoch: number;
}

/** Local writes commit independently of network work; remote effects use revision-checked transactions. */
export class SyncedProjectStore implements ProjectStore {
  private session: SyncSession | undefined;
  private epoch = 0;
  private state: SyncState = { status: "idle", pendingCount: 0 };
  private readonly listeners = new Set<(state: SyncState) => void>();
  private online: boolean;
  private queue: Promise<void> = Promise.resolve();
  private pendingDeletionUid: string | undefined;

  constructor(
    private readonly local: LocalProjectStore,
    private readonly cloud: CloudProjectRepository,
  ) {
    this.online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this.online = true;
        if (this.session) void this.syncNow().catch(() => undefined);
      });
      window.addEventListener("offline", () => {
        this.online = false;
        void this.refreshState("offline");
      });
      window.addEventListener("focus", () => {
        if (this.session) void this.syncNow().catch(() => undefined);
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this.session)
          void this.syncNow().catch(() => undefined);
      });
    }
  }

  getSyncState(): SyncState {
    return this.state;
  }
  subscribeSyncState(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Existing ownership resumes automatically; adopting local work requires explicit consent. */
  setUser(uid: string | null, options: { adoptLocalProjects?: boolean } = {}): void {
    // Reauthentication can notify the same signed-in user while deletion is
    // quiesced. Do not restart uploads before deletion/retry has completed.
    if (uid !== null && uid === this.pendingDeletionUid) return;
    if (uid !== null) this.pendingDeletionUid = undefined;
    if (this.session?.uid === uid) return;
    this.session?.controller.abort();
    this.epoch += 1;
    this.session =
      uid === null ? undefined : { uid, controller: new AbortController(), epoch: this.epoch };
    if (!this.session) {
      void this.refreshState("idle");
      return;
    }
    if (options.adoptLocalProjects) {
      void this.adoptLocalProjects().catch(() => undefined);
    } else {
      void this.syncNow().catch(() => undefined);
    }
  }

  /** Sign-out invalidates stale responses but retains ownership, dirty edits, images and tombstones. */
  async clearSyncState(): Promise<void> {
    this.setUser(null);
    this.pendingDeletionUid = undefined;
    await this.queue;
    await this.refreshState("idle");
  }

  async listAdoptableProjects(): Promise<Project[]> {
    return (await this.local.listSyncSnapshots())
      .filter(
        (snapshot) =>
          snapshot.project !== undefined &&
          !snapshot.project.scenes.some((s) => s.scene.localAsset) &&
          snapshot.meta?.ownerUid === undefined &&
          snapshot.meta?.lastSyncedAt === undefined &&
          snapshot.meta?.deleted !== true,
      )
      .map((snapshot) => snapshot.project!);
  }

  /** Only unowned projects are offered; legacy ownership is disclosed for explicit selection. */
  async listBackupCandidates(): Promise<BackupProjectCandidate[]> {
    return (await this.local.listSyncSnapshots())
      .filter(
        (snapshot) =>
          snapshot.project !== undefined &&
          !snapshot.project.scenes.some((s) => s.scene.localAsset) &&
          snapshot.meta?.ownerUid === undefined &&
          snapshot.meta?.deleted !== true,
      )
      .map((snapshot) => ({
        projectId: snapshot.id,
        name: snapshot.project!.name,
        shotCount: allProjectShots(snapshot.project!).length,
        missingImageCount: allProjectShots(snapshot.project!).filter(
          (shot) => shot.thumbnailDataUrl === undefined,
        ).length,
        legacyOwnershipUnknown: snapshot.meta?.lastSyncedAt !== undefined,
      }));
  }

  async listConflicts(): Promise<SyncConflict[]> {
    const session = this.session;
    if (!session) return [];
    const snapshots = await this.local.listSyncSnapshots();
    if (!this.isCurrent(session)) return [];
    const remote = (await this.cloud.list(session.uid)).map((project) => validateProject(project));
    if (!this.isCurrent(session)) return [];
    const byId = new Map(remote.map((project) => [project.id, project]));
    return snapshots.flatMap((snapshot) => {
      const cloudProject = byId.get(snapshot.id);
      return snapshot.meta?.ownerUid === session.uid &&
        snapshot.meta.dirty &&
        snapshot.project &&
        cloudProject &&
        cloudProject.updatedAt > snapshot.project.updatedAt
        ? [
            {
              projectId: snapshot.id,
              localName: snapshot.project.name,
              remoteName: cloudProject.name,
            },
          ]
        : [];
    });
  }

  /** Keeps local edits in a new project before accepting the cloud version; never overwrites cloud work. */
  async recoverConflict(projectId: string): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("Sign in before keeping both project versions");
    const snapshot = (await this.local.listSyncSnapshots()).find((entry) => entry.id === projectId);
    if (!snapshot?.project || snapshot.meta?.ownerUid !== session.uid || !snapshot.meta.dirty) {
      throw new Error(
        "This project no longer has unresolved local changes. Refresh the project list.",
      );
    }
    if (!this.isCurrent(session)) throw new Error("The account changed. Reopen the account panel.");
    const remote = (await this.cloud.list(session.uid))
      .map((value) => validateProject(value))
      .find((entry) => entry.id === projectId);
    if (!remote || remote.updatedAt <= snapshot.project.updatedAt) {
      throw new Error("The cloud version changed. Retry sync before choosing a recovery action.");
    }
    const copy = {
      ...structuredClone(snapshot.project),
      id: crypto.randomUUID(),
      name: `${snapshot.project.name} (local copy)`,
      updatedAt: Date.now(),
    };
    if (
      !(await this.local.forkConflict(
        snapshot,
        remote,
        copy,
        session.uid,
        session.controller.signal,
      ))
    ) {
      throw new Error(
        "The local project changed during recovery. Both existing versions are untouched; try again.",
      );
    }
    if (!this.isCurrent(session))
      throw new Error(
        "Both versions were kept on this device, but the account changed before backup.",
      );
    try {
      await this.syncNow();
    } catch (error) {
      throw new Error(
        `Both versions are kept on this device, but backup is incomplete: ${this.message(error)}`,
        { cause: error },
      );
    }
  }

  /** Explicit IDs can recover unknown legacy ownership; known ownership is never transferred. */
  async adoptLocalProjects(projectIds?: readonly string[]): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("Sign in before backing up local projects");
    try {
      const ids = projectIds ?? (await this.listAdoptableProjects()).map((project) => project.id);
      for (const id of ids) {
        if (!this.isCurrent(session)) return;
        const project = await this.local.get(id);
        if (project?.scenes.some((s) => s.scene.localAsset))
          throw new Error(
            "Imported scene projects stay on this device. Scene-file backup is not supported yet.",
          );
        await this.local.adoptProject(
          id,
          session.uid,
          session.controller.signal,
          projectIds !== undefined,
        );
      }
      if (this.isCurrent(session)) await this.syncNow();
    } catch (error) {
      if (this.isCurrent(session)) {
        await this.refreshState("error", this.message(error), session.epoch);
        throw error;
      }
    }
  }

  async deleteCloudData(): Promise<void> {
    const uid = this.session?.uid ?? this.pendingDeletionUid;
    if (!uid) return;
    // Finish any already-dispatched upload before deleting cloud data, so it cannot recreate a backup.
    this.setUser(null);
    this.pendingDeletionUid = uid;
    await this.queue;
    await this.cloud.deleteAll(uid);
  }

  list(): Promise<Project[]> {
    return this.local.list();
  }
  get(id: string): Promise<Project | undefined> {
    return this.local.get(id);
  }

  async put(project: Project): Promise<void> {
    const session = this.session;
    await this.local.putOwned(project, session?.uid);
    if (this.session) void this.flushDirty();
  }

  async delete(id: string): Promise<void> {
    await this.local.delete(id);
    if (this.session) void this.flushDirty();
  }

  async syncNow(): Promise<void> {
    const session = this.session;
    await this.enqueue((active) => this.runFullSync(active));
    if (session && this.isCurrent(session) && this.state.status === "error") {
      throw new Error(this.state.error ?? "Sync failed. Local work is retained.");
    }
  }
  flushDirty(): Promise<void> {
    return this.enqueue((session) => this.runFlushDirty(session));
  }

  private enqueue(operation: (session: SyncSession) => Promise<void>): Promise<void> {
    const session = this.session;
    if (!session) return Promise.resolve();
    this.queue = this.queue
      .then(async () => {
        if (!this.isCurrent(session)) return;
        if (!this.online) {
          await this.refreshState("offline", undefined, session.epoch);
          return;
        }
        await this.refreshState("syncing", undefined, session.epoch);
        try {
          await operation(session);
          if (this.isCurrent(session)) await this.refreshState("synced", undefined, session.epoch);
        } catch (error) {
          if (this.isCurrent(session))
            await this.refreshState("error", this.message(error), session.epoch);
        }
      })
      .catch(async (error: unknown) => {
        if (this.isCurrent(session))
          await this.refreshState("error", this.message(error), session.epoch);
      });
    return this.queue;
  }

  private async runFullSync(session: SyncSession): Promise<void> {
    // Take the local revision snapshot BEFORE the network read. A concurrent edit
    // then invalidates every attempted application of that remote response.
    const localSnapshots = await this.local.listSyncSnapshots();
    if (!this.isCurrent(session)) return;
    const response = await this.cloud.list(session.uid);
    if (!this.isCurrent(session)) return;
    // Validate the complete response before any mutation. An unreadable record
    // must never look like a remote deletion, even for alternative cloud adapters.
    const remoteProjects = response.map((value) => validateProject(value));
    if (new Set(remoteProjects.map(({ id }) => id)).size !== remoteProjects.length) {
      throw new CloudSyncError("invalid-data", "Cloud project IDs are duplicated");
    }
    const remoteById = new Map(remoteProjects.map((project) => [project.id, project]));
    const localById = new Map(localSnapshots.map((snapshot) => [snapshot.id, snapshot]));
    for (const remote of remoteProjects) {
      const snapshot = localById.get(remote.id) ?? { id: remote.id, revision: 0 };
      if (!this.isCurrent(session)) return;
      const owner = snapshot.meta?.ownerUid;
      if (owner !== undefined && owner !== session.uid) {
        throw new CloudSyncError(
          "conflict",
          "A cloud project ID belongs to another account on this device",
        );
      }
      if ((snapshot.project !== undefined || snapshot.meta !== undefined) && owner === undefined)
        continue;
      if (snapshot.meta?.deleted) {
        await this.pushDeletion(session, snapshot);
      } else if (snapshot.meta?.dirty && snapshot.project) {
        if (remote.updatedAt > snapshot.project.updatedAt) {
          throw new CloudSyncError(
            "conflict",
            "A newer cloud version conflicts with local edits. Local work is retained.",
          );
        }
        await this.pushProject(session, snapshot);
      } else if (!snapshot.project || remote.updatedAt > snapshot.project.updatedAt) {
        await this.local.commitSync(
          snapshot,
          { kind: "remote", project: remote, ownerUid: session.uid },
          session.controller.signal,
        );
      } else if (snapshot.project.updatedAt > remote.updatedAt) {
        await this.pushProject(session, snapshot);
      }
    }
    for (const snapshot of localSnapshots) {
      if (!this.isCurrent(session)) return;
      if (remoteById.has(snapshot.id) || snapshot.meta?.ownerUid !== session.uid) continue;
      if (snapshot.meta.deleted) {
        if (snapshot.meta.dirty) await this.pushDeletion(session, snapshot);
      } else if (snapshot.meta.dirty && snapshot.project) {
        await this.pushProject(session, snapshot);
      } else if (snapshot.project && snapshot.meta.lastSyncedAt !== undefined) {
        await this.local.commitSync(
          snapshot,
          { kind: "delete", ownerUid: session.uid },
          session.controller.signal,
        );
      }
    }
  }

  private async runFlushDirty(session: SyncSession): Promise<void> {
    for (const snapshot of await this.local.listSyncSnapshots()) {
      if (!this.isCurrent(session)) return;
      if (!snapshot.meta?.dirty || snapshot.meta.ownerUid !== session.uid) continue;
      if (snapshot.meta.deleted) await this.pushDeletion(session, snapshot);
      else if (snapshot.project) await this.pushProject(session, snapshot);
    }
  }

  private async pushProject(session: SyncSession, snapshot: LocalProjectSnapshot): Promise<void> {
    if (!snapshot.project || !this.isCurrent(session)) return;
    await this.cloud.put(session.uid, snapshot.project);
    if (!this.isCurrent(session)) return;
    await this.local.commitSync(
      snapshot,
      { kind: "acknowledge", ownerUid: session.uid },
      session.controller.signal,
    );
  }

  private async pushDeletion(session: SyncSession, snapshot: LocalProjectSnapshot): Promise<void> {
    if (!this.isCurrent(session)) return;
    await this.cloud.delete(session.uid, snapshot.id);
    if (!this.isCurrent(session)) return;
    await this.local.commitSync(
      snapshot,
      { kind: "acknowledge", ownerUid: session.uid },
      session.controller.signal,
    );
  }

  private isCurrent(session: SyncSession): boolean {
    return this.session === session && !session.controller.signal.aborted;
  }
  private message(error: unknown): string {
    return error instanceof Error ? error.message : "Sync failed";
  }

  private async refreshState(
    status: SyncStatus,
    error?: string,
    epoch = this.epoch,
  ): Promise<void> {
    const owner = this.session?.uid;
    let metas;
    try {
      metas = await this.local.listSyncMeta();
    } catch (reason) {
      if (epoch !== this.epoch) return;
      this.state = {
        status: "error",
        pendingCount: this.state.pendingCount,
        error: `Sync status is unavailable: ${this.message(reason)}`,
      };
      for (const listener of this.listeners) listener(this.state);
      return;
    }
    if (epoch !== this.epoch) return;
    const pendingCount =
      owner === undefined
        ? 0
        : metas.filter((meta) => meta.dirty && meta.ownerUid === owner).length;
    // A stale acknowledgement cannot advertise that newer queued edits are synced.
    const settledStatus = status === "synced" && pendingCount > 0 ? "idle" : status;
    this.state = { status: settledStatus, pendingCount, ...(error === undefined ? {} : { error }) };
    for (const listener of this.listeners) listener(this.state);
  }
}
