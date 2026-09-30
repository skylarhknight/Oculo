import { useAppServices } from "../../app/AppServices";
import { ShotSheetWorkspace } from "../../components/ShotSheetWorkspace";
import { useNavigation } from "../../navigation/Navigation";
import { useWorkspace, WorkspaceFallback } from "./SceneWorkspaceScreen";

/** Full-screen shot plan editor, preview, and share flow for one scene. */
export function ShotPlanScreen({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  const state = useWorkspace(projectId, sceneId);
  const { workspaces, refreshLibrary } = useAppServices();
  const navigation = useNavigation();
  if (state.status === "loading") return <WorkspaceFallback />;
  if (state.status === "missing") return <WorkspaceFallback message={state.message} />;
  return (
    <ShotSheetWorkspace
      initialProject={state.workspace}
      store={workspaces}
      onChange={() => undefined}
      onClose={() => {
        void refreshLibrary();
        void navigation.pop();
      }}
      onRecapture={(_, shotId) =>
        navigation.push({ name: "scene", projectId, sceneId, stage: "compose", shotId })
      }
    />
  );
}
