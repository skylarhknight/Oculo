import { assertSameSceneBinding } from "@oculo/scene-schema";
import type { FirebaseApp } from "firebase/app";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  runTransaction,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
import type { Project } from "../types/project";
import { validateProject } from "./ProjectStore";
import { BUNDLED_DESCRIPTORS } from "../config/sceneCatalog";

/**
 * Oculo-owned cloud persistence contract. Firestore types never leave
 * this module; failures are mapped to Oculo error codes at the boundary.
 */

export type CloudSyncErrorCode = "network" | "permission" | "invalid-data" | "conflict" | "unknown";

export class CloudSyncError extends Error {
  constructor(
    readonly code: CloudSyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CloudSyncError";
  }
}

export interface CloudProjectRepository {
  list(uid: string): Promise<Project[]>;
  put(uid: string, project: Project): Promise<void>;
  delete(uid: string, projectId: string): Promise<void>;
  deleteAll(uid: string): Promise<void>;
}

const FIRESTORE_CODE_MAP: Record<string, CloudSyncErrorCode> = {
  unavailable: "network",
  "deadline-exceeded": "network",
  "permission-denied": "permission",
  unauthenticated: "permission",
  "invalid-argument": "invalid-data",
};

function mapCloudError(reason: unknown): CloudSyncError {
  if (reason instanceof CloudSyncError) return reason;
  const raw =
    typeof reason === "object" && reason !== null && "code" in reason
      ? String((reason as { code: unknown }).code)
      : "";
  const code = FIRESTORE_CODE_MAP[raw] ?? "unknown";
  const message = reason instanceof Error ? reason.message : "Cloud sync failed";
  return new CloudSyncError(code, message);
}

/**
 * Firestore documents may not exceed roughly 1 MiB. Shot thumbnails are
 * embedded data URLs, so oversized projects upload without thumbnails rather
 * than failing outright.
 */
const MAX_DOCUMENT_BYTES = 900_000;

export function sanitizeProjectForCloud(project: Project): Project {
  // Whitelist validated project fields; local media keys/ownership never leave the device.
  const clean = JSON.parse(JSON.stringify(validateProject(project))) as Project;
  for (const owner of clean.scenes) {
    const bundled = BUNDLED_DESCRIPTORS.find(
      (descriptor) =>
        descriptor.id === owner.scene.id &&
        descriptor.asset.versionId === owner.scene.asset.versionId &&
        JSON.stringify(descriptor.asset) === JSON.stringify(owner.scene.asset),
    );
    if (owner.scene.localAsset || (owner.scene.asset.locator.kind !== "remote" && !bundled))
      throw new CloudSyncError(
        "invalid-data",
        "This scene has a device-local asset reference and cannot be backed up yet.",
      );
    if (
      owner.scene.asset.locator.kind === "remote" &&
      !/^https:\/\//i.test(owner.scene.asset.locator.url)
    )
      throw new CloudSyncError("invalid-data", "Cloud scene references must use HTTPS.");
    delete owner.scene.legacyMetadata;
    owner.shots = owner.shots.map((shot) => {
      if (
        shot.thumbnailDataUrl === undefined ||
        /^data:image\/(jpeg|png|webp);base64,/i.test(shot.thumbnailDataUrl)
      )
        return shot;
      const copy = { ...shot };
      delete copy.thumbnailDataUrl;
      return copy;
    });
  }
  const byteSize = (value: Project) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (byteSize(clean) <= MAX_DOCUMENT_BYTES) return clean;
  const metadata: Project = {
    ...clean,
    scenes: clean.scenes.map((owner) => ({
      ...owner,
      shots: owner.shots.map((shot) => {
        const rest = { ...shot };
        delete rest.thumbnailDataUrl;
        return rest;
      }),
    })),
  };
  if (byteSize(metadata) > MAX_DOCUMENT_BYTES) {
    throw new CloudSyncError(
      "invalid-data",
      "Project metadata is too large to back up. The complete project remains on this device.",
    );
  }
  return metadata;
}

export class FirestoreProjectRepository implements CloudProjectRepository {
  private readonly db: Firestore;

  constructor(app: FirebaseApp) {
    this.db = getFirestore(app);
  }

  private projectsCollection(uid: string) {
    return collection(this.db, "users", uid, "projects");
  }

  async list(uid: string): Promise<Project[]> {
    try {
      const snapshot = await getDocs(this.projectsCollection(uid));
      const projects: Project[] = [];
      for (const document of snapshot.docs) {
        try {
          const project = validateProject(document.data());
          if (project.id !== document.id) throw new Error("Project ID does not match its document");
          projects.push(project);
        } catch {
          throw new CloudSyncError(
            "invalid-data",
            "A cloud project is invalid or requires a newer app version. No projects were removed.",
          );
        }
      }
      return projects;
    } catch (reason) {
      throw mapCloudError(reason);
    }
  }

  async put(uid: string, project: Project): Promise<void> {
    try {
      const payload = sanitizeProjectForCloud(validateProject(project));
      const reference = doc(this.projectsCollection(uid), project.id);
      await runTransaction(this.db, async (transaction) => {
        const remote = await transaction.get(reference);
        if (remote.exists()) {
          let current: Project;
          try {
            current = validateProject(remote.data());
          } catch {
            throw new CloudSyncError(
              "invalid-data",
              "A cloud project requires a newer app version or is invalid. Local edits are retained.",
            );
          }
          if (current.id !== project.id) {
            throw new CloudSyncError(
              "invalid-data",
              "A cloud project ID does not match its document. Local edits are retained.",
            );
          }
          for (const owner of payload.scenes) {
            const before = current.scenes.find((s) => s.id === owner.id);
            if (before) assertSameSceneBinding(before.scene, owner.scene);
          }
          if (current.updatedAt > payload.updatedAt) {
            throw new CloudSyncError(
              "conflict",
              "A newer cloud version conflicts with local edits. Local work is retained.",
            );
          }
        }
        transaction.set(reference, payload);
      });
    } catch (reason) {
      throw mapCloudError(reason);
    }
  }

  async delete(uid: string, projectId: string): Promise<void> {
    try {
      await deleteDoc(doc(this.projectsCollection(uid), projectId));
    } catch (reason) {
      throw mapCloudError(reason);
    }
  }

  async deleteAll(uid: string): Promise<void> {
    try {
      const snapshot = await getDocs(this.projectsCollection(uid));
      if (snapshot.empty) return;
      for (let offset = 0; offset < snapshot.docs.length; offset += 400) {
        const batch = writeBatch(this.db);
        for (const document of snapshot.docs.slice(offset, offset + 400))
          batch.delete(document.ref);
        await batch.commit();
      }
    } catch (reason) {
      throw mapCloudError(reason);
    }
  }
}
