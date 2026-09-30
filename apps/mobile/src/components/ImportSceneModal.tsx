import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ModalDialog } from "./ModalDialog";
import {
  prepareSceneImport,
  type PreparedSceneImport,
  type SceneOrientation,
} from "../services/sceneImport";
import "../sceneImport.css";

interface ImportSceneModalProps {
  onClose: () => void;
  /** Resolve only after the project and scene bytes are durably committed. */
  onImport: (prepared: PreparedSceneImport, signal: AbortSignal) => Promise<void>;
}

export function ImportSceneModal({ onClose, onImport }: ImportSceneModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [file, setFile] = useState<File>();
  const [name, setName] = useState("");
  const [orientation, setOrientation] = useState<SceneOrientation>("original");
  const [origin, setOrigin] = useState<"captured" | "generated" | "unknown">("unknown");
  const [sourceApp, setSourceApp] = useState("");
  const [attribution, setAttribution] = useState("");
  const [busy, setBusy] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const operation = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    setStatus("Checking scene…");
    setFraction(0);
    try {
      const prepared = await prepareSceneImport(file, {
        name,
        orientation,
        provenance: { kind: origin, sourceApp, attribution },
        signal: controller.signal,
        onProgress: (progress) => {
          if (!mounted.current || controller.signal.aborted) return;
          setFraction(progress.fraction * 0.9);
          setStatus(
            progress.phase === "ready" ? "Saving scene on this device…" : "Checking scene…",
          );
        },
      });
      await onImport(prepared, controller.signal);
      if (mounted.current) onClose();
    } catch (cause) {
      if (!mounted.current) return;
      if (controller.signal.aborted) setStatus("Import canceled. No scene was added.");
      else {
        setStatus("");
        setError(
          cause instanceof Error ? cause.message : "The scene could not be imported. Try again.",
        );
      }
    } finally {
      operation.current = undefined;
      if (mounted.current) setBusy(false);
    }
  }

  function close() {
    if (operation.current) {
      operation.current.abort();
      setStatus("Canceling import…");
    } else onClose();
  }

  return (
    <ModalDialog
      labelledBy={titleId}
      describedBy={descriptionId}
      onClose={close}
      className="modal import-scene-modal"
    >
      <div className="modal-header">
        <h2 id={titleId}>Import a location</h2>
        <button
          className="icon-button"
          type="button"
          aria-label={busy ? "Cancel scene import" : "Close import"}
          onClick={close}
        >
          ×
        </button>
      </div>
      <p id={descriptionId}>
        Open your own Gaussian splat scene. Files stay on this device and can reopen offline.
      </p>
      <form
        className="import-scene-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          Scene file
          <input
            type="file"
            accept=".spz"
            disabled={busy}
            required
            onChange={(event) => {
              const selected = event.target.files?.[0];
              setFile(selected);
              setName(selected?.name.replace(/\.spz$/i, "") ?? "");
              setError("");
              setStatus("");
            }}
          />
        </label>
        <p className="import-scene-hint">SPZ version 2 or 3 · Up to 64 MB and 1 million splats</p>
        <label>
          Location name
          <input
            type="text"
            value={name}
            maxLength={100}
            required
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Orientation
          <select
            value={orientation}
            disabled={busy}
            onChange={(event) => setOrientation(event.target.value as SceneOrientation)}
          >
            <option value="original">As exported</option>
            <option value="flip-y">Flip upright (180°)</option>
            <option value="rotate-left">Turn left (90°)</option>
            <option value="rotate-right">Turn right (90°)</option>
          </select>
        </label>
        <label>
          Scene origin
          <select
            value={origin}
            disabled={busy}
            onChange={(event) => setOrigin(event.target.value as typeof origin)}
          >
            <option value="unknown">Unknown</option>
            <option value="captured">Captured</option>
            <option value="generated">Generated</option>
          </select>
        </label>
        <label>
          Source app or provider (optional)
          <input
            value={sourceApp}
            maxLength={150}
            disabled={busy}
            onChange={(event) => setSourceApp(event.target.value)}
          />
        </label>
        <label>
          Attribution (optional)
          <input
            value={attribution}
            maxLength={500}
            disabled={busy}
            onChange={(event) => setAttribution(event.target.value)}
          />
        </label>
        <p className="import-scene-hint">
          Physical scale is unknown for this file. Generated scenes are visual references, not
          verified real locations.
        </p>
        {busy && <progress aria-label="Scene import progress" max={1} value={fraction} />}
        {status && <p role="status">{status}</p>}
        {error && (
          <p className="import-scene-error" role="alert">
            {error}
          </p>
        )}
        <div className="import-scene-actions">
          <button className="secondary-button" type="button" onClick={close}>
            {busy ? "Cancel import" : "Cancel"}
          </button>
          <button className="primary-button" type="submit" disabled={busy || !file || !name.trim()}>
            {busy ? "Importing…" : "Import location"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
