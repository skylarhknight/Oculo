import { useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { lensLabel } from "@oculo/camera-core";
import { aspectLabel } from "../../services/cameraState";
import type { Shot } from "../../types/project";
import { shotKindLabel } from "./workspaceShared";
import { Sheet } from "../../ui/Sheet";

export function ShotEditSheet({
  shot,
  onSave,
  onDelete,
  onDuplicate,
  onClose,
}: {
  shot: Shot;
  onSave: (patch: { name: string; notes: string }) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(shot.name);
  const [notes, setNotes] = useState(shot.notes ?? "");
  const savedAt = new Date(shot.createdAt);
  return (
    <Sheet
      title="Edit shot"
      onClose={onClose}
      footer={
        <button
          className="btn btn--primary btn--block"
          onClick={() => onSave({ name: name.trim() || shot.name, notes: notes.trim() })}
        >
          Save changes
        </button>
      }
    >
      {shot.thumbnailDataUrl && (
        <img
          className="shot-edit-preview"
          src={shot.thumbnailDataUrl}
          alt={`Preview of ${shot.name}`}
        />
      )}
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        <span>Notes</span>
        <textarea
          value={notes}
          rows={3}
          maxLength={10000}
          placeholder="Blocking, intent, lens notes…"
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <p className="meta">
        {shotKindLabel(shot)} · {lensLabel(shot.setup.lens)} ·{" "}
        {aspectLabel(shot.setup.output.aspectRatio)} · {savedAt.toLocaleDateString()}{" "}
        {savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </p>
      <div className="action-list">
        <button className="action-row" onClick={onDuplicate}>
          <Copy size={18} /> Duplicate shot
        </button>
        <button className="action-row is-destructive" onClick={onDelete}>
          <Trash2 size={18} /> Delete shot
        </button>
      </div>
    </Sheet>
  );
}
