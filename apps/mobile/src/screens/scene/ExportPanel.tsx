import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, FileImage, Film, Share2 } from "lucide-react";
import { cameraMetadataArtifact } from "../../services/cameraMetadataExport";
import { createSharingService, type PreparedShare } from "../../services/SharingService";
import type { SceneWorkspace } from "../../types/project";
import { MAX_SEQUENCE_DURATION_SECONDS } from "../../services/videoExport/timeline";
import { plural, Segmented } from "../../ui/controls";
import { formatSeconds } from "./workspaceShared";

type Output = "plan" | "video" | "data";

interface ExportPanelProps {
  project: SceneWorkspace;
  includedCount: number;
  sceneReady: boolean;
  busy: boolean;
  /** Commits pending edits and returns the saved workspace. */
  onFlush: () => Promise<SceneWorkspace>;
  onOpenShotPlan: () => void;
  /** Opens video export for one shot, or several stitched together in this order. */
  onOpenVideo: (shotIds: readonly string[]) => void;
  onShowShots: () => void;
  /** The shot open in the editor, preferred for the video preview. */
  activeShotId: string | null;
}

/** Choose an output, see what it contains, then share it. The shot plan is the default. */
export function ExportPanel({
  project,
  includedCount,
  sceneReady,
  busy,
  onFlush,
  onOpenShotPlan,
  onOpenVideo,
  onShowShots,
  activeShotId,
}: ExportPanelProps) {
  const [output, setOutput] = useState<Output>("plan");
  const [chosenShotId, setChosenShotId] = useState<string | null>(null);
  const [videoMode, setVideoMode] = useState<"shot" | "sequence">("shot");
  // Shots left out of the sequence; by default it follows the shot plan's selection.
  const [leftOut, setLeftOut] = useState<ReadonlySet<string> | null>(null);
  const excluded = leftOut ?? new Set(project.shotSheet?.excludedShotIds ?? []);
  const sequence = project.shots.filter((shot) => !excluded.has(shot.id));
  const sequenceSeconds = sequence.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  const sequenceTooLong = sequenceSeconds > MAX_SEQUENCE_DURATION_SECONDS;
  const moving = project.shots.filter((shot) => shot.keyframes.length > 1);
  const videoShot =
    project.shots.find((shot) => shot.id === chosenShotId) ??
    project.shots.find((shot) => shot.id === activeShotId) ??
    moving[0] ??
    project.shots[0];
  return (
    <div className="export-panel">
      <Segmented
        label="Export type"
        value={output}
        onChange={setOutput}
        options={[
          { value: "plan", label: "Shot plan", icon: <FileImage size={14} /> },
          { value: "video", label: "Video", icon: <Film size={14} /> },
          { value: "data", label: "Data", icon: <Braces size={14} /> },
        ]}
      />
      {output === "plan" && (
        <div className="export-card">
          <h3>Shot plan</h3>
          <p className="meta">
            Printable PNG pages with each frame, lens, and notes, readable without Oculo.
          </p>
          <p className="export-summary">
            {plural(includedCount, "shot")} included
            <button className="btn btn--small btn--ghost" onClick={onShowShots}>
              Choose shots
            </button>
          </p>
          <button
            className="btn btn--primary btn--block"
            disabled={includedCount === 0 || busy}
            onClick={onOpenShotPlan}
          >
            <FileImage size={18} /> Preview and share plan
          </button>
        </div>
      )}
      {output === "video" && (
        <div className="export-card">
          <h3>{videoMode === "shot" ? "Shot preview video" : "Shot sequence video"}</h3>
          <Segmented
            label="Video contents"
            value={videoMode}
            onChange={setVideoMode}
            options={[
              { value: "shot", label: "One shot" },
              { value: "sequence", label: "Sequence" },
            ]}
          />
          {videoMode === "shot" ? (
            <>
              <p className="meta">
                An MP4 of one shot rendered from this scene at its length and speed, with
                attribution when required.
              </p>
              {videoShot ? (
                <label className="field">
                  <span>Shot</span>
                  <select
                    value={videoShot.id}
                    onChange={(event) => setChosenShotId(event.target.value)}
                  >
                    {project.shots.map((shot) => (
                      <option key={shot.id} value={shot.id}>
                        {shot.name} ({shot.keyframes.length > 1 ? "moving" : "static"})
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="inline-alert">Create a shot in Compose to render a preview.</p>
              )}
              <button
                className="btn btn--primary btn--block"
                disabled={!videoShot || !sceneReady || busy}
                onClick={() => videoShot && onOpenVideo([videoShot.id])}
              >
                <Film size={18} /> Render shot preview
              </button>
            </>
          ) : (
            <>
              <p className="meta">
                The chosen shots cut together into one MP4, in shot-list order, each at its own
                length and speed. Reorder shots on the Shots tab.
              </p>
              {project.shots.length === 0 ? (
                <p className="inline-alert">Create shots in Compose to render a sequence.</p>
              ) : (
                <ol className="sequence-list" aria-label="Shots in the sequence">
                  {project.shots.map((shot, index) => {
                    const included = !excluded.has(shot.id);
                    return (
                      <li key={shot.id} data-included={included}>
                        <label>
                          <input
                            type="checkbox"
                            checked={included}
                            onChange={() => {
                              const next = new Set(excluded);
                              if (included) next.add(shot.id);
                              else next.delete(shot.id);
                              setLeftOut(next);
                            }}
                          />
                          <span className="sequence-list__index" aria-hidden="true">
                            {index + 1}
                          </span>
                          {shot.thumbnailDataUrl ? (
                            <img src={shot.thumbnailDataUrl} alt="" draggable={false} />
                          ) : (
                            <span className="sequence-list__thumb" aria-hidden="true" />
                          )}
                          <span className="sequence-list__name">{shot.name}</span>
                          <small>{formatSeconds(shot.durationSeconds)}</small>
                        </label>
                      </li>
                    );
                  })}
                </ol>
              )}
              <p className={`export-summary${sequenceTooLong ? " is-warning" : ""}`} role="status">
                {plural(sequence.length, "shot")} · {formatSeconds(sequenceSeconds)}
                {sequenceTooLong && ` · over the ${MAX_SEQUENCE_DURATION_SECONDS}s limit`}
              </p>
              <button
                className="btn btn--primary btn--block"
                disabled={sequence.length === 0 || sequenceTooLong || !sceneReady || busy}
                onClick={() => onOpenVideo(sequence.map((shot) => shot.id))}
              >
                <Film size={18} /> Render sequence
              </button>
            </>
          )}
        </div>
      )}
      {output === "data" && <CameraDataExport project={project} onFlush={onFlush} />}
    </div>
  );
}

function CameraDataExport({
  project,
  onFlush,
}: {
  project: SceneWorkspace;
  onFlush: () => Promise<SceneWorkspace>;
}) {
  const sharing = useMemo(() => createSharingService(), []);
  const [prepared, setPrepared] = useState<PreparedShare | null>(null);
  const [state, setState] = useState<"idle" | "preparing" | "ready" | "sharing">("idle");
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      prepared?.dispose();
    },
    [prepared],
  );

  const prepare = async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    prepared?.dispose();
    setPrepared(null);
    setMessage("");
    setState("preparing");
    try {
      const saved = await onFlush();
      const share = await sharing.prepare([cameraMetadataArtifact(saved)], {
        signal: current.signal,
      });
      if (current.signal.aborted) return share.dispose();
      setPrepared(share);
      setState("ready");
    } catch (reason) {
      if (current.signal.aborted) return;
      setState("idle");
      setMessage(reason instanceof Error ? reason.message : "Camera data could not be prepared.");
    }
  };

  const share = async () => {
    if (!prepared) return;
    setState("sharing");
    try {
      const outcome = await prepared.share();
      setMessage(outcome === "shared" ? "Camera data shared." : "Share cancelled. Ready to retry.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Camera data could not be shared.");
    } finally {
      setState("ready");
    }
  };

  const file = prepared?.files[0];
  return (
    <div className="export-card">
      <h3>Camera data</h3>
      <p className="meta">
        Versioned JSON with every shot’s lens, sensor, length and notes, and each keyframe’s
        position, rotation, zoom, focus and aperture. Local file paths are never included.
      </p>
      <p className="export-summary">
        {plural(project.shots.length, "shot")} ·{" "}
        {plural(project.shots.filter((shot) => shot.keyframes.length > 1).length, "moving shot")}
      </p>
      {state === "idle" || state === "preparing" ? (
        <div className="button-stack">
          <button
            className="btn btn--primary btn--block"
            disabled={state === "preparing" || project.shots.length === 0}
            onClick={() => void prepare()}
          >
            <Braces size={18} /> {state === "preparing" ? "Preparing…" : "Prepare camera data"}
          </button>
          {state === "preparing" && (
            <button
              className="btn btn--ghost btn--block"
              onClick={() => {
                controller.current?.abort();
                setState("idle");
              }}
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="button-stack">
          {file && (
            <p className="meta">
              {file.name} · {Math.max(1, Math.round(file.size / 1024))} KB
            </p>
          )}
          {prepared?.canShare ? (
            <button
              className="btn btn--primary btn--block"
              disabled={state === "sharing"}
              onClick={() => void share()}
            >
              <Share2 size={18} /> Share camera data
            </button>
          ) : (
            prepared?.canDownload && (
              <button className="btn btn--primary btn--block" onClick={() => prepared.download(0)}>
                Download camera data
              </button>
            )
          )}
          <button className="btn btn--ghost btn--block" onClick={() => void prepare()}>
            Prepare again
          </button>
        </div>
      )}
      {message && (
        <p className="meta" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
