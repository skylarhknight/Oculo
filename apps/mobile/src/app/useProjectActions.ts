import { useCallback } from "react";
import type { SceneDescriptor } from "@oculo/scene-schema";
import { useNavigation } from "../navigation/Navigation";
import type { PreparedSceneImport } from "../services/sceneImport";
import { addScene, createProject, createProjectScene } from "../services/projectFactory";
import type { Project, ProjectScene } from "../types/project";
import { useAppServices } from "./AppServices";

/** A scene to start from: a gallery entry or a bundled starter. */
export interface SceneChoice {
  title: string;
  descriptor: SceneDescriptor;
}

/**
 * Creation flows shared by the scene gallery, gallery and project screens. Each lands in
 * the new scene; from the scene gallery, the gallery screen is replaced on the way.
 */
export function useProjectActions() {
  const { store, local, synced, refreshLibrary, canCreateProject, preferences } = useAppServices();
  const navigation = useNavigation();

  const openNewScene = useCallback(
    (project: Project, scene: ProjectScene, includeProject: boolean) => {
      const sceneRoute = {
        name: "scene",
        projectId: project.id,
        sceneId: scene.id,
        stage: "compose",
      } as const;
      const routes = includeProject
        ? [{ name: "project", projectId: project.id } as const, sceneRoute]
        : [sceneRoute];
      if (navigation.route.name === "scenes") void navigation.replace(routes);
      else navigation.push(routes);
    },
    [navigation],
  );

  const createFromDemo = useCallback(
    async (name: string, demo: SceneChoice) => {
      if (!(await canCreateProject())) return false;
      const scene = createProjectScene(demo.descriptor, {
        name: demo.title,
        defaults: preferences.camera,
      });
      const project = createProject(name || demo.title, scene);
      await store.put(project);
      void refreshLibrary();
      openNewScene(project, scene, true);
      return true;
    },
    [canCreateProject, openNewScene, preferences.camera, refreshLibrary, store],
  );

  const createFromImport = useCallback(
    async (name: string, prepared: PreparedSceneImport, signal: AbortSignal) => {
      const scene = createProjectScene(prepared.scene, { camera: prepared.camera });
      const project = createProject(name || prepared.scene.name, scene);
      await local.putImportedProject(project, prepared.asset, signal);
      void refreshLibrary();
      openNewScene(project, scene, true);
    },
    [local, openNewScene, refreshLibrary],
  );

  const addDemoScene = useCallback(
    async (projectId: string, demo: SceneChoice) => {
      const project = await store.get(projectId);
      if (!project) throw new Error("This project is no longer on this device.");
      const scene = createProjectScene(demo.descriptor, {
        name: demo.title,
        defaults: preferences.camera,
      });
      const next = addScene(project, scene);
      await store.put(next);
      void refreshLibrary();
      openNewScene(next, scene, false);
      return next;
    },
    [openNewScene, preferences.camera, refreshLibrary, store],
  );

  const addImportedScene = useCallback(
    async (projectId: string, prepared: PreparedSceneImport, signal: AbortSignal) => {
      const project = await store.get(projectId);
      if (!project) throw new Error("This project is no longer on this device.");
      const scene = createProjectScene(prepared.scene, { camera: prepared.camera });
      const next = addScene(project, scene);
      await local.putImportedProject(next, prepared.asset, signal);
      if (synced) void synced.flushDirty();
      void refreshLibrary();
      openNewScene(next, scene, false);
      return next;
    },
    [local, openNewScene, refreshLibrary, store, synced],
  );

  return { createFromDemo, createFromImport, addDemoScene, addImportedScene };
}
