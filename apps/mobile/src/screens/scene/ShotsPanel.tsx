import type { CSSProperties } from "react";
import { Camera, ChevronDown, ChevronUp, LayoutGrid, List, Move3d, Pencil } from "lucide-react";
import { lensLabel } from "@oculo/camera-core";
import type { SceneWorkspace, Shot } from "../../types/project";
import { Segmented } from "../../ui/controls";
import { aspectLabel } from "../../services/cameraState";
import { shotKindLabel } from "./workspaceShared";

interface ShotsPanelProps {
  project: SceneWorkspace;
  disabled: boolean;
  view: "storyboard" | "list";
  onViewChange: (view: "storyboard" | "list") => void;
  /** Opens the shot in the editor. */
  onOpen: (shot: Shot) => void;
  onEdit: (shotId: string) => void;
  onReorder: (shotId: string, direction: -1 | 1) => void;
  onIncludedChange: (shotId: string, included: boolean) => void;
  onCompose: () => void;
  /** The shot being pointed at or focused, so the overview can lift its pin. */
  onHighlight?: (shotId: string | null) => void;
}

/** Build and refine the shot plan: order, annotations, and what goes into the export. */
export function ShotsPanel({
  project,
  disabled,
  view,
  onViewChange,
  onOpen,
  onEdit,
  onReorder,
  onIncludedChange,
  onCompose,
  onHighlight,
}: ShotsPanelProps) {
  if (project.shots.length === 0)
    return (
      <div className="empty-state compact-empty">
        <Camera size={26} />
        <p>No shots yet. Frame a view in Compose and tap New shot.</p>
        <button className="btn btn--primary" onClick={onCompose}>
          Start composing
        </button>
      </div>
    );
  const excluded = new Set(project.shotSheet?.excludedShotIds ?? []);
  return (
    <div className="shots-panel">
      <div className="shots-toolbar">
        <span className="meta">
          {project.shots.length - excluded.size} of {project.shots.length} in export
        </span>
        <Segmented
          label="Shot view"
          value={view}
          onChange={onViewChange}
          options={[
            { value: "storyboard", label: "Storyboard", icon: <LayoutGrid size={14} /> },
            { value: "list", label: "List", icon: <List size={14} /> },
          ]}
        />
      </div>
      <ol className={`shot-collection is-${view}`}>
        {project.shots.map((shot, index) => {
          const included = !excluded.has(shot.id);
          return (
            <li
              key={shot.id}
              className={`shot-item${included ? "" : " is-excluded"}`}
              style={{ "--i": index } as CSSProperties}
              onPointerEnter={() => onHighlight?.(shot.id)}
              onPointerLeave={() => onHighlight?.(null)}
              onFocus={() => onHighlight?.(shot.id)}
              onBlur={() => onHighlight?.(null)}
            >
              <button
                className="shot-item__frame"
                aria-label={`Open ${shot.name}`}
                disabled={disabled}
                onClick={() => onOpen(shot)}
                style={{ aspectRatio: String(shot.setup.output.aspectRatio) }}
              >
                {shot.thumbnailDataUrl ? (
                  <img src={shot.thumbnailDataUrl} alt="" draggable={false} />
                ) : (
                  <Camera size={20} />
                )}
                <i className="shot-item__number">{index + 1}</i>
                {shot.keyframes.length > 1 && (
                  <i className="shot-item__moving" aria-hidden="true">
                    <Move3d size={12} />
                  </i>
                )}
              </button>
              <div className="shot-item__meta">
                <strong>{shot.name}</strong>
                <small>{shotKindLabel(shot)}</small>
                <small>
                  {lensLabel(shot.setup.lens)} · {aspectLabel(shot.setup.output.aspectRatio)}
                </small>
                {shot.notes && view === "list" && <p className="shot-item__notes">{shot.notes}</p>}
              </div>
              <div className="shot-item__actions">
                <label className="include-toggle">
                  <input
                    type="checkbox"
                    checked={included}
                    aria-label={`Include ${shot.name} in export`}
                    onChange={(event) => onIncludedChange(shot.id, event.target.checked)}
                  />
                </label>
                {view === "list" && (
                  <>
                    <button
                      className="icon-btn"
                      aria-label={`Move ${shot.name} earlier`}
                      disabled={index === 0}
                      onClick={() => onReorder(shot.id, -1)}
                    >
                      <ChevronUp size={18} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`Move ${shot.name} later`}
                      disabled={index === project.shots.length - 1}
                      onClick={() => onReorder(shot.id, 1)}
                    >
                      <ChevronDown size={18} />
                    </button>
                  </>
                )}
                <button
                  className="icon-btn"
                  aria-label={`Edit ${shot.name}`}
                  onClick={() => onEdit(shot.id)}
                >
                  <Pencil size={16} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
