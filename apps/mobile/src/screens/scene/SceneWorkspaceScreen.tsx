import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { sceneWorkspace } from "@oculo/scene-schema";
import { useAppServices } from "../../app/AppServices";
import { catalogDescriptor } from "../../config/sceneCatalog";
import { useNavigation } from "../../navigation/Navigation";
import type { SceneStage } from "../../navigation/routes";
import type { SceneWorkspace } from "../../types/project";
import { SceneWorkspaceView } from "./SceneWorkspaceView";

/** Loads one scene of a project as an editing workspace. */
export function useWorkspace(projectId: string, sceneId: string) {
  const { store } = useAppServices();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "missing"; message: string }
    | { status: "ready"; workspace: SceneWorkspace }
  >({ status: "loading" });
  useEffect(() => {
    let active = true;
    void store
      .get(projectId)
      .then((project) => {
        if (!active) return;
        if (!project) {
          setState({ status: "missing", message: "This project is no longer on this device." });
          return;
        }
        if (!project.scenes.some((scene) => scene.id === sceneId)) {
          setState({ status: "missing", message: "This scene was removed from the project." });
          return;
        }
        const workspace = sceneWorkspace(project, sceneId);
        // Gallery and starter scenes pick up the current app build's descriptor (new asset URLs, poses).
        const current = catalogDescriptor(workspace.scene.id);
        setState({
          status: "ready",
          workspace: current === undefined ? workspace : { ...workspace, scene: current },
        });
      })
      .catch((reason: unknown) => {
        if (active)
          setState({
            status: "missing",
            message: reason instanceof Error ? reason.message : "The scene could not be opened.",
          });
      });
    return () => {
      active = false;
    };
  }, [projectId, sceneId, store]);
  return state;
}

export function WorkspaceFallback({ message }: { message?: string }) {
  const navigation = useNavigation();
  return (
    <div
      className="screen workspace-fallback"
      data-appearance="dark"
      aria-busy={message === undefined}
    >
      <header className="app-bar">
        <button className="icon-btn" aria-label="Back" onClick={() => void navigation.pop()}>
          <ChevronLeft size={28} strokeWidth={2.2} />
        </button>
      </header>
      {message ? (
        <div className="empty-state" role="alert">
          <h2>Scene unavailable</h2>
          <p>{message}</p>
        </div>
      ) : (
        <div className="scene-status">
          <span className="loader" /> Opening scene
        </div>
      )}
    </div>
  );
}

export function SceneWorkspaceScreen({
  projectId,
  sceneId,
  stage,
  shotId,
}: {
  projectId: string;
  sceneId: string;
  stage: SceneStage;
  shotId?: string;
}) {
  const state = useWorkspace(projectId, sceneId);
  if (state.status === "loading") return <WorkspaceFallback />;
  if (state.status === "missing") return <WorkspaceFallback message={state.message} />;
  return (
    <SceneWorkspaceView
      key={`${projectId}:${sceneId}`}
      initial={state.workspace}
      stage={stage}
      {...(shotId ? { initialShotId: shotId } : {})}
    />
  );
}
