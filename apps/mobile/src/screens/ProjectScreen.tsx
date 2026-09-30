import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ChevronLeft,
  Camera,
  Copy,
  FileImage,
  MoreHorizontal,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useAppServices } from "../app/AppServices";
import { useNavigation } from "../navigation/Navigation";
import {
  duplicateScene,
  removeScene,
  renameProject,
  renameScene,
  summarizeProject,
} from "../services/projectFactory";
import type { Project, ProjectScene } from "../types/project";
import { formatRelativeTime, plural, Toggle } from "../ui/controls";
import { ActionSheet, ConfirmSheet, Sheet } from "../ui/Sheet";
import { useLongPress } from "../ui/useLongPress";
import { RenameSheet } from "./GalleryScreen";
import { useReveal } from "../ui/useReveal";
import { useScrollEdge } from "../ui/useScrollEdge";
import "./screens.css";

type ProjectSheet =
  | { kind: "rename-project" }
  | { kind: "settings" }
  | { kind: "export" }
  | { kind: "scene-menu"; scene: ProjectScene }
  | { kind: "rename-scene"; scene: ProjectScene }
  | { kind: "delete-scene"; scene: ProjectScene }
  | null;

export function ProjectScreen({ projectId }: { projectId: string }) {
  const services = useAppServices();
  const { store, refreshLibrary, syncState } = services;
  const navigation = useNavigation();
  const scrollEdge = useScrollEdge();
  const scenesRef = useRef<HTMLUListElement>(null);
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [sheet, setSheet] = useState<ProjectSheet>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useReveal(scenesRef, ":scope > li", project?.scenes.length ?? 0);

  const load = useCallback(async () => {
    try {
      setProject((await store.get(projectId)) ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The project could not be opened.");
    }
  }, [projectId, store]);

  // Reload whenever this screen becomes visible again (a scene edit may have changed it).
  useEffect(() => {
    void load();
  }, [load, services.projects]);

  const save = async (next: Project, fallback: string, close = true) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await store.put(next);
      setProject(next);
      if (close) setSheet(null);
      void refreshLibrary();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  if (project === undefined) return <div className="screen" aria-busy="true" />;
  if (project === null)
    return (
      <div className="screen">
        <header className="app-bar">
          <button
            className="icon-btn"
            aria-label="Back to projects"
            onClick={() => void navigation.pop()}
          >
            <ChevronLeft size={28} strokeWidth={2.2} />
          </button>
        </header>
        <div className="empty-state">
          <h2>Project not found</h2>
          <p>This project is no longer on this device.</p>
        </div>
      </div>
    );

  const summary = summarizeProject(project);
  const openScene = (scene: ProjectScene) =>
    navigation.push({ name: "scene", projectId: project.id, sceneId: scene.id, stage: "compose" });
  // The shot plan works from saved frames, so exporting never needs to load the 3D scene.
  const openShotPlan = (scene: ProjectScene) =>
    navigation.push({ name: "shotplan", projectId: project.id, sceneId: scene.id });

  return (
    <div className="screen project-screen">
      <header className="app-bar">
        <button
          className="icon-btn"
          aria-label="Back to projects"
          onClick={() => void navigation.pop()}
        >
          <ChevronLeft size={28} strokeWidth={2.2} />
        </button>
        <span className="app-bar__title">{project.name}</span>
        <button
          className="icon-btn"
          aria-label="Project settings"
          onClick={() => setSheet({ kind: "settings" })}
        >
          <SlidersHorizontal size={20} />
        </button>
      </header>

      <div className="screen-scroll">
        <div className="scroll-edge" ref={scrollEdge} aria-hidden="true" />
        <div>
          <button
            className="large-title large-title-button"
            aria-label={`Rename project ${project.name}`}
            onClick={() => setSheet({ kind: "rename-project" })}
          >
            {project.name}
          </button>
          <dl className="project-stats">
            <div>
              <dt>Scenes</dt>
              <dd>{summary.sceneCount}</dd>
            </div>
            <div>
              <dt>Shots</dt>
              <dd>{summary.shotCount}</dd>
            </div>
            <div>
              <dt>Moves</dt>
              <dd>{summary.moveSeconds ? `${summary.moveSeconds}s` : "—"}</dd>
            </div>
          </dl>
          <p className="meta">
            Edited {formatRelativeTime(project.updatedAt)} ·{" "}
            {summary.onDeviceOnly
              ? "Imported scenes stay on this device"
              : syncState?.status === "synced"
                ? "Backed up"
                : "Saved on this device"}
          </p>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}

          <div className="section-label">
            <h2 className="eyebrow">Scenes</h2>
          </div>
          <ul ref={scenesRef} className="card-grid scene-grid-cards">
            {project.scenes.map((scene, index) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                index={index}
                onOpen={() => openScene(scene)}
                onMenu={() => setSheet({ kind: "scene-menu", scene })}
              />
            ))}
          </ul>
        </div>
      </div>

      <nav className="bottom-bar" aria-label="Project actions">
        <button
          className="icon-btn icon-btn--filled"
          aria-label="Export shot plan"
          disabled={summary.shotCount === 0}
          onClick={() => {
            const withShots = project.scenes.filter((scene) => scene.shots.length > 0);
            if (withShots.length === 1) openShotPlan(withShots[0]!);
            else setSheet({ kind: "export" });
          }}
        >
          <FileImage size={20} />
        </button>
        <button
          className="btn btn--primary"
          onClick={() => navigation.push({ name: "scenes", projectId: project.id })}
        >
          <Plus size={20} /> New scene
        </button>
      </nav>

      {sheet?.kind === "export" && (
        <ActionSheet
          title="Export which scene?"
          onClose={() => setSheet(null)}
          actions={project.scenes
            .filter((scene) => scene.shots.length > 0)
            .map((scene) => ({
              label: `${scene.name} · ${plural(scene.shots.length, "shot")}`,
              icon: <FileImage size={18} />,
              onSelect: () => openShotPlan(scene),
            }))}
        />
      )}
      {sheet?.kind === "rename-project" && (
        <RenameSheet
          title="Rename project"
          initial={project.name}
          busy={busy}
          error={error}
          onClose={() => setSheet(null)}
          onSave={(name) =>
            void save(renameProject(project, name), "Project could not be renamed.")
          }
        />
      )}
      {sheet?.kind === "scene-menu" && (
        <ActionSheet
          title={sheet.scene.name}
          onClose={() => setSheet(null)}
          actions={[
            {
              label: "Rename scene",
              icon: <Pencil size={18} />,
              onSelect: () => setSheet({ kind: "rename-scene", scene: sheet.scene }),
            },
            {
              label: "Duplicate scene",
              icon: <Copy size={18} />,
              onSelect: () =>
                void save(
                  duplicateScene(project, sheet.scene.id),
                  "Scene could not be duplicated.",
                ),
            },
            {
              label: "Delete scene",
              icon: <Trash2 size={18} />,
              destructive: true,
              disabled: project.scenes.length <= 1,
              onSelect: () => setSheet({ kind: "delete-scene", scene: sheet.scene }),
            },
          ]}
        />
      )}
      {sheet?.kind === "rename-scene" && (
        <RenameSheet
          title="Rename scene"
          initial={sheet.scene.name}
          busy={busy}
          error={error}
          onClose={() => setSheet(null)}
          onSave={(name) =>
            void save(renameScene(project, sheet.scene.id, name), "Scene could not be renamed.")
          }
        />
      )}
      {sheet?.kind === "delete-scene" && (
        <ConfirmSheet
          title="Delete scene"
          message={`Delete “${sheet.scene.name}” and its ${plural(
            sheet.scene.shots.length,
            "shot",
          )}? This cannot be undone.`}
          confirmLabel="Delete scene"
          cancelLabel="Keep scene"
          busy={busy}
          error={error}
          onClose={() => setSheet(null)}
          onConfirm={() =>
            void save(removeScene(project, sheet.scene.id), "Scene could not be deleted.")
          }
        />
      )}
      {sheet?.kind === "settings" && (
        <Sheet title="Project settings" onClose={() => setSheet(null)}>
          <Toggle
            label="Composition grid"
            checked={project.settings.showGrid}
            onChange={(showGrid) =>
              void save(
                { ...project, settings: { ...project.settings, showGrid } },
                "Settings could not be saved.",
                false,
              )
            }
          />
          <Toggle
            label="Frame outline"
            checked={project.settings.showSafeFrame}
            onChange={(showSafeFrame) =>
              void save(
                { ...project, settings: { ...project.settings, showSafeFrame } },
                "Settings could not be saved.",
                false,
              )
            }
          />
          <div className="settings-meta">
            <span>Project ID</span>
            <code>{project.id.slice(0, 12)}</code>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function SceneCard({
  scene,
  index,
  onOpen,
  onMenu,
}: {
  scene: ProjectScene;
  index: number;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const thumbnail = scene.shots.find((shot) => shot.thumbnailDataUrl)?.thumbnailDataUrl;
  const longPress = useLongPress(onMenu);
  return (
    <li className="card" style={{ "--i": index } as CSSProperties}>
      <button
        className="card-button"
        aria-label={`Open scene ${scene.name}`}
        onClick={() => {
          if (!longPress.consumed()) onOpen();
        }}
        {...longPress.handlers}
      >
        <span className="card__thumb">
          {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : <Camera size={26} />}
        </span>
        <span className="card__badges">
          {scene.scene.localAsset && <span className="badge">On device</span>}
        </span>
        <span className="card__body">
          <span className="card__title">{scene.name}</span>
          <span className="meta">
            {plural(scene.shots.length, "shot")}
            {scene.shots.some((shot) => shot.keyframes.length > 1)
              ? ` · ${plural(scene.shots.filter((shot) => shot.keyframes.length > 1).length, "moving shot")}`
              : ""}
          </span>
        </span>
      </button>
      <button
        className="icon-btn icon-btn--overlay card__menu"
        aria-label={`More actions for scene ${scene.name}`}
        onClick={onMenu}
      >
        <MoreHorizontal size={18} />
      </button>
    </li>
  );
}
