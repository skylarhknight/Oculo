import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ChevronLeft, CloudDownload, FileUp, HardDrive, Info, X } from "lucide-react";
import { useAppServices } from "../app/AppServices";
import { useProjectActions } from "../app/useProjectActions";
import { ImportSceneModal } from "../components/ImportSceneModal";
import { ScenePreview, type PreviewStatus } from "../components/ScenePreview";
import { SCENE_GALLERY, downloadAvailable, type GalleryScene } from "../config/sceneCatalog";
import { useNavigation } from "../navigation/Navigation";
import {
  SceneDownloadError,
  cachedGalleryScene,
  downloadGalleryScene,
} from "../services/sceneAssetCache";
import { SceneCreditsSheet } from "../components/SceneCredits";
import { flyFrom } from "../ui/flip";
import { useReveal } from "../ui/useReveal";
import "./sceneGallery.css";

type Download =
  { status: "downloading"; loaded: number; total: number } | { status: "error"; message: string };

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;
const splats = (count: number) => `${(count / 1e6).toFixed(1)}M splats`;

/**
 * Where a scene comes from. Tapping a card previews it in the top half (a spinning
 * isometric view to drag and pinch); "Select scene" on the card, or Select in the bar,
 * starts the project (or adds the scene to `projectId`) and opens Compose.
 */
export function SceneGalleryScreen({ projectId }: { projectId?: string }) {
  const services = useAppServices();
  const navigation = useNavigation();
  const actions = useProjectActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<ReadonlySet<string>>(new Set());
  const [downloads, setDownloads] = useState<ReadonlyMap<string, Download>>(new Map());
  const [preview, setPreview] = useState<{ id: string; url?: string } | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle");
  const [previewError, setPreviewError] = useState("");
  const [credits, setCredits] = useState<GalleryScene | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const aborts = useRef(new Map<string, AbortController>());
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const selected = SCENE_GALLERY.find((scene) => scene.id === selectedId) ?? null;
  const ready = (scene: GalleryScene) =>
    scene.availability === "bundled" || downloaded.has(scene.descriptor.asset.versionId);

  useEffect(() => {
    let active = true;
    void services.local
      .listGalleryAssets()
      .then((rows) => {
        if (active) setDownloaded(new Set(rows.map((row) => row.versionId)));
      })
      .catch(() => undefined);
    const pending = aborts.current;
    return () => {
      active = false;
      for (const controller of pending.values()) controller.abort();
    };
  }, [services.local]);

  // Blob URLs for downloaded previews live only while they are shown.
  useEffect(() => {
    const url = preview?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview]);

  const showDownloaded = useCallback(
    async (scene: GalleryScene) => {
      const data = await cachedGalleryScene(scene, services.local);
      if (!data || selectedRef.current !== scene.id) return;
      setPreview({ id: scene.id, url: URL.createObjectURL(data) });
    },
    [services.local],
  );

  const download = useCallback(
    async (scene: GalleryScene) => {
      if (aborts.current.has(scene.id)) return;
      const controller = new AbortController();
      aborts.current.set(scene.id, controller);
      const update = (state: Download | null) =>
        setDownloads((current) => {
          const next = new Map(current);
          if (state) next.set(scene.id, state);
          else next.delete(scene.id);
          return next;
        });
      update({ status: "downloading", loaded: 0, total: scene.byteSize });
      try {
        await downloadGalleryScene(scene, services.local, {
          signal: controller.signal,
          onProgress: ({ loaded, total }) => update({ status: "downloading", loaded, total }),
        });
        update(null);
        setDownloaded((current) => new Set(current).add(scene.descriptor.asset.versionId));
        await showDownloaded(scene);
      } catch (reason) {
        if (controller.signal.aborted) update(null);
        else
          update({
            status: "error",
            message:
              reason instanceof SceneDownloadError
                ? reason.message
                : "The scene couldn't be saved on this device.",
          });
      } finally {
        aborts.current.delete(scene.id);
      }
    },
    [services.local, showDownloaded],
  );

  // The tapped card's picture flies up into the stage.
  const flight = useRef<DOMRect | null>(null);
  const posterRef = useRef<HTMLImageElement>(null);
  const cardsRef = useRef<HTMLUListElement>(null);
  useReveal(cardsRef, ":scope > li");
  useLayoutEffect(() => {
    const from = flight.current;
    flight.current = null;
    if (from && posterRef.current) flyFrom(from, posterRef.current);
  }, [selectedId]);

  const choose = (scene: GalleryScene, from?: Element | null) => {
    if (scene.id !== selectedId) flight.current = from?.getBoundingClientRect() ?? null;
    setError("");
    setSelectedId(scene.id);
    setPreviewError("");
    if (scene.availability === "bundled") setPreview({ id: scene.id });
    else if (ready(scene)) {
      setPreview(null);
      void showDownloaded(scene);
    } else {
      setPreview(null);
      if (downloadAvailable(scene)) void download(scene);
    }
  };

  const confirm = async (scene: GalleryScene | null = selected) => {
    if (!scene || !ready(scene) || busy) return;
    setBusy(true);
    setError("");
    try {
      if (projectId) await actions.addDemoScene(projectId, scene);
      else await actions.createFromDemo("", scene);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The scene could not be added.");
    } finally {
      setBusy(false);
    }
  };

  const previewScene = useMemo(
    () => SCENE_GALLERY.find((scene) => scene.id === preview?.id) ?? null,
    [preview],
  );
  const selectedDownload = selected ? downloads.get(selected.id) : undefined;

  if (importing)
    return (
      <ImportSceneModal
        onClose={() => setImporting(false)}
        onImport={async (prepared, signal) => {
          if (projectId) await actions.addImportedScene(projectId, prepared, signal);
          else await actions.createFromImport("", prepared, signal);
        }}
      />
    );

  return (
    <div className="screen scene-gallery-screen">
      <header className="app-bar scene-gallery__bar" data-appearance="dark">
        <button className="icon-btn" aria-label="Back" onClick={() => void navigation.pop()}>
          <ChevronLeft size={28} strokeWidth={2.2} />
        </button>
        <span className="app-bar__title">{projectId ? "Add a scene" : "Choose a scene"}</span>
        <button
          className="btn btn--small btn--primary scene-gallery__select"
          disabled={!selected || !ready(selected) || busy}
          onClick={() => void confirm()}
        >
          Select
        </button>
      </header>

      <section
        className="scene-stage-preview"
        data-status={selected ? (preview ? previewStatus : "waiting") : "idle"}
        aria-label="Scene preview"
        data-appearance="dark"
      >
        <ScenePreview
          descriptor={previewScene?.descriptor ?? null}
          url={preview?.url}
          label={previewScene ? `Preview of ${previewScene.title}` : "No scene selected"}
          onStatus={(status, message) => {
            setPreviewStatus(status);
            setPreviewError(status === "error" ? (message ?? "") : "");
          }}
        />
        {selected ? (
          <>
            <img
              ref={posterRef}
              key={selected.id}
              className="scene-stage-preview__poster"
              src={selected.thumbnail}
              alt=""
              data-hidden={preview?.id === selected.id && previewStatus === "ready"}
              data-blur={selectedDownload?.status === "downloading"}
            />
            <StageStatus
              scene={selected}
              download={selectedDownload}
              previewing={preview?.id === selected.id}
              previewStatus={previewStatus}
              previewError={previewError}
              onCancel={() => aborts.current.get(selected.id)?.abort()}
              onRetry={() => void download(selected)}
            />
            <div className="scene-stage-preview__caption">
              <span>
                <strong>{selected.title}</strong>
                <small>by {selected.credit.author}</small>
              </span>
              <button
                className="scene-stage-preview__info"
                aria-label={`Credits for ${selected.title}`}
                onClick={() => setCredits(selected)}
              >
                <Info size={18} />
              </button>
            </div>
          </>
        ) : (
          <div className="scene-stage-preview__empty">
            <div className="scene-stage-preview__posters" aria-hidden="true">
              {SCENE_GALLERY.slice(0, 4).map((scene, index) => (
                <img
                  key={scene.id}
                  src={scene.thumbnail}
                  alt=""
                  style={{ "--i": index } as CSSProperties}
                />
              ))}
            </div>
            <p>Tap a scene to preview it</p>
          </div>
        )}
      </section>

      <div className="screen-scroll scene-gallery__scroll">
        <div>
          {error && (
            <div className="inline-alert" role="alert">
              <span>{error}</span>
            </div>
          )}
          <ul ref={cardsRef} className="scene-cards" aria-label="Scenes">
            <li className="scene-card scene-card--import">
              <button className="scene-card__button" onClick={() => setImporting(true)}>
                <span className="scene-card__art">
                  <FileUp size={26} />
                </span>
                <span className="scene-card__text">
                  <strong>Import your own</strong>
                  <small>SPZ file · stays on this device</small>
                </span>
              </button>
            </li>
            {SCENE_GALLERY.map((scene, index) => {
              const isSelected = scene.id === selectedId;
              const state = downloads.get(scene.id);
              const available = downloadAvailable(scene);
              return (
                <li
                  key={scene.id}
                  className="scene-card"
                  data-selected={isSelected}
                  data-unavailable={!available}
                  style={{ "--i": index } as CSSProperties}
                >
                  <button
                    className="scene-card__button"
                    aria-pressed={isSelected}
                    aria-label={`Preview ${scene.title}`}
                    onClick={(event) =>
                      choose(scene, event.currentTarget.querySelector(".scene-card__art img"))
                    }
                  >
                    <span className="scene-card__art">
                      <img src={scene.thumbnail} alt="" loading="lazy" />
                      <span className="scene-card__badge">
                        {scene.availability === "bundled" || ready(scene) ? (
                          <>
                            <HardDrive size={12} /> On device
                          </>
                        ) : state?.status === "downloading" ? (
                          <>{Math.round((state.loaded / Math.max(1, state.total)) * 100)}%</>
                        ) : available ? (
                          <>
                            <CloudDownload size={12} /> {megabytes(scene.byteSize)}
                          </>
                        ) : (
                          <>Unavailable</>
                        )}
                      </span>
                    </span>
                    <span className="scene-card__text">
                      <strong>{scene.title}</strong>
                      <small>
                        by {scene.credit.author} · {scene.credit.license}
                      </small>
                    </span>
                  </button>
                  {isSelected && (
                    <span className="scene-card__select-layer">
                      <button
                        className="scene-card__select"
                        disabled={!ready(scene) || busy}
                        onClick={() => void confirm(scene)}
                      >
                        {ready(scene) ? "Select scene" : available ? "Downloading…" : "Unavailable"}
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="scene-gallery__note">
            Scenes by SuperSplat creators, shared under {SCENE_GALLERY[0]?.credit.license}.
            Downloads happen only when you tap a scene; nothing is uploaded.
          </p>
        </div>
      </div>

      {credits && <SceneCreditsSheet scenes={[credits]} onClose={() => setCredits(null)} />}
    </div>
  );
}

function StageStatus({
  scene,
  download,
  previewing,
  previewStatus,
  previewError,
  onCancel,
  onRetry,
}: {
  scene: GalleryScene;
  download: Download | undefined;
  previewing: boolean;
  previewStatus: PreviewStatus;
  previewError: string;
  onCancel: () => void;
  onRetry: () => void;
}) {
  if (download?.status === "downloading") {
    const fraction = Math.min(1, download.loaded / Math.max(1, download.total));
    return (
      <div className="scene-stage-preview__status" role="status">
        <span className="progress-ring" style={{ "--progress": fraction } as CSSProperties}>
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle className="progress-ring__track" cx="18" cy="18" r="16" pathLength="1" />
            <circle className="progress-ring__value" cx="18" cy="18" r="16" pathLength="1" />
          </svg>
        </span>
        <span>
          Downloading {(download.loaded / 1e6).toFixed(1)} of {megabytes(download.total)}
        </span>
        <button className="btn btn--small btn--ghost" onClick={onCancel}>
          <X size={14} /> Cancel
        </button>
      </div>
    );
  }
  if (download?.status === "error")
    return (
      <div className="scene-stage-preview__status" role="alert">
        <span>{download.message}</span>
        <button className="btn btn--small btn--secondary" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  if (!downloadAvailable(scene))
    return (
      <div className="scene-stage-preview__status" role="status">
        <span>This scene isn't available in this build yet.</span>
      </div>
    );
  if (previewing && previewStatus === "error")
    return (
      <div className="scene-stage-preview__status" role="alert">
        <span>{previewError || "The preview couldn't load."}</span>
      </div>
    );
  if (previewStatus === "loading" || !previewing)
    return (
      <div className="scene-stage-preview__status scene-stage-preview__status--quiet" role="status">
        <span className="loader" aria-hidden="true" />
        <span>Loading preview · {splats(scene.splatCount)}</span>
      </div>
    );
  return null;
}
