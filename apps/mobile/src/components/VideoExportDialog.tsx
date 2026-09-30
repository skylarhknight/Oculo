import { useEffect, useId, useRef, useState } from "react";
import { Download, Film, Share2, X } from "lucide-react";
import type { SceneEngine } from "@oculo/scene-core";
import type { Shot } from "@oculo/scene-schema";
import { createSharingService, type PreparedShare } from "../services/SharingService";
import {
  exportShotVideo,
  type ExportedVideo,
  type VideoExportProgress,
} from "../services/videoExport";
import { ModalDialog } from "./ModalDialog";
import "./VideoExportDialog.css";
import { videoAttributionText, type VideoAttribution } from "../services/videoExport/attribution";

export interface VideoExportDialogProps {
  engine: SceneEngine;
  /** One shot, or several stitched together in this order. */
  shots: readonly Shot[];
  projectName: string;
  attribution?: VideoAttribution;
  onClose: () => void;
}

export function VideoExportDialog({
  engine,
  shots,
  projectName,
  attribution,
  onClose,
}: VideoExportDialogProps) {
  const sequence = shots.length > 1;
  const durationSeconds = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  const seconds = Number(durationSeconds.toFixed(1));
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<VideoExportProgress>();
  const [video, setVideo] = useState<ExportedVideo>();
  const [previewUrl, setPreviewUrl] = useState("");
  const [prepared, setPrepared] = useState<PreparedShare>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const preparedRef = useRef<PreparedShare | undefined>(undefined);
  const sharingService = useRef<ReturnType<typeof createSharingService> | undefined>(undefined);
  const previewRef = useRef("");

  useEffect(() => {
    mounted.current = true;
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") controllerRef.current?.abort();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", visibilityChanged);
      controllerRef.current?.abort();
      preparedRef.current?.dispose();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  const close = () => {
    if (!busyRef.current) onClose();
  };
  const generate = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const result =
        video ??
        (await exportShotVideo({
          engine,
          shot: sequence ? shots : shots[0]!,
          projectName,
          ...(attribution ? { attribution } : {}),
          signal: controller.signal,
          onProgress: (value) => {
            if (mounted.current) setProgress(value);
          },
        }));
      if (controller.signal.aborted || !mounted.current) return;
      setProgress(undefined);
      if (!video) {
        setVideo(result);
        previewRef.current = URL.createObjectURL(result.blob);
        setPreviewUrl(previewRef.current);
      }
      setNotice("Preparing the video for sharing…");
      sharingService.current ??= createSharingService();
      const files = await sharingService.current.prepare(
        [{ name: result.name, mimeType: "video/mp4", blob: result.blob }],
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !mounted.current) {
        files.dispose();
        return;
      }
      preparedRef.current = files;
      setPrepared(files);
      setNotice("Your camera move is ready.");
    } catch (reason) {
      if (!mounted.current) return;
      if (controller.signal.aborted) setNotice("Export cancelled. Your camera move is unchanged.");
      else setError(reason instanceof Error ? reason.message : "Video export failed. Try again.");
    } finally {
      busyRef.current = false;
      controllerRef.current = undefined;
      if (mounted.current) {
        setBusy(false);
        setProgress(undefined);
      }
    }
  };

  const share = async () => {
    const files = preparedRef.current;
    if (!files || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const outcome = await files.share();
      if (mounted.current)
        setNotice(
          outcome === "shared"
            ? "Video handed to the sharing app."
            : "Sharing closed. Your video is still ready.",
        );
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : "Sharing failed. Try again.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <ModalDialog
      labelledBy={headingId}
      onClose={close}
      busy={busy}
      className="modal video-export-dialog"
    >
      <div className="video-export-heading">
        <div>
          <Film size={22} aria-hidden="true" />
          <h2 id={headingId}>{sequence ? "Export shot sequence" : "Export camera move"}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close video export"
          onClick={close}
          disabled={busy}
        >
          <X size={22} />
        </button>
      </div>
      {sequence ? (
        <>
          <p>
            Share {shots.length} shots as one {seconds}-second MP4, cut together in this order, each
            with its framing, zoom, and speed.
          </p>
          <ol className="video-export-sequence" aria-label="Shots in this video">
            {shots.map((shot, index) => (
              <li key={shot.id} data-rendering={progress?.shotIndex === index || undefined}>
                <span>{shot.name}</span>
                <small>{Number(shot.durationSeconds.toFixed(1))}s</small>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p>
          Share “{shots[0]!.name}” as a {seconds}-second MP4 preview, including your framing, zoom,
          and speed.
        </p>
      )}
      {previewUrl && (
        <video
          className="video-export-preview"
          src={previewUrl}
          controls
          playsInline
          preload="metadata"
          aria-label={sequence ? "Exported shot sequence preview" : "Exported camera move preview"}
        />
      )}
      {!video && (
        <p className="video-export-details">
          Up to 720p · 30 frames per second · No audio. Keep Oculo open while the video is
          created.
        </p>
      )}
      {progress && (
        <div className="video-export-progress">
          <progress
            aria-label="Video export progress"
            value={progress.completed}
            max={progress.total}
          />
          <p role="status">
            {progress.phase === "preparing"
              ? "Preparing video…"
              : progress.phase === "finishing"
                ? "Finishing MP4…"
                : progress.shotIndex !== undefined
                  ? `Rendering ${shots[progress.shotIndex]?.name ?? "shot"} · frame ${progress.completed} of ${progress.total}`
                  : `Rendering frame ${progress.completed} of ${progress.total}`}
          </p>
        </div>
      )}
      {video && (
        <p className="video-export-details">
          {video.width} × {video.height} · {video.durationSeconds} seconds ·{" "}
          {(video.blob.size / (1024 * 1024)).toFixed(1)} MB
        </p>
      )}
      {attribution && <p className="video-export-credit">{videoAttributionText(attribution)}</p>}
      {notice && !progress && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="video-export-error">
          {error}
        </p>
      )}
      <div className="video-export-actions">
        {busy && controllerRef.current ? (
          <button className="secondary-button" onClick={() => controllerRef.current?.abort()}>
            Cancel export
          </button>
        ) : (
          !prepared && (
            <button className="primary-button" onClick={() => void generate()} disabled={busy}>
              <Film size={18} />
              {video ? "Prepare sharing" : error ? "Try again" : "Export MP4"}
            </button>
          )
        )}
        {prepared?.canShare && (
          <button className="primary-button" onClick={() => void share()} disabled={busy}>
            <Share2 size={18} />
            Share video
          </button>
        )}
        {prepared?.canDownload && (
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              try {
                prepared.download(0);
                setNotice("Video download started.");
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : "Download failed. Try again.");
              }
            }}
          >
            <Download size={18} />
            Download MP4
          </button>
        )}
      </div>
    </ModalDialog>
  );
}
