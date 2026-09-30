import {
  DEFAULT_STATIC_SHOT_SECONDS,
  PROJECT_SCHEMA_VERSION,
  sceneReference,
  shotSetupFromCamera,
} from "@oculo/scene-schema";
import { keyframeFromRig } from "@oculo/camera-core";
import {
  cloneCamera,
  DEFAULT_CAMERA,
  type CinematicCamera,
  type Project,
  type ProjectScene,
  type SceneDescriptor,
  type Shot,
  type ShotLens,
} from "../types/project";

const makeId = () => crypto.randomUUID();

export const DEFAULT_PROJECT_NAME = "Untitled project";

export interface CameraDefaults {
  focalLengthMm: number;
  sensorWidthMm: number;
  sensorHeightMm: number;
  aspectRatio: number;
}

export function initialCameraForScene(
  scene: SceneDescriptor,
  defaults?: CameraDefaults,
): CinematicCamera {
  const camera = cloneCamera(DEFAULT_CAMERA);
  if (defaults) {
    camera.focalLengthMm = defaults.focalLengthMm;
    camera.sensorWidthMm = defaults.sensorWidthMm;
    camera.sensorHeightMm = defaults.sensorHeightMm;
    camera.output = { aspectRatio: defaults.aspectRatio, crop: "center-inside-sensor" };
  }
  if (scene.initialCameraPose) {
    camera.pose = {
      position: [...scene.initialCameraPose.position],
      quaternion: [...scene.initialCameraPose.quaternion],
    };
  }
  return camera;
}

export function createProjectScene(
  scene: SceneDescriptor,
  options: { name?: string; camera?: CinematicCamera; defaults?: CameraDefaults } = {},
): ProjectScene {
  const now = Date.now();
  return {
    id: makeId(),
    name: options.name?.trim() || scene.name,
    createdAt: now,
    updatedAt: now,
    scene,
    ...sceneReference(scene),
    camera: options.camera ?? initialCameraForScene(scene, options.defaults),
    shots: [],
  };
}

export function createProject(name: string, firstScene: ProjectScene): Project {
  const now = Date.now();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: makeId(),
    name: name.trim() || DEFAULT_PROJECT_NAME,
    createdAt: now,
    updatedAt: now,
    scenes: [firstScene],
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  };
}

export function addScene(project: Project, scene: ProjectScene): Project {
  return { ...project, updatedAt: Date.now(), scenes: [...project.scenes, scene] };
}

export function renameProject(project: Project, name: string): Project {
  const trimmed = name.trim();
  if (!trimmed || trimmed === project.name) return project;
  return { ...project, name: trimmed, updatedAt: Date.now() };
}

export function renameScene(project: Project, sceneId: string, name: string): Project {
  const trimmed = name.trim();
  if (!trimmed) return project;
  const now = Date.now();
  return {
    ...project,
    updatedAt: now,
    scenes: project.scenes.map((s) =>
      s.id === sceneId ? { ...s, name: trimmed, updatedAt: now } : s,
    ),
  };
}

/** A project always keeps at least one scene; delete the project instead. */
export function removeScene(project: Project, sceneId: string): Project {
  if (project.scenes.length <= 1) throw new Error("A project needs at least one scene.");
  const removed = project.scenes.find((s) => s.id === sceneId);
  if (!removed) return project;
  const removedShots = new Set(removed.shots.map((s) => s.id));
  return {
    ...project,
    updatedAt: Date.now(),
    scenes: project.scenes.filter((s) => s.id !== sceneId),
    ...(project.shotSheet
      ? {
          shotSheet: {
            ...project.shotSheet,
            excludedShotIds: project.shotSheet.excludedShotIds.filter(
              (id) => !removedShots.has(id),
            ),
          },
        }
      : {}),
  };
}

/** Copies a scene's shots with fresh IDs; the scene bytes are shared. */
export function duplicateScene(project: Project, sceneId: string): Project {
  const source = project.scenes.find((s) => s.id === sceneId);
  if (!source) return project;
  const now = Date.now();
  const copy: ProjectScene = {
    ...structuredClone(source),
    id: makeId(),
    name: `${source.name} (copy)`,
    createdAt: now,
    updatedAt: now,
    shots: source.shots.map((shot) => ({ ...structuredClone(shot), id: makeId() })),
  };
  const index = project.scenes.indexOf(source);
  const scenes = [...project.scenes];
  scenes.splice(index + 1, 0, copy);
  return { ...project, updatedAt: now, scenes };
}

export interface ProjectSummary {
  sceneCount: number;
  shotCount: number;
  moveSeconds: number;
  onDeviceOnly: boolean;
  thumbnail: string | undefined;
}

export function summarizeProject(project: Project): ProjectSummary {
  const shots = project.scenes.flatMap((s) => s.shots);
  return {
    sceneCount: project.scenes.length,
    shotCount: shots.length,
    moveSeconds: shots.reduce(
      (total, shot) => total + (shot.keyframes.length > 1 ? shot.durationSeconds : 0),
      0,
    ),
    onDeviceOnly: project.scenes.some((s) => s.scene.localAsset !== undefined),
    thumbnail: shots.find((shot) => shot.thumbnailDataUrl)?.thumbnailDataUrl,
  };
}

export type GallerySort = "recent" | "name" | "shots";

export function sortProjects(projects: readonly Project[], sort: GallerySort): Project[] {
  const tutorialFirst = (a: Project, b: Project) =>
    Number(b.tutorial === true) - Number(a.tutorial === true);
  const order: Record<GallerySort, (a: Project, b: Project) => number> = {
    recent: (a, b) => b.updatedAt - a.updatedAt,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    shots: (a, b) => summarizeProject(b).shotCount - summarizeProject(a).shotCount,
  };
  return [...projects].sort((a, b) => tutorialFirst(a, b) || order[sort](a, b));
}

export function searchProjects(projects: readonly Project[], query: string): Project[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...projects];
  return projects.filter((project) =>
    [project.name, ...project.scenes.map((s) => s.name), ...project.scenes.map((s) => s.scene.name)]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export interface NewShotOptions {
  name: string;
  lens: ShotLens;
  sensorWidthMm: number;
  sensorHeightMm: number;
  aspectRatio: number;
}

/** A static shot recording the rig as its first keyframe, within the chosen lens. */
export function createShot(
  scene: SceneDescriptor,
  rig: CinematicCamera,
  options: NewShotOptions,
  thumbnailDataUrl?: string,
): Shot {
  const setup = {
    ...shotSetupFromCamera(rig, options.lens),
    sensorWidthMm: options.sensorWidthMm,
    sensorHeightMm: options.sensorHeightMm,
    output: { aspectRatio: options.aspectRatio, crop: "center-inside-sensor" as const },
  };
  return {
    id: makeId(),
    ...sceneReference(scene),
    name: options.name.trim() || "Shot",
    createdAt: new Date().toISOString(),
    durationSeconds: DEFAULT_STATIC_SHOT_SECONDS,
    setup,
    keyframes: [keyframeFromRig({ setup }, makeId(), 0, rig)],
    ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
  };
}

export const newKeyframeId = makeId;
