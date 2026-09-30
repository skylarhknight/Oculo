import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileImage,
  RefreshCw,
  Share2,
  X,
} from "lucide-react";
import type { SceneWorkspace } from "../types/project";
import type { WorkspaceStore } from "../store/WorkspaceStore";
import { ProjectSaveCoordinator } from "../services/ProjectSaveCoordinator";
import { reorderShot, setShotIncluded } from "../services/shotSheetEditing";
import { createSharingService, type PreparedShare } from "../services/SharingService";
import {
  createShotSheet,
  generateShotSheet,
  ShotSheetError,
  shotMetadata,
  type GeneratedSheetPage,
} from "../services/shotSheet";

interface ShotSheetWorkspaceProps {
  initialProject: SceneWorkspace;
  store: WorkspaceStore;
  onChange: (project: SceneWorkspace) => void;
  onClose: (project: SceneWorkspace) => void;
  onRecapture: (project: SceneWorkspace, shotId: string) => void;
}

type WorkState = "editing" | "generating" | "preparing" | "ready" | "sharing";

export function ShotSheetWorkspace({
  initialProject,
  store,
  onChange,
  onClose,
  onRecapture,
}: ShotSheetWorkspaceProps) {
  const [project, setProject] = useState(initialProject);
  const projectRef = useRef(initialProject);
  const [title, setTitle] = useState(initialProject.name);
  const titleRef = useRef(initialProject.name);
  const [state, setState] = useState<WorkState>("editing");
  const stateRef = useRef<WorkState>("editing");
  const [pages, setPages] = useState<GeneratedSheetPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [previewEnlarged, setPreviewEnlarged] = useState(false);
  const previewViewport = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [badImageIds, setBadImageIds] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<PreparedShare | null>(null);
  const preparedRef = useRef<PreparedShare | null>(null);
  const generation = useRef<AbortController | null>(null);
  const filePreparation = useRef<AbortController | null>(null);
  const filePreparationRunning = useRef(false);
  const [filePreparationPending, setFilePreparationPending] = useState(false);
  const mounted = useRef(true);
  const saves = useMemo(() => new ProjectSaveCoordinator(store), [store]);
  const [saveState, setSaveState] = useState(() => saves.getState());
  const sharing = useMemo(() => createSharingService(), []);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pageUrl, setPageUrl] = useState("");

  const changeState = (next: WorkState) => {
    stateRef.current = next;
    setState(next);
  };

  useEffect(() => {
    mounted.current = true;
    headingRef.current?.focus({ preventScroll: true });
    const unsubscribe = saves.subscribe(setSaveState);
    const persist = () => {
      void saves.flush().catch(() => undefined);
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") persist();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", persist);
    return () => {
      mounted.current = false;
      generation.current?.abort();
      filePreparation.current?.abort();
      preparedRef.current?.dispose();
      unsubscribe();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", persist);
      persist();
    };
  }, [saves]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const workspace = workspaceRef.current;
    const body = bodyRef.current;
    if (!viewport || !workspace || !body) return;
    let frame: number | undefined;
    let previousHeight = viewport.height;
    let revealRequested = false;
    const updateViewport = () => {
      frame = undefined;
      // Keyboard/accessory panning changes the visual viewport, not 100dvh.
      // Keep browser pinch zoom free to pan over the existing layout.
      if (
        Math.abs(viewport.scale - 1) > 0.01 ||
        !Number.isFinite(viewport.height) ||
        viewport.height <= 0 ||
        !Number.isFinite(viewport.offsetTop)
      )
        return;
      workspace.style.height = `${viewport.height}px`;
      workspace.style.top = `${Math.max(0, viewport.offsetTop)}px`;
      const reveal = revealRequested || viewport.height < previousHeight;
      previousHeight = viewport.height;
      revealRequested = false;
      // Normal panning and keyboard dismissal must preserve the user's list position.
      if (!reveal) return;

      const field = document.activeElement;
      if (
        !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) ||
        !body.contains(field)
      )
        return;
      const visible = body.getBoundingClientRect();
      if (visible.height <= 0) return;
      const bounds = field.getBoundingClientRect();
      const top = visible.top + 12;
      const bottom = visible.bottom - 12;
      // Scroll only the field list; scrollIntoView can pan the whole WKWebView.
      // A tall textarea already spanning the list must not bounce between edges.
      if (bounds.top < top && bounds.bottom < bottom) body.scrollTop += bounds.top - top;
      else if (bounds.bottom > bottom && bounds.top > top)
        body.scrollTop += Math.min(bounds.bottom - bottom, bounds.top - top);
    };
    const scheduleViewport = () => {
      if (frame === undefined) frame = requestAnimationFrame(updateViewport);
    };
    const revealField = () => {
      revealRequested = true;
      scheduleViewport();
    };
    updateViewport();
    viewport.addEventListener("resize", scheduleViewport);
    viewport.addEventListener("scroll", scheduleViewport);
    window.addEventListener("resize", scheduleViewport);
    workspace.addEventListener("focusin", revealField);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", scheduleViewport);
      viewport.removeEventListener("scroll", scheduleViewport);
      window.removeEventListener("resize", scheduleViewport);
      workspace.removeEventListener("focusin", revealField);
    };
  }, []);

  // Only the visible page is decoded, even for a large multi-page sheet.
  useEffect(() => {
    const page = pages[pageIndex];
    if (!page) {
      setPageUrl("");
      return;
    }
    const url = URL.createObjectURL(page.blob);
    setPageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pages, pageIndex]);

  useEffect(() => {
    const viewport = previewViewport.current;
    if (!viewport) return;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  }, [pages, pageIndex, previewEnlarged]);

  const changePage = (offset: -1 | 1) => {
    setPreviewEnlarged(false);
    setPageIndex((index) => index + offset);
  };

  const invalidate = () => {
    if (closingRef.current || stateRef.current === "sharing") return;
    generation.current?.abort();
    generation.current = null;
    filePreparation.current?.abort();
    filePreparation.current = null;
    preparedRef.current?.dispose();
    preparedRef.current = null;
    setPrepared(null);
    setPages([]);
    setPageIndex(0);
    setPreviewEnlarged(false);
    setNotice("");
    setError("");
    changeState("editing");
  };

  const update = (patch: Partial<SceneWorkspace>) => {
    if (closingRef.current || stateRef.current !== "editing") return projectRef.current;
    invalidate();
    const next = { ...projectRef.current, ...patch, updatedAt: Date.now() };
    projectRef.current = next;
    setProject(next);
    onChange(next);
    saves.schedule(next);
    return next;
  };

  const commitTitle = () => {
    if (closingRef.current) return projectRef.current;
    const name = titleRef.current.trim() || projectRef.current.name;
    setTitle(name);
    titleRef.current = name;
    return name === projectRef.current.name ? projectRef.current : update({ name });
  };

  const leave = async (shotId?: string) => {
    if (closingRef.current || stateRef.current === "sharing") return;
    commitTitle();
    invalidate();
    closingRef.current = true;
    setClosing(true);
    try {
      await saves.flush();
      if (!mounted.current) return;
      if (shotId) onRecapture(projectRef.current, shotId);
      else onClose(projectRef.current);
    } catch {
      closingRef.current = false;
      if (mounted.current) setClosing(false);
    }
  };

  const prepareFiles = async (result: GeneratedSheetPage[]) => {
    if (closingRef.current || filePreparationRunning.current || stateRef.current === "sharing")
      return;
    const controller = new AbortController();
    filePreparation.current = controller;
    filePreparationRunning.current = true;
    setFilePreparationPending(true);
    changeState("preparing");
    setError("");
    setNotice("");
    setProgress("Preparing files for sharing…");
    try {
      const delivery = await sharing.prepare(result, {
        signal: controller.signal,
        onProgress: ({ completed, total }) => {
          if (mounted.current && !controller.signal.aborted)
            setProgress(`Preparing files · ${completed} of ${total}`);
        },
      });
      if (!mounted.current || controller.signal.aborted || filePreparation.current !== controller) {
        delivery.dispose();
        return;
      }
      preparedRef.current = delivery;
      setPrepared(delivery);
      changeState("ready");
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted || filePreparation.current !== controller)
        return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Files could not be prepared. Your preview is preserved.",
      );
      changeState("ready");
    } finally {
      filePreparationRunning.current = false;
      if (filePreparation.current === controller) filePreparation.current = null;
      if (mounted.current) setFilePreparationPending(false);
    }
  };

  const cancelFilePreparation = () => {
    filePreparation.current?.abort();
    filePreparation.current = null;
    setNotice("File preparation cancelled. Your preview is preserved.");
    changeState("ready");
  };

  const prepare = async () => {
    if (closingRef.current || stateRef.current !== "editing" || filePreparationRunning.current)
      return;
    const snapshot = structuredClone(commitTitle());
    invalidate();
    const controller = new AbortController();
    generation.current = controller;
    changeState("generating");
    setError("");
    setBadImageIds([]);
    setProgress("Saving your changes…");
    try {
      await saves.flush();
      if (!mounted.current || controller.signal.aborted) return;
      const document = createShotSheet(snapshot);
      const result = await generateShotSheet(document, {
        signal: controller.signal,
        onProgress: (value) => {
          if (!controller.signal.aborted)
            setProgress(
              `${value.phase === "images" ? "Checking frames" : "Preparing pages"} · ${value.completed} of ${value.total}`,
            );
        },
      });
      if (!mounted.current || controller.signal.aborted) return;
      setPages(result);
      setPageIndex(0);
      changeState("ready");
      void prepareFiles(result);
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted) return;
      if (reason instanceof ShotSheetError) setBadImageIds([...reason.shotIds]);
      setError(
        reason instanceof Error
          ? reason.message
          : "The shot sheet could not be prepared. Please try again.",
      );
      changeState("editing");
    } finally {
      if (generation.current === controller) generation.current = null;
    }
  };

  const share = () => {
    const delivery = preparedRef.current;
    if (closingRef.current || !delivery || stateRef.current !== "ready") return;
    changeState("sharing");
    setError("");
    setNotice("");
    // Invoke immediately in the click handler; no async work precedes Web Share.
    void delivery
      .share()
      .then((result) => {
        if (!mounted.current) return;
        setNotice(
          result === "shared"
            ? "Files handed to the selected app."
            : result === "cancelled"
              ? "Sharing cancelled. Your sheet is ready to share again."
              : "Share sheet closed. Your sheet is still ready.",
        );
      })
      .catch((reason: unknown) => {
        if (mounted.current)
          setError(reason instanceof Error ? reason.message : "Sharing failed. Please try again.");
      })
      .finally(() => {
        if (mounted.current) changeState("ready");
      });
  };

  const download = () => {
    if (closingRef.current || !preparedRef.current || stateRef.current !== "ready") return;
    try {
      preparedRef.current.download(pageIndex);
      setNotice(`Download started for page ${pageIndex + 1}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Download failed. Please try again.");
    }
  };

  const excluded = new Set(project.shotSheet?.excludedShotIds ?? []);
  const includedCount = project.shots.filter((shot) => !excluded.has(shot.id)).length;
  const selectedOrdinals = new Map(
    project.shots
      .filter((shot) => !excluded.has(shot.id))
      .map((shot, index) => [shot.id, index + 1]),
  );
  const busy = state === "generating" || state === "preparing" || state === "sharing" || closing;
  const previewPage = pages[pageIndex];

  return (
    <main
      ref={workspaceRef}
      className={`sheet-workspace${project.settings.reduceMotion ? " reduce-motion" : ""}`}
      aria-busy={busy}
    >
      <header className="sheet-header">
        <button
          className="icon-button"
          aria-label="Close shot sheet"
          disabled={closing || state === "sharing"}
          onClick={() => void leave()}
        >
          <ChevronLeft size={28} strokeWidth={2.2} />
        </button>
        <div>
          <h1 ref={headingRef} tabIndex={-1}>
            Shot sheet
          </h1>
          <p role="status">
            {saveState.status === "error"
              ? "Changes not saved"
              : saveState.status === "saving"
                ? "Saving…"
                : "Saved on device"}
          </p>
        </div>
        {state === "ready" && (
          <button className="secondary-button" disabled={closing} onClick={invalidate}>
            Edit sheet
          </button>
        )}
      </header>

      <div ref={bodyRef} className="sheet-body">
        {saveState.status === "error" && (
          <div className="sheet-alert" role="alert">
            <p>{saveState.error ?? "Your changes could not be saved."}</p>
            <button onClick={() => void saves.retry().catch(() => undefined)}>Retry save</button>
          </div>
        )}
        {error && (
          <div className="sheet-alert" role="alert">
            <p>{error}</p>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={18} />
            </button>
          </div>
        )}
        {notice && (
          <p className="sheet-notice" role="status">
            {notice}
          </p>
        )}

        {state === "editing" && (
          <>
            <div className="sheet-intro">
              <span className="kicker">FROM FRAME TO PLAN</span>
              <h2>Put your shots in order.</h2>
              <p>Share PNG pages your collaborators can open in any image viewer.</p>
            </div>
            <label className="field-stack sheet-project-title">
              <span>Project title</span>
              <input
                value={title}
                maxLength={120}
                disabled={closing}
                onChange={(event) => {
                  if (closingRef.current) return;
                  titleRef.current = event.target.value;
                  setTitle(event.target.value);
                  if (event.target.value.trim()) update({ name: event.target.value.trim() });
                  else invalidate();
                }}
                onBlur={commitTitle}
              />
            </label>
            <div className="sheet-selection-heading">
              <p>
                {includedCount} of {project.shots.length} shots included
              </p>
              {project.shots.length > 0 && (
                <div>
                  <button
                    disabled={closing}
                    onClick={() => update({ shotSheet: { version: 1, excludedShotIds: [] } })}
                  >
                    Include all
                  </button>
                  <button
                    disabled={closing}
                    onClick={() =>
                      update({
                        shotSheet: {
                          version: 1,
                          excludedShotIds: project.shots.map((shot) => shot.id),
                        },
                      })
                    }
                  >
                    Clear selection
                  </button>
                </div>
              )}
            </div>
            {project.shots.length === 0 && (
              <div className="sheet-empty">
                <Camera size={32} />
                <h2>Start with a saved shot</h2>
                <p>
                  Open the scene, compose a frame, and save it. Your shot sheet can begin with just
                  one shot.
                </p>
                <button className="primary-button" onClick={() => void leave()}>
                  Back to project
                </button>
              </div>
            )}
            <ol className="sheet-shot-list">
              {project.shots.map((shot, index) => {
                const missing = !shot.thumbnailDataUrl || badImageIds.includes(shot.id);
                const included = !excluded.has(shot.id);
                return (
                  <li key={shot.id} className={`sheet-shot${included ? "" : " excluded"}`}>
                    <p className="sheet-shot-number">
                      {included
                        ? `Shot ${String(selectedOrdinals.get(shot.id)).padStart(2, "0")} on sheet`
                        : "Excluded from sheet"}
                    </p>
                    <div className="sheet-shot-top">
                      <label>
                        <input
                          type="checkbox"
                          checked={included}
                          disabled={closing}
                          onChange={(event) =>
                            update({
                              shotSheet: setShotIncluded(
                                projectRef.current,
                                shot.id,
                                event.target.checked,
                              ),
                            })
                          }
                        />
                        <span>Include {shot.name}</span>
                      </label>
                      <div className="sheet-order-buttons">
                        <button
                          aria-label={`Move ${shot.name} earlier`}
                          disabled={index === 0 || closing}
                          onClick={() =>
                            update({ shots: reorderShot(projectRef.current, shot.id, -1) })
                          }
                        >
                          <ArrowUp size={18} />
                        </button>
                        <button
                          aria-label={`Move ${shot.name} later`}
                          disabled={index === project.shots.length - 1 || closing}
                          onClick={() =>
                            update({ shots: reorderShot(projectRef.current, shot.id, 1) })
                          }
                        >
                          <ArrowDown size={18} />
                        </button>
                      </div>
                    </div>
                    <div className="sheet-shot-content">
                      <div
                        className="sheet-frame"
                        style={{ aspectRatio: shot.setup.output.aspectRatio }}
                      >
                        {!missing && shot.thumbnailDataUrl ? (
                          <img
                            src={shot.thumbnailDataUrl}
                            alt={`Saved frame for ${shot.name}`}
                            loading="lazy"
                            onError={() =>
                              setBadImageIds((ids) =>
                                ids.includes(shot.id) ? ids : [...ids, shot.id],
                              )
                            }
                          />
                        ) : (
                          <div>
                            <Camera size={26} />
                            <span>Frame unavailable on this device</span>
                          </div>
                        )}
                      </div>
                      <div className="sheet-shot-details">
                        <ShotFields
                          shot={shot}
                          disabled={closing}
                          onChange={(patch) =>
                            update({
                              shots: projectRef.current.shots.map((item) =>
                                item.id === shot.id ? { ...item, ...patch } : item,
                              ),
                            })
                          }
                        />
                        <p className="sheet-camera-meta">{shotMetadata(shot)}</p>
                      </div>
                    </div>
                    {missing && (
                      <div className="sheet-missing">
                        <p>Exclude this shot, or open it in the scene to render its frame again.</p>
                        <button
                          className="secondary-button"
                          disabled={closing}
                          onClick={() => void leave(shot.id)}
                        >
                          <RefreshCw size={16} /> Open in scene
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {project.shots.length > 0 && (
              <p className="sheet-footnote">
                Digital reference images · PNG pages · Up to 100 selected shots. Full notes continue
                across pages. No camera move is required.
              </p>
            )}
          </>
        )}

        {state === "generating" && (
          <div className="sheet-progress" role="status">
            <FileImage size={36} />
            <h2>Preparing your shot sheet</h2>
            <p>{progress}</p>
            <button className="secondary-button" onClick={invalidate}>
              Cancel
            </button>
          </div>
        )}

        {(state === "ready" || state === "preparing" || state === "sharing") &&
          pages.length > 0 && (
            <section className="sheet-preview" aria-label="Generated shot sheet preview">
              <div className="sheet-preview-heading">
                <div>
                  <Check size={20} />
                  <span>
                    {pages.length} {pages.length === 1 ? "page" : "pages"} ready
                  </span>
                </div>
                <p>These are the exact images that will be shared.</p>
              </div>
              {state === "preparing" && (
                <div className="sheet-file-progress" role="status">
                  <p>{progress}</p>
                  <button className="secondary-button" onClick={cancelFilePreparation}>
                    Cancel file preparation
                  </button>
                </div>
              )}
              {state === "ready" && !prepared && (
                <p className="sheet-notice" role="status">
                  {filePreparationPending
                    ? "Finishing cancellation. Your preview is preserved."
                    : "Your preview is ready. Prepare the files to share or download it."}
                </p>
              )}
              <div className="sheet-page-controls">
                <button
                  aria-label="Previous page"
                  disabled={pageIndex === 0 || state === "sharing"}
                  onClick={() => changePage(-1)}
                >
                  <ChevronLeft size={20} />
                </button>
                <output aria-live="polite">
                  Page {pageIndex + 1} of {pages.length}
                </output>
                <button
                  aria-label="Next page"
                  disabled={pageIndex === pages.length - 1 || state === "sharing"}
                  onClick={() => changePage(1)}
                >
                  <ChevronRight size={20} />
                </button>
              </div>
              <div className="sheet-preview-zoom" role="group" aria-label="Preview zoom">
                <button
                  className="secondary-button"
                  aria-pressed={!previewEnlarged}
                  disabled={state === "sharing"}
                  onClick={() => setPreviewEnlarged(false)}
                >
                  Fit page
                </button>
                <button
                  className="secondary-button"
                  aria-pressed={previewEnlarged}
                  disabled={state === "sharing"}
                  onClick={() => setPreviewEnlarged(true)}
                >
                  Enlarge (100%)
                </button>
              </div>
              <p className="sheet-preview-hint" id="sheet-preview-help" aria-live="polite">
                {previewEnlarged
                  ? "Full size. Swipe or scroll to read the page. Each new page starts fitted."
                  : "Enlarge to read notes and camera settings. Each new page starts fitted."}
              </p>
              {previewPage?.text && (
                <details className="sheet-page-text" key={pageIndex}>
                  <summary>Read text for page {pageIndex + 1}</summary>
                  <p className="sheet-page-text-note">
                    The text printed on this PNG page, in reading order. Notes that continue onto
                    another page appear with that page.
                  </p>
                  <div role="region" aria-label={`Text for shot sheet page ${pageIndex + 1}`}>
                    <p className="sheet-page-transcript" dir="auto">
                      {previewPage.text}
                    </p>
                  </div>
                </details>
              )}
              {pageUrl && (
                <div
                  ref={previewViewport}
                  className={`sheet-page-viewport${previewEnlarged ? " enlarged" : ""}`}
                  role="region"
                  aria-label={`Page ${pageIndex + 1} image preview`}
                  aria-describedby="sheet-preview-help"
                  tabIndex={0}
                >
                  <img
                    className="sheet-page-image"
                    src={pageUrl}
                    alt={`Shot sheet page ${pageIndex + 1} of ${pages.length} for ${project.name}`}
                    draggable={false}
                    style={
                      previewEnlarged
                        ? {
                            width: pages[pageIndex]?.width,
                            height: pages[pageIndex]?.height,
                          }
                        : undefined
                    }
                  />
                </div>
              )}
              <p className="sheet-footnote">
                {pages[pageIndex]?.name} · {Math.ceil((pages[pageIndex]?.blob.size ?? 0) / 1024)} KB
              </p>
              {prepared && !prepared.canShare && !prepared.canDownload && (
                <p role="alert">
                  File sharing is unavailable on this device. Your project and generated preview are
                  preserved.
                </p>
              )}
            </section>
          )}
      </div>

      <footer className="sheet-footer">
        {state === "editing" && project.shots.length > 0 && (
          <button
            className="primary-button"
            disabled={includedCount === 0 || closing || filePreparationPending}
            onClick={() => void prepare()}
          >
            <FileImage size={19} /> Preview shot sheet
          </button>
        )}
        {(state === "ready" || state === "sharing") && (
          <>
            {!prepared && (
              <button
                className="primary-button"
                disabled={closing || filePreparationPending}
                onClick={() => void prepareFiles(pages)}
              >
                <RefreshCw size={18} /> Retry file preparation
              </button>
            )}
            {prepared?.canDownload && (
              <button
                className="secondary-button"
                disabled={state === "sharing"}
                onClick={download}
              >
                <Download size={18} /> Download page {pageIndex + 1}
              </button>
            )}
            {prepared?.canShare && (
              <button className="primary-button" disabled={state === "sharing"} onClick={share}>
                <Share2 size={19} />{" "}
                {state === "sharing"
                  ? "Sharing…"
                  : `Share ${pages.length > 1 ? "all pages" : "shot sheet"}`}
              </button>
            )}
          </>
        )}
      </footer>
    </main>
  );
}

function ShotFields({
  shot,
  disabled,
  onChange,
}: {
  shot: SceneWorkspace["shots"][number];
  disabled: boolean;
  onChange: (patch: { name?: string; notes?: string }) => void;
}) {
  const [name, setName] = useState(shot.name);
  return (
    <>
      <label className="field-stack">
        <span>Shot title</span>
        <input
          aria-label={`Title for ${shot.name}`}
          disabled={disabled}
          value={name}
          maxLength={60}
          onChange={(event) => {
            if (disabled) return;
            setName(event.target.value);
            if (event.target.value.trim()) onChange({ name: event.target.value.trim() });
          }}
          onBlur={() => {
            if (!disabled) setName(name.trim() || shot.name);
          }}
        />
      </label>
      <label className="field-stack">
        <span>Notes</span>
        <textarea
          aria-label={`Notes for ${shot.name}`}
          disabled={disabled}
          value={shot.notes ?? ""}
          rows={3}
          maxLength={10000}
          placeholder="Action, blocking, or the intent of the shot"
          onChange={(event) => {
            if (!disabled) onChange({ notes: event.target.value });
          }}
        />
      </label>
    </>
  );
}
