import { applySceneWorkspace } from "@oculo/scene-schema";
import type { SceneWorkspace } from "../types/project";
import type { ProjectStore } from "./ProjectStore";

/** Persists one scene's editing view without touching the project's other scenes. */
export interface WorkspaceStore {
  put(workspace: SceneWorkspace): Promise<void>;
}

export function createWorkspaceStore(store: Pick<ProjectStore, "get" | "put">): WorkspaceStore {
  return {
    async put(workspace) {
      const project = await store.get(workspace.id);
      if (!project) throw new Error("This project was deleted. Return to your library.");
      await store.put(applySceneWorkspace(project, workspace));
    },
  };
}
