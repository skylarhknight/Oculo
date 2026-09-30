import { shotStartCamera } from "@oculo/scene-schema";
import {
  appendKeyframe,
  clampFocal,
  clampShotDuration,
  formatFStop,
  keyframeFromRig,
  keyframeIndexAt,
  lensLabel,
  removeKeyframe,
  retimeShot,
  setKeyframeAt,
  setKeyframeTime,
  setShotLens,
  shotCameraAt,
  shotSegmentAt,
  updateKeyframe,
} from "@oculo/camera-core";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  Camera,
  Crop,
  Ellipsis,
  Eye,
  EyeOff,
  FileImage,
  Film,
  Footprints,
  Gamepad2,
  Images,
  Plus,
  Map as MapIcon,
  Redo2,
  RefreshCcw,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import type { LoadProgress, MapViewPhase, SceneEngine } from "@oculo/scene-core";
import { useAppServices } from "../../app/AppServices";
import { Joysticks, type NavigationDriver } from "../../components/Joysticks";
import { MagicWindowControls } from "../../components/MagicWindowControls";
import { SceneViewer } from "../../components/SceneViewer";
import { useLeaveGuard, useNavigation } from "../../navigation/Navigation";
import type { SceneStage } from "../../navigation/routes";
import { aspectLabel, fromCameraState, toCameraState } from "../../services/cameraState";
import { CameraEditHistory, cameraEditSnapshot } from "../../services/CameraEditHistory";
import { confirmHaptic, tapHaptic } from "../../services/haptics";
import { ProjectSaveCoordinator } from "../../services/ProjectSaveCoordinator";
import { createShot, initialCameraForScene, newKeyframeId } from "../../services/projectFactory";
import {
  deleteShotFromProject,
  nextShotName,
  reorderShot,
  setShotIncluded,
} from "../../services/shotSheetEditing";
import {
  cloneCamera,
  type CinematicCamera,
  type SceneWorkspace,
  type Shot,
  type ShotLens,
  type ShotSetup,
} from "../../types/project";
import { prefersReducedMotion } from "../../theme/motion";
import { displayCameraValue } from "../../ui/controls";
import { ActionSheet, Sheet } from "../../ui/Sheet";
import { ComposePanel, type ComposeTab } from "./ComposePanel";
import { ExportPanel } from "./ExportPanel";
import { MapMode } from "./MapMode";
import { ShotEditSheet } from "./ShotEditSheet";
import { ShotsPanel } from "./ShotsPanel";
import { planOverlayState } from "./planOverlay";
import { SceneProgress } from "./SceneProgress";
import { ShotsOverview } from "./ShotsOverview";
import {
  ASPECT_CHOICES,
  cameraAt,
  formatTime,
  shotKindLabel,
  type Transport,
} from "./workspaceShared";
import "./workspace.css";

const VideoExportDialog = lazy(() =>
  import("../../components/VideoExportDialog").then((module) => ({
    default: module.VideoExportDialog,
  })),
);

const makeId = () => crypto.randomUUID();
const WALK_SPEEDS = { slow: 0.35, normal: 1, fast: 3 } as const;
const WALK_LABELS = { slow: "Slow", normal: "Normal", fast: "Fast" } as const;
/** How long a marker's "Open" callout waits for a tap. */
const CALLOUT_MS = 4000;

function applyEngineCamera(engine: SceneEngine | null, camera: CinematicCamera) {
  engine?.setCameraState(toCameraState(camera), { emitChange: false });
}

/** Whether the rig still records exactly what a keyframe holds. */
function rigMatchesKeyframe(shot: Shot, keyframeId: string, rig: CinematicCamera): boolean {
  const keyframe = shot.keyframes.find((frame) => frame.id === keyframeId);
  if (!keyframe) return false;
  const now = keyframeFromRig(shot, keyframe.id, keyframe.timeSeconds, rig);
  const near = (a: number, b: number, tolerance = 1e-3) => Math.abs(a - b) <= tolerance;
  const [ax, ay, az, aw] = now.pose.quaternion;
  const [bx, by, bz, bw] = keyframe.pose.quaternion;
  return (
    now.pose.position.every((value, index) => near(value, keyframe.pose.position[index]!)) &&
    Math.abs(ax * bx + ay * by + az * bz + aw * bw) >= 1 - 1e-6 &&
    near(now.focalLengthMm, keyframe.focalLengthMm, 0.05) &&
    near(now.focusDistanceM, keyframe.focusDistanceM, 0.01) &&
    near(now.apertureFStop, keyframe.apertureFStop, 0.01)
  );
}

/** Time for the viewer to go full bleed before the overview measures it. */
const OVERVIEW_LAYOUT_MS = 50;

const STAGES: readonly { id: SceneStage; label: string; icon: typeof Camera }[] = [
  { id: "shots", label: "Shots", icon: Film },
  { id: "compose", label: "Compose", icon: Camera },
  { id: "export", label: "Export", icon: FileImage },
];

export function SceneWorkspaceView({
  initial,
  stage,
  initialShotId,
}: {
  initial: SceneWorkspace;
  stage: SceneStage;
  /** Opens this shot in the editor on arrival. */
  initialShotId?: string;
}) {
  const services = useAppServices();
  const { workspaces, resolveScene, refreshLibrary, preferences } = services;
  const navigation = useNavigation();
  const initialShot = initialShotId
    ? initial.shots.find((shot) => shot.id === initialShotId)
    : undefined;
  const [project, setProject] = useState(() =>
    initialShot ? { ...initial, camera: shotCameraAt(initialShot, 0) } : initial,
  );
  const [activeShotId, setActiveShotIdState] = useState<string | null>(initialShot?.id ?? null);
  const activeShotIdRef = useRef(activeShotId);
  const [atKeyframeId, setAtKeyframeIdState] = useState<string | null>(
    initialShot?.keyframes[0]?.id ?? null,
  );
  const atKeyframeRef = useRef(atKeyframeId);
  const [selectedSegment, setSelectedSegment] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  /** The shots being exported as video, in order; several are stitched together. */
  const [videoShotIds, setVideoShotIds] = useState<readonly string[] | null>(null);
  const exportOpen = videoShotIds !== null;
  const history = useMemo(() => new CameraEditHistory(), []);
  const [, refreshHistory] = useState(0);
  const beginEdit = useCallback(() => history.begin(), [history]);
  const endEdit = useCallback(() => {
    history.commit();
    refreshHistory((value) => value + 1);
  }, [history]);
  const scrubRef = useRef<{ element: HTMLDivElement; pointerId: number } | null>(null);
  const [sceneStatus, setSceneStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sceneError, setSceneError] = useState("");
  const [sceneAttempt, setSceneAttempt] = useState(0);
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);
  const [magicWindowActive, setMagicWindowActive] = useState(false);
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<"library" | "aspect" | "more" | "walk" | null>(null);
  const [shotError, setShotError] = useState("");
  const [creating, setCreating] = useState(false);
  const [composeTab, setComposeTab] = useState<ComposeTab>("lens");
  /** A saved-shot confirmation that offers to add notes. */
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  /** A tapped shot marker, waiting for "Open" so a stray tap never switches shots. */
  const [callout, setCallout] = useState<{ id: string; x: number; y: number } | null>(null);
  const [focusArmed, setFocusArmed] = useState(false);
  const [savedPulse, setSavedPulse] = useState(0);
  const tapRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const [panelExpanded, setPanelExpanded] = useState(false);
  // Map view: the canvas goes full bleed and the engine renders an isometric overview.
  const [mapOpen, setMapOpen] = useState(false);
  const [mapPhase, setMapPhase] = useState<MapViewPhase>("off");
  // Whether the map hides the scene's sky or ceiling (null: nothing to hide).
  const [roofCut, setRoofCut] = useState<boolean | null>(null);
  const [letterbox, setLetterbox] = useState<"open" | "closed">("closed");
  const frameFractionRef = useRef(1);
  const compassRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const mapBusyRef = useRef(false);
  // Shots overview: the same map session without the cinematographer, on the Shots tab.
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewHighlight, setOverviewHighlight] = useState<string | null>(null);
  const overviewWantRef = useRef(false);
  const overviewActiveRef = useRef(false);
  const overviewBusyRef = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const renderingRef = useRef(false);
  const engineRef = useRef<SceneEngine | null>(null);
  // Keep the acquired instance until release, including child teardown clearing engineRef.
  const playbackEngineRef = useRef<SceneEngine | null>(null);
  const liveCameraRef = useRef(project.camera);
  const projectRef = useRef(project);
  const leavingRef = useRef(false);
  const saves = useMemo(() => new ProjectSaveCoordinator<SceneWorkspace>(workspaces), [workspaces]);
  const [saveState, setSaveState] = useState(() => saves.getState());
  const playFrameRef = useRef(0);
  const playStartRef = useRef(0);
  const playheadRef = useRef(0);
  const progressRef = useRef<HTMLDivElement>(null);
  const progressTrackRef = useRef<HTMLDivElement>(null);
  const progressTimeRef = useRef<HTMLOutputElement>(null);
  const lastPlaybackUiRef = useRef(0);

  const activeShot = project.shots.find((shot) => shot.id === activeShotId) ?? null;
  const currentShot = () =>
    projectRef.current.shots.find((shot) => shot.id === activeShotIdRef.current) ?? null;
  const setActiveShotId = (id: string | null) => {
    activeShotIdRef.current = id;
    setActiveShotIdState(id);
  };
  const setAtKeyframeId = (id: string | null) => {
    if (atKeyframeRef.current === id) return;
    atKeyframeRef.current = id;
    setAtKeyframeIdState(id);
  };

  const setStage = (next: SceneStage) => {
    if (next === stage) {
      setPanelExpanded((expanded) => !expanded);
      return;
    }
    tapHaptic();
    setPanelExpanded(false);
    navigation.update({
      name: "scene",
      projectId: project.id,
      sceneId: project.projectSceneId,
      stage: next,
    });
  };

  const updateProject = useCallback(
    (patch: Partial<SceneWorkspace>, immediate = true) => {
      const next = { ...projectRef.current, ...patch, updatedAt: Date.now() };
      projectRef.current = next;
      setProject(next);
      saves.schedule(next);
      if (immediate) void saves.flush().catch(() => undefined);
      return next;
    },
    [saves],
  );

  useEffect(() => {
    const unsubscribe = saves.subscribe(setSaveState);
    // Persist the opened workspace too: a bundled scene may carry a refreshed descriptor.
    saves.schedule(projectRef.current);
    return () => {
      unsubscribe();
      void saves.flush().catch(() => undefined);
    };
  }, [saves]);

  /** The rig as the renderer has it now, which can be ahead of the throttled UI copy. */
  const readRig = useCallback(() => {
    const engine = engineRef.current;
    const camera = engine
      ? fromCameraState(engine.getCameraState(), liveCameraRef.current)
      : cloneCamera(liveCameraRef.current);
    liveCameraRef.current = camera;
    return camera;
  }, []);

  const snapshotCurrentProject = useCallback(
    () => updateProject({ camera: readRig() }, false),
    [readRig, updateProject],
  );

  const setCamera = useCallback(
    (camera: CinematicCamera) => {
      liveCameraRef.current = camera;
      applyEngineCamera(engineRef.current, camera);
      updateProject({ camera }, false);
    },
    [updateProject],
  );

  const syncTimeline = (time: number, duration: number) => {
    progressRef.current?.style.setProperty(
      "--playhead",
      String(duration > 0 ? time / duration : 0),
    );
    progressTrackRef.current?.setAttribute("aria-valuenow", String(time));
    if (progressTimeRef.current) progressTimeRef.current.value = formatTime(time);
  };

  /** Applies an undoable edit to the rig and/or the shot being edited. */
  const commitEdit = (
    patch: Partial<SceneWorkspace>,
    options: { playhead?: number; activeShotId?: string | null } = {},
  ) => {
    const rig = readRig();
    const before = cameraEditSnapshot(rig, currentShot(), playheadRef.current);
    if (options.activeShotId !== undefined) setActiveShotId(options.activeShotId);
    const next = updateProject({ camera: rig, ...patch }, false);
    const shot = next.shots.find((item) => item.id === activeShotIdRef.current) ?? null;
    const playhead = options.playhead ?? Math.min(playheadRef.current, shot?.durationSeconds ?? 0);
    history.record(before, cameraEditSnapshot(next.camera, shot, playhead));
    liveCameraRef.current = next.camera;
    applyEngineCamera(engineRef.current, next.camera);
    refreshHistory((value) => value + 1);
    return next;
  };

  const replaceShot = (shots: readonly Shot[], shot: Shot) =>
    shots.map((item) => (item.id === shot.id ? shot : item));

  /** Transforms the active shot; editing rules that refuse a change show their reason. */
  const editShot = (
    transform: (shot: Shot) => Shot,
    options: { camera?: CinematicCamera; playhead?: number } = {},
  ) => {
    const shot = currentShot();
    if (!shot) return null;
    let next: Shot;
    try {
      next = transform(shot);
    } catch (reason) {
      setShotError(reason instanceof Error ? reason.message : "That change could not be made.");
      return null;
    }
    setShotError("");
    commitEdit(
      {
        shots: replaceShot(projectRef.current.shots, next),
        ...(options.camera ? { camera: options.camera } : {}),
      },
      options.playhead === undefined ? {} : { playhead: options.playhead },
    );
    return next;
  };

  /** Rolling settings: zoom stays inside the shot's lens. */
  const patchCamera = (patch: Partial<CinematicCamera>) => {
    const rig = readRig();
    const lens = currentShot()?.setup.lens;
    const next = { ...rig, ...patch };
    if (lens) next.focalLengthMm = clampFocal(lens, next.focalLengthMm);
    commitEdit({ camera: next });
  };

  const setPlayhead = useCallback(
    (time: number) => {
      const shot =
        projectRef.current.shots.find((item) => item.id === activeShotIdRef.current) ?? null;
      const duration = shot?.durationSeconds ?? 0;
      const bounded = Math.max(0, Math.min(duration, time));
      playheadRef.current = bounded;
      const camera = cameraAt(shot, bounded, liveCameraRef.current);
      liveCameraRef.current = camera;
      applyEngineCamera(engineRef.current, camera);
      if (performance.now() - lastPlaybackUiRef.current >= 100 || bounded === duration) {
        updateProject({ camera }, false);
        lastPlaybackUiRef.current = performance.now();
      }
      if (shot) {
        const index = keyframeIndexAt(shot, bounded);
        const keyframeId = index >= 0 ? shot.keyframes[index]!.id : null;
        if (atKeyframeRef.current !== keyframeId) {
          atKeyframeRef.current = keyframeId;
          setAtKeyframeIdState(keyframeId);
        }
        const segment = shotSegmentAt(shot, bounded).index;
        setSelectedSegment(Math.min(segment, Math.max(0, shot.keyframes.length - 2)));
      }
      syncTimeline(bounded, duration);
      return camera;
    },
    [updateProject],
  );

  const stop = useCallback(
    (commit = true) => {
      cancelAnimationFrame(playFrameRef.current);
      const scrub = scrubRef.current;
      scrubRef.current = null;
      if (scrub?.element.hasPointerCapture?.(scrub.pointerId))
        scrub.element.releasePointerCapture(scrub.pointerId);
      setIsScrubbing(false);
      if (commit) setCamera(setPlayhead(playheadRef.current));
      playbackEngineRef.current?.setPlaybackActive(false);
      playbackEngineRef.current = null;
      setIsPlaying(false);
    },
    [setCamera, setPlayhead],
  );

  // Shot frames and the moving shot's path, drawn in the scene; never captured.
  const showMarkers = preferences.showShotMarkers;
  const { shots } = project;
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || sceneStatus !== "ready") return;
    engine.setPlanOverlay(planOverlayState({ shots }, activeShotId ?? undefined, activeShot));
  }, [shots, activeShotId, activeShot, sceneStatus]);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || sceneStatus !== "ready") return;
    engine.setPlanOverlayVisible((showMarkers || overviewOpen) && !isPlaying && !magicWindowActive);
  }, [showMarkers, overviewOpen, isPlaying, magicWindowActive, sceneStatus]);

  /**
   * Renders shot images from their first keyframe. It keeps updatedAt when only filling in
   * missing images: opening a scene is not an edit.
   */
  const renderThumbnails = useCallback(
    (targets: readonly Shot[], signal: AbortSignal) => {
      const engine = engineRef.current;
      if (!engine || targets.length === 0 || renderingRef.current) return Promise.resolve();
      renderingRef.current = true;
      setRendering(true);
      const ids = new Set(targets.map((shot) => shot.id));
      return (
        engine
          .captureStillsAt(
            targets.map((shot) => toCameraState(shotStartCamera(shot))),
            { maxSize: 480, signal },
          )
          .then((images) => {
            if (signal.aborted) return;
            const rendered = new Map(targets.map((shot, index) => [shot.id, images[index]]));
            const next = {
              ...projectRef.current,
              shots: projectRef.current.shots.map((shot) => {
                const thumbnailDataUrl = ids.has(shot.id) ? rendered.get(shot.id) : undefined;
                return thumbnailDataUrl ? { ...shot, thumbnailDataUrl } : shot;
              }),
            };
            projectRef.current = next;
            setProject(next);
            saves.schedule(next);
            void saves.flush().catch(() => undefined);
          })
          // Placeholders stay; the next time the scene opens it tries again.
          .catch(() => undefined)
          .finally(() => {
            renderingRef.current = false;
            if (signal.aborted) return;
            setRendering(false);
            // The capture restored the pose from when it began; keep any edit made since.
            applyEngineCamera(engineRef.current, liveCameraRef.current);
          })
      );
    },
    [saves],
  );

  // Shots without an image (the tutorial's, or ones whose image was lost) get one.
  useEffect(() => {
    if (sceneStatus !== "ready") return;
    const controller = new AbortController();
    void renderThumbnails(
      projectRef.current.shots.filter((shot) => !shot.thumbnailDataUrl),
      controller.signal,
    );
    return () => {
      controller.abort();
      setRendering(false);
    };
  }, [sceneStatus, renderThumbnails]);

  const refreshThumbnail = (shotId: string) => {
    const shot = projectRef.current.shots.find((item) => item.id === shotId);
    if (shot) void renderThumbnails([shot], new AbortController().signal);
  };

  const flushWithHaptic = async () => {
    try {
      await saves.flush();
      confirmHaptic();
    } catch {
      // The save status offers a retry without duplicating the change.
    }
  };

  const openShot = (shot: Shot) => {
    tapHaptic();
    stop(false);
    endEdit();
    setFocusArmed(false);
    commitEdit({ camera: shotCameraAt(shot, 0) }, { playhead: 0, activeShotId: shot.id });
    setPlayhead(0);
    setAtKeyframeId(shot.keyframes[0]!.id);
    setSelectedSegment(0);
  };

  const finishShot = () => {
    stop(false);
    endEdit();
    setFocusArmed(false);
    commitEdit({}, { activeShotId: null });
    setAtKeyframeId(null);
    tapHaptic();
  };

  /**
   * The shutter: saves what the viewfinder shows as a new shot at once, on the free
   * camera's lens as a prime. Its name, notes and lens can be changed afterwards.
   */
  const createShotFromRig = async () => {
    const engine = engineRef.current;
    if (!engine || sceneStatus !== "ready" || renderingRef.current || creating) return;
    setCreating(true);
    stop(false);
    endEdit();
    setFocusArmed(false);
    try {
      const rig = readRig();
      const name = nextShotName(projectRef.current.shots);
      const lens: ShotLens = { kind: "prime", focalLengthMm: Math.round(rig.focalLengthMm) };
      const framed: CinematicCamera = {
        ...rig,
        focalLengthMm: clampFocal(lens, rig.focalLengthMm),
      };
      applyEngineCamera(engine, framed);
      liveCameraRef.current = framed;
      const capture = engine.captureShot({ maxSize: 480 });
      const shot = createShot(
        project.scene,
        framed,
        {
          name,
          lens,
          sensorWidthMm: framed.sensorWidthMm,
          sensorHeightMm: framed.sensorHeightMm,
          aspectRatio: framed.output.aspectRatio,
        },
        capture.thumbnailDataUrl,
      );
      commitEdit(
        { camera: framed, shots: [...projectRef.current.shots, shot] },
        { playhead: 0, activeShotId: shot.id },
      );
      setPlayhead(0);
      setAtKeyframeId(shot.keyframes[0]!.id);
      setSelectedSegment(0);
      setSavedPulse((value) => value + 1);
      setSavedNotice(shot.name);
      setShotError("");
    } catch (reason) {
      setShotError(
        reason instanceof Error
          ? `The shot could not be saved: ${reason.message}`
          : "The shot could not be saved. Try again.",
      );
      return;
    } finally {
      setCreating(false);
    }
    await flushWithHaptic();
  };

  /** Renames or annotates the open shot from the Notes section. */
  const changeShotText = (patch: { name?: string; notes?: string }, commit: boolean) => {
    const id = activeShotIdRef.current;
    if (!id) return;
    updateProject(
      {
        shots: projectRef.current.shots.map((shot) =>
          shot.id === id ? { ...shot, ...patch } : shot,
        ),
      },
      commit,
    );
  };

  /** Adds a keyframe: at the playhead between keyframes, otherwise after the last one. */
  const addKeyframe = async () => {
    const shot = currentShot();
    if (!shot || sceneStatus !== "ready" || renderingRef.current) return;
    stop(false);
    endEdit();
    const rig = readRig();
    const onKeyframe = keyframeIndexAt(shot, playheadRef.current) >= 0;
    const id = newKeyframeId();
    const next = editShot(
      (current) =>
        onKeyframe || playheadRef.current >= current.keyframes.at(-1)!.timeSeconds
          ? appendKeyframe(current, id, rig)
          : setKeyframeAt(current, playheadRef.current, id, rig),
      { camera: rig },
    );
    if (!next) return;
    const time = next.keyframes.find((frame) => frame.id === id)?.timeSeconds ?? 0;
    playheadRef.current = time;
    setAtKeyframeId(id);
    syncTimeline(time, next.durationSeconds);
    setSelectedSegment(Math.max(0, next.keyframes.findIndex((frame) => frame.id === id) - 1));
    setSavedPulse((value) => value + 1);
    await flushWithHaptic();
  };

  /** Records the rig into the keyframe under the playhead. */
  const updateCurrentKeyframe = async () => {
    const shot = currentShot();
    const keyframeId = atKeyframeRef.current;
    if (!shot || !keyframeId || sceneStatus !== "ready" || renderingRef.current) return;
    stop(false);
    endEdit();
    const rig = readRig();
    const next = editShot((current) => updateKeyframe(current, keyframeId, rig), {
      camera: rig,
    });
    if (!next) return;
    if (next.keyframes[0]!.id === keyframeId) refreshThumbnail(next.id);
    setSavedPulse((value) => value + 1);
    await flushWithHaptic();
  };

  const selectKeyframe = (id: string) => {
    const shot = currentShot();
    const frame = shot?.keyframes.find((item) => item.id === id);
    if (!frame) return;
    stop(false);
    endEdit();
    setCamera(setPlayhead(frame.timeSeconds));
  };

  const deleteKeyframe = (id: string) => {
    const wasFirst = currentShot()?.keyframes[0]?.id === id;
    const next = editShot((shot) => removeKeyframe(shot, id));
    if (!next) return;
    setCamera(setPlayhead(Math.min(playheadRef.current, next.durationSeconds)));
    if (wasFirst) refreshThumbnail(next.id);
  };

  const changeKeyframeTime = (id: string, seconds: number) => {
    const next = editShot((shot) => setKeyframeTime(shot, id, seconds));
    if (next) setCamera(setPlayhead(next.keyframes.find((k) => k.id === id)?.timeSeconds ?? 0));
  };

  const changeLength = (seconds: number) => {
    const shot = currentShot();
    if (!shot) return;
    if (!Number.isFinite(seconds)) return;
    // The playhead keeps its place in the shot, so undo and redo return to it too.
    const target = (playheadRef.current / shot.durationSeconds) * clampShotDuration(seconds);
    const next = editShot((current) => retimeShot(current, seconds), { playhead: target });
    if (next) setCamera(setPlayhead(target));
  };

  const changeLens = (lens: ShotLens) => {
    const rig = readRig();
    const next = editShot((shot) => setShotLens(shot, lens).shot, {
      camera: { ...rig, focalLengthMm: clampFocal(lens, rig.focalLengthMm) },
    });
    if (next) refreshThumbnail(next.id);
  };

  const changeSetup = (
    patch: Partial<Pick<ShotSetup, "sensorWidthMm" | "sensorHeightMm">> & { aspectRatio?: number },
  ) => {
    const rig = readRig();
    const { aspectRatio, ...sensor } = patch;
    const output =
      aspectRatio === undefined
        ? rig.output
        : { aspectRatio, crop: "center-inside-sensor" as const };
    const next = editShot(
      (shot) => ({
        ...shot,
        setup: {
          ...shot.setup,
          ...sensor,
          ...(aspectRatio === undefined ? {} : { output }),
        },
      }),
      { camera: { ...rig, ...sensor, output } },
    );
    if (next) refreshThumbnail(next.id);
  };

  const play = () => {
    const shot = currentShot();
    const engine = engineRef.current;
    if (
      !engine ||
      !shot ||
      leavingRef.current ||
      shot.keyframes.length < 2 ||
      sceneStatus !== "ready" ||
      renderingRef.current
    )
      return;
    cancelAnimationFrame(playFrameRef.current);
    endEdit();
    setFocusArmed(false);
    const end = shot.durationSeconds;
    if (playheadRef.current >= end) playheadRef.current = 0;
    engine.setPlaybackActive(true);
    playbackEngineRef.current = engine;
    setIsPlaying(true);
    setPlayhead(playheadRef.current);
    playStartRef.current = performance.now() - playheadRef.current * 1000;
    const tick = (now: number) => {
      const elapsed = (now - playStartRef.current) / 1000;
      if (elapsed >= end) {
        setPlayhead(end);
        stop(true);
        return;
      }
      setPlayhead(elapsed);
      playFrameRef.current = requestAnimationFrame(tick);
    };
    playFrameRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const persist = () => {
      // Resume requires an explicit Play; elapsed background time must not jump the camera.
      stop(false);
      // Export temporarily owns the renderer camera. Persist the last editor
      // snapshot; capture will restore it after its cancellation completes.
      if (!exportOpen) snapshotCurrentProject();
      void saves.flush().catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") persist();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", persist);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", persist);
    };
  }, [saves, snapshotCurrentProject, stop, exportOpen]);

  useEffect(
    () => () => {
      cancelAnimationFrame(playFrameRef.current);
      playbackEngineRef.current?.setPlaybackActive(false);
      playbackEngineRef.current = null;
    },
    [],
  );

  const restoreHistory = useCallback(
    (direction: "undo" | "redo") => {
      stop(false);
      const snapshot = history[direction]();
      if (!snapshot) return;
      const { camera, shot } = snapshot;
      const current = projectRef.current.shots;
      const exists = shot && current.some((item) => item.id === shot.id);
      activeShotIdRef.current = exists ? shot.id : null;
      setActiveShotIdState(activeShotIdRef.current);
      updateProject({ camera, ...(exists ? { shots: replaceShot(current, shot) } : {}) });
      liveCameraRef.current = camera;
      applyEngineCamera(engineRef.current, camera);
      playheadRef.current = snapshot.playheadSeconds;
      if (exists) {
        const index = keyframeIndexAt(shot, snapshot.playheadSeconds);
        setAtKeyframeId(index >= 0 ? shot.keyframes[index]!.id : null);
        syncTimeline(snapshot.playheadSeconds, shot.durationSeconds);
      } else setAtKeyframeId(null);
      refreshHistory((value) => value + 1);
    },
    [history, stop, updateProject],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        sceneStatus === "loading" ||
        leaving ||
        isPlaying ||
        isScrubbing ||
        editingShotId ||
        exportOpen
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '[inert], [aria-modal="true"]:not(.expanded-graph), input:not([type="range"]), textarea, [contenteditable="true"]',
        )
      )
        return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      event.preventDefault();
      restoreHistory(key === "y" || event.shiftKey ? "redo" : "undo");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [restoreHistory, sceneStatus, leaving, isPlaying, isScrubbing, editingShotId, exportOpen]);

  const retrySave = async () => {
    snapshotCurrentProject();
    try {
      await saves.flush();
    } catch {
      /* The status exposes the error and retry. */
    }
  };

  /** Stops playback and commits every edit; false keeps the user here with the error visible. */
  const settle = useCallback(async (): Promise<boolean> => {
    if (leavingRef.current) return false;
    leavingRef.current = true;
    setLeaving(true);
    stop(false);
    engineRef.current?.stop();
    snapshotCurrentProject();
    try {
      await saves.flush();
      void refreshLibrary();
      return true;
    } catch {
      leavingRef.current = false;
      setLeaving(false);
      engineRef.current?.start();
      return false;
    }
  }, [refreshLibrary, saves, snapshotCurrentProject, stop]);

  useLeaveGuard(settle);

  const openShotPlan = async () => {
    if (!(await settle())) return;
    navigation.push({ name: "shotplan", projectId: project.id, sceneId: project.projectSceneId });
  };

  const transport: Transport = {
    isPlaying,
    isScrubbing,
    playheadRef,
    progressRef,
    progressTrackRef,
    progressTimeRef,
    play,
    stop,
    setPlayhead,
    scrubTo: (time) => {
      stop(false);
      engineRef.current?.setPlaybackActive(true);
      setCamera(setPlayhead(time));
      engineRef.current?.setPlaybackActive(false);
    },
    commitPlayhead: (time) => setCamera(setPlayhead(time)),
    beginScrub: (element, pointerId) => {
      stop(false);
      endEdit();
      const engine = engineRef.current;
      engine?.setPlaybackActive(true);
      playbackEngineRef.current = engine;
      scrubRef.current = { element, pointerId };
      setIsScrubbing(true);
    },
    finishScrub: () => {
      if (scrubRef.current) stop(true);
    },
    isScrubPointer: (pointerId) => scrubRef.current?.pointerId === pointerId,
  };

  useEffect(() => {
    const engine = engineRef.current;
    if (sceneStatus !== "ready" || !engine?.onMapViewChange) return;
    void engine.preloadMapView?.().catch(() => undefined);
    return engine.onMapViewChange(({ phase, azimuth }) => {
      setMapPhase(phase);
      compassRef.current?.style.setProperty("--azimuth", `${-azimuth}rad`);
    });
  }, [sceneStatus]);

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const openMap = async () => {
    const engine = engineRef.current;
    if (!engine || mapBusyRef.current || mapOpen || overviewActiveRef.current) return;
    mapBusyRef.current = true;
    setFocusArmed(false);
    setPanelExpanded(false);
    setMapOpen(true);
    setLetterbox("closed");
    setMapPhase("entering");
    tapHaptic();
    try {
      // Let the viewer go full bleed before the engine measures the frame hand-off.
      await nextFrame();
      await nextFrame();
      const scale = project.scene.metricScale;
      setRoofCut(engine.canCutAway ? engine.mapCutaway === "auto" : null);
      const entering = engine.enterMapView({
        ...(scale.status === "known" ? { eyeHeight: 1.6 / scale.metersPerSceneUnit } : {}),
        reduceMotion: prefersReducedMotion(),
        frameHeightFraction: frameFractionRef.current,
      });
      // Open the letterbox only once the map camera is rendering.
      for (let frame = 0; frame < 120 && !engine.isMapViewActive; frame += 1) await nextFrame();
      setLetterbox("open");
      await entering;
    } catch (reason) {
      setShotError(reason instanceof Error ? reason.message : "The map could not open.");
      setMapOpen(false);
      setMapPhase("off");
    } finally {
      mapBusyRef.current = false;
    }
  };

  /** Dives into the cinematographer; the landing is one undoable camera edit. */
  const goToMannequin = async () => {
    const engine = engineRef.current;
    if (!engine?.map || mapBusyRef.current || engine.map.phase !== "placed") return;
    mapBusyRef.current = true;
    confirmHaptic();
    const before = readRig();
    setLetterbox("closed");
    try {
      const state = await engine.teleportToMannequin();
      const landed = fromCameraState(state, before);
      liveCameraRef.current = before;
      applyEngineCamera(engine, before);
      patchCamera({ pose: landed.pose });
    } catch (reason) {
      setShotError(reason instanceof Error ? reason.message : "Could not move there.");
    } finally {
      setMapOpen(false);
      setMapPhase("off");
      mapBusyRef.current = false;
    }
  };

  const closeMap = async () => {
    const engine = engineRef.current;
    if (mapBusyRef.current) return;
    mapBusyRef.current = true;
    setLetterbox("closed");
    try {
      await engine?.exitMapView();
    } finally {
      setMapOpen(false);
      setMapPhase("off");
      mapBusyRef.current = false;
    }
  };

  /**
   * Opens or closes the Shots overview to match what the Shots tab wants, one
   * transition at a time (a close requested mid-rise waits for the rise to land).
   */
  const syncOverview = async () => {
    const engine = engineRef.current;
    if (!engine || overviewBusyRef.current) return;
    overviewBusyRef.current = true;
    try {
      for (;;) {
        const want = overviewWantRef.current;
        if (want && !overviewActiveRef.current) {
          if (mapBusyRef.current || engine.isMapViewActive) break;
          setOverviewOpen(true);
          setLetterbox("closed");
          // Let the viewer go full bleed before the engine measures the frame hand-off.
          // A timer rather than animation frames, so a tab switched straight past
          // Shots leaves nothing waiting on the render loop.
          await new Promise((resolve) => setTimeout(resolve, OVERVIEW_LAYOUT_MS));
          if (!overviewWantRef.current || !engineRef.current) {
            setOverviewOpen(false);
            continue;
          }
          overviewActiveRef.current = true;
          try {
            const entering = engine.enterMapView({
              figure: false,
              reduceMotion: prefersReducedMotion(),
              frameHeightFraction: frameFractionRef.current,
            });
            setLetterbox("open");
            await entering;
          } catch {
            // The overview is a nicety; the list below still works without it.
            overviewActiveRef.current = false;
            setOverviewOpen(false);
            break;
          }
        } else if (!want && overviewActiveRef.current) {
          setLetterbox("closed");
          try {
            await engine.exitMapView();
          } finally {
            overviewActiveRef.current = false;
            setOverviewOpen(false);
            setOverviewHighlight(null);
          }
        } else break;
      }
    } finally {
      overviewBusyRef.current = false;
    }
  };

  const overviewWanted =
    stage === "shots" &&
    sceneStatus === "ready" &&
    !rendering &&
    !exportOpen &&
    !leaving &&
    !mapOpen &&
    project.shots.length > 0;
  useEffect(() => {
    overviewWantRef.current = overviewWanted;
    // syncOverview reads everything it needs through refs.
    void syncOverview();
  }, [overviewWanted]);

  const busyControls = isPlaying || isScrubbing || exportOpen || sceneStatus === "loading";
  const sceneReady = sceneStatus === "ready" && !rendering;

  // The sticks, drag and keyboard move the rig only while nothing else owns the camera.
  const navigationAllowed =
    sceneStatus === "ready" && !busyControls && !leaving && !creating && !focusArmed;
  useEffect(() => {
    engineRef.current?.setNavigationEnabled(navigationAllowed);
  }, [navigationAllowed, sceneStatus]);
  useEffect(() => {
    const engine = engineRef.current;
    if (engine) engine.navigation.speedMultiplier = WALK_SPEEDS[preferences.walkSpeed];
  }, [preferences.walkSpeed, sceneStatus]);
  const drive: NavigationDriver = (input) => engineRef.current?.navigation.setInput(input);

  const includedCount = project.shots.filter(
    (shot) => !project.shotSheet?.excludedShotIds.includes(shot.id),
  ).length;
  const editingShot = editingShotId
    ? project.shots.find((item) => item.id === editingShotId)
    : undefined;
  const videoShots = (videoShotIds ?? []).flatMap((id) => {
    const shot = project.shots.find((item) => item.id === id);
    return shot ? [shot] : [];
  });
  const rigChanged =
    activeShot !== null &&
    atKeyframeId !== null &&
    !rigMatchesKeyframe(activeShot, atKeyframeId, project.camera);
  const atKeyframeIndex = activeShot?.keyframes.findIndex((frame) => frame.id === atKeyframeId);
  const showSticks =
    !mapOpen &&
    stage === "compose" &&
    preferences.showJoysticks &&
    sceneStatus === "ready" &&
    !isPlaying &&
    !magicWindowActive;
  const fabDisabled = !sceneReady || isPlaying || isScrubbing;
  const lastThumbnail = project.shots.at(-1)?.thumbnailDataUrl;

  return (
    <div
      className="screen workspace-screen"
      data-appearance="dark"
      data-stage={stage}
      data-expanded={panelExpanded}
      data-sticks={showSticks}
      data-map={mapOpen}
      data-overview={overviewOpen}
      inert={leaving}
    >
      <section
        ref={viewportRef}
        className="workspace-viewport"
        onPointerDown={(event) => {
          tapRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
        }}
        onPointerUp={(event) => {
          const tap = tapRef.current;
          tapRef.current = null;
          // A quick, still tap focuses (when armed) or opens a shot's marker; drags look.
          if (
            !tap ||
            mapOpen ||
            overviewOpen ||
            busyControls ||
            event.timeStamp - tap.at > 350 ||
            Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8 ||
            !(event.target instanceof HTMLCanvasElement)
          )
            return;
          if (focusArmed) {
            const distance = engineRef.current?.pickFocusDistance(event.clientX, event.clientY);
            setFocusArmed(false);
            if (distance === undefined) {
              setShotError("Nothing to focus on there. Tap a surface in the scene.");
              return;
            }
            setShotError("");
            tapHaptic();
            patchCamera({ focusDistanceM: Number(distance.toFixed(2)) });
            return;
          }
          if (!showMarkers) return;
          const id = engineRef.current?.pickShotMarker(event.clientX, event.clientY);
          const rect = viewportRef.current?.getBoundingClientRect();
          setCallout(
            id && id !== activeShotIdRef.current
              ? {
                  id,
                  x: event.clientX - (rect?.left ?? 0),
                  y: event.clientY - (rect?.top ?? 0),
                }
              : null,
          );
        }}
      >
        <SceneViewer
          key={`scene-${sceneAttempt}`}
          descriptor={project.scene}
          resolveScene={resolveScene}
          camera={project.camera}
          liveCameraRef={liveCameraRef}
          showGrid={project.settings.showGrid}
          showSafeFrame={project.settings.showSafeFrame}
          engineRef={engineRef}
          fullBleed={mapOpen || overviewOpen}
          letterbox={letterbox}
          onFrameFraction={(fraction) => {
            frameFractionRef.current = fraction;
          }}
          onReady={() => {
            setSceneStatus("ready");
            setLoadProgress(null);
          }}
          onError={(message) => {
            setSceneStatus("error");
            setSceneError(message);
            setLoadProgress(null);
          }}
          onProgress={setLoadProgress}
          onCameraChange={(camera) => {
            if (!leavingRef.current) updateProject({ camera }, false);
          }}
        />

        <header className="workspace-topbar">
          <button
            className="icon-btn icon-btn--overlay"
            aria-label="Back to project"
            onClick={() => void navigation.pop()}
          >
            <ChevronLeft size={28} strokeWidth={2.2} />
          </button>
          <button
            className="workspace-title"
            aria-label="Choose shot"
            aria-haspopup="menu"
            disabled={project.shots.length === 0}
            onClick={() => setOverlay("library")}
          >
            <strong>
              {activeShot ? activeShot.name : project.projectSceneName}
              {project.shots.length > 0 && <ChevronDown size={14} aria-hidden="true" />}
            </strong>
            <small role="status">
              {saveState.status === "saved"
                ? activeShot
                  ? shotKindLabel(activeShot)
                  : "Free camera"
                : saveState.status === "error"
                  ? "Not saved"
                  : "Saving…"}
            </small>
          </button>
          <div className="workspace-topbar__tools">
            <button
              className="icon-btn icon-btn--overlay"
              aria-label="Undo camera edit"
              title="Undo (⌘/Ctrl Z)"
              disabled={!history.canUndo || isPlaying || isScrubbing || sceneStatus === "loading"}
              onClick={() => restoreHistory("undo")}
            >
              <Undo2 size={18} />
            </button>
            <button
              className="icon-btn icon-btn--overlay"
              aria-label="Redo camera edit"
              title="Redo (⌘/Ctrl Shift Z)"
              disabled={!history.canRedo || isPlaying || isScrubbing || sceneStatus === "loading"}
              onClick={() => restoreHistory("redo")}
            >
              <Redo2 size={18} />
            </button>
            {stage === "compose" && (
              <>
                <button
                  className="icon-btn icon-btn--overlay workspace-map-btn"
                  aria-label="Map"
                  title="Map"
                  disabled={!navigationAllowed || !sceneReady || magicWindowActive || busyControls}
                  onClick={() => void openMap()}
                >
                  <MapIcon size={20} />
                </button>
                <button
                  className="icon-btn icon-btn--overlay"
                  aria-label="View options"
                  aria-haspopup="menu"
                  disabled={busyControls}
                  onClick={() => setOverlay("more")}
                >
                  <Ellipsis size={20} />
                </button>
              </>
            )}
          </div>
        </header>

        {stage === "compose" && sceneStatus === "ready" && (
          <p className="camera-hud" aria-live="off">
            {displayCameraValue(project.camera.focalLengthMm)}mm ·{" "}
            {formatFStop(project.camera.apertureFStop ?? 2.8)} · focus{" "}
            {displayCameraValue(project.camera.focusDistanceM ?? 3)} m
            {activeShot && atKeyframeIndex !== undefined && atKeyframeIndex >= 0
              ? ` · keyframe ${atKeyframeIndex + 1}${rigChanged ? " (changed)" : ""}`
              : ""}
          </p>
        )}
        {focusArmed && (
          <>
            <div className="focus-reticle" aria-hidden="true">
              <span />
            </div>
            <div className="workspace-banner" role="status">
              Tap the subject to focus
              <button
                className="btn btn--small btn--secondary"
                onClick={() => setFocusArmed(false)}
              >
                Cancel
              </button>
            </div>
          </>
        )}
        {callout &&
          (() => {
            const shot = project.shots.find((item) => item.id === callout.id);
            if (!shot) return null;
            return (
              <div
                className="marker-callout"
                key={callout.id}
                style={
                  {
                    left: callout.x,
                    top: callout.y,
                    "--callout-ms": `${CALLOUT_MS}ms`,
                  } as CSSProperties
                }
                onAnimationEnd={(event) => {
                  if (event.animationName === "callout-timeout") setCallout(null);
                }}
              >
                <span>{shot.name}</span>
                <button
                  className="btn btn--small btn--primary"
                  aria-label={`Open ${shot.name}`}
                  onClick={() => {
                    setCallout(null);
                    openShot(shot);
                  }}
                >
                  Open
                </button>
              </div>
            );
          })()}
        {savedNotice && !shotError && saveState.status !== "error" && (
          <div
            className="workspace-toast workspace-toast--pill"
            role="status"
            key={`notice-${savedPulse}`}
            onAnimationEnd={(event) => {
              if (event.animationName === "toast-timeout") setSavedNotice(null);
            }}
          >
            <span>{savedNotice} saved</span>
            <button
              className="btn btn--small btn--link"
              onClick={() => {
                setSavedNotice(null);
                setComposeTab("notes");
                setPanelExpanded(true);
              }}
            >
              Add notes
            </button>
          </div>
        )}

        {(saveState.status === "error" || shotError) && (
          <div className="workspace-toast" role="alert">
            <span>
              {saveState.status === "error"
                ? `Changes are not saved on this device. ${saveState.error ?? "Try saving again."}`
                : shotError}
            </span>
            {saveState.status === "error" && (
              <button className="btn btn--small btn--secondary" onClick={() => void retrySave()}>
                Retry save
              </button>
            )}
            {shotError && (
              <button
                className="icon-btn"
                onClick={() => setShotError("")}
                aria-label="Dismiss message"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
        {sceneStatus === "loading" && (
          <div className="scene-status">
            <span className="loader" /> Developing scene
            {loadProgress && (
              <span className="load-progress">
                {loadProgress.fraction !== undefined
                  ? `${Math.round(loadProgress.fraction * 100)}%`
                  : `${(loadProgress.loadedBytes / (1024 * 1024)).toFixed(1)} MB`}
              </span>
            )}
            {loadProgress?.fraction !== undefined && (
              <span className="load-bar">
                <i style={{ width: `${loadProgress.fraction * 100}%` }} />
              </span>
            )}
          </div>
        )}
        {sceneStatus === "error" && (
          <div className="scene-status error">
            <span>{sceneError}</span>
            <button
              className="btn btn--small btn--secondary"
              onClick={() => {
                setSceneError("");
                setSceneStatus("loading");
                setSceneAttempt((attempt) => attempt + 1);
              }}
            >
              Retry scene
            </button>
          </div>
        )}
        {magicWindowActive && <span className="badge badge--accent handheld-badge">Handheld</span>}
        {stage === "compose" && sceneStatus === "ready" && (
          <MagicWindowControls
            engineRef={engineRef}
            disabled={isPlaying || isScrubbing || leaving || exportOpen}
            translationScale={
              project.scene.metricScale.status === "known"
                ? 1 / project.scene.metricScale.metersPerSceneUnit
                : 1
            }
            onActiveChange={(active) => {
              setMagicWindowActive(active);
              if (active) setPanelExpanded(false);
            }}
          />
        )}
        {showSticks && <Joysticks drive={drive} disabled={!navigationAllowed} />}
        {mapOpen && (
          <MapMode
            controls={mapPhase === "off" ? undefined : engineRef.current?.map}
            phase={mapPhase}
            viewportRef={viewportRef}
            compassRef={compassRef}
            reduceMotion={prefersReducedMotion()}
            cutaway={
              roofCut === null
                ? undefined
                : {
                    on: roofCut,
                    onToggle: () => {
                      const next = !roofCut;
                      engineRef.current?.setMapCutaway?.(next ? "auto" : "off", {
                        reduceMotion: prefersReducedMotion(),
                      });
                      setRoofCut(next);
                    },
                  }
            }
            onGo={() => void goToMannequin()}
            onClose={() => void closeMap()}
          />
        )}
        {overviewOpen && (
          <ShotsOverview
            engineRef={engineRef}
            phase={mapPhase}
            shots={project.shots}
            activeShotId={activeShotId}
            highlightId={overviewHighlight}
            disabled={busyControls}
            onOpen={(shot) => {
              openShot(shot);
              setStage("compose");
            }}
          />
        )}
        {stage === "compose" && activeShot && (
          <div className="scene-progress-dock">
            <SceneProgress
              shot={activeShot}
              transport={transport}
              sceneReady={sceneReady}
              atKeyframeId={atKeyframeId}
              onSelectKeyframe={selectKeyframe}
            />
          </div>
        )}
        {stage === "compose" && (
          <div className="capture-bar" data-shot={activeShot !== null}>
            {activeShot && rigChanged && atKeyframeIndex !== undefined && atKeyframeIndex >= 0 && (
              <button
                className="capsule-btn capsule-btn--overlay capture-bar__update"
                disabled={fabDisabled}
                onClick={() => void updateCurrentKeyframe()}
              >
                <RefreshCcw size={16} /> Update keyframe {atKeyframeIndex + 1}
              </button>
            )}
            <div className="capture-bar__row">
              <button
                className="capture-bar__library"
                aria-label="Shot library"
                disabled={project.shots.length === 0 || busyControls}
                onClick={() => setOverlay("library")}
              >
                {lastThumbnail ? (
                  <img src={lastThumbnail} alt="" />
                ) : (
                  <Images size={20} aria-hidden="true" />
                )}
                {project.shots.length > 0 && <i>{project.shots.length}</i>}
              </button>
              <div className="capture-bar__shutter-wrap">
                <button
                  key={`save-${savedPulse}`}
                  className={`shutter${activeShot ? " shutter--keyframe" : ""}${savedPulse ? " did-save" : ""}`}
                  aria-label={activeShot ? "Add keyframe" : "New shot"}
                  aria-busy={creating}
                  disabled={fabDisabled || creating}
                  onClick={() => void (activeShot ? addKeyframe() : createShotFromRig())}
                >
                  <span className="shutter__core" aria-hidden="true">
                    {activeShot ? <i className="shutter__diamond" /> : null}
                  </span>
                </button>
                <span className="capture-bar__label" aria-hidden="true">
                  {activeShot ? "Add keyframe" : "New shot"}
                </span>
              </div>
              {activeShot ? (
                <button
                  className="capture-bar__side"
                  aria-label="New shot"
                  disabled={fabDisabled || creating}
                  onClick={() => void createShotFromRig()}
                >
                  <Plus size={22} strokeWidth={2.4} />
                </button>
              ) : (
                <span className="capture-bar__side capture-bar__side--empty" aria-hidden="true" />
              )}
            </div>
          </div>
        )}
      </section>

      <section className="stage-panel" aria-label={`${stage} tools`}>
        <button
          className="stage-grabber"
          aria-label={panelExpanded ? "Collapse tools" : "Expand tools"}
          aria-expanded={panelExpanded}
          onClick={() => setPanelExpanded((expanded) => !expanded)}
        >
          <span />
        </button>
        <div className="stage-content" key={stage}>
          {stage === "compose" && (
            <ComposePanel
              project={project}
              shot={activeShot}
              sceneReady={sceneReady}
              disabled={busyControls}
              transport={transport}
              atKeyframeId={atKeyframeId}
              selectedSegment={selectedSegment}
              error=""
              leaving={leaving}
              exportOpen={exportOpen}
              focusArmed={focusArmed}
              tab={composeTab}
              onTabChange={setComposeTab}
              onShotText={changeShotText}
              history={{
                canUndo: history.canUndo,
                canRedo: history.canRedo,
                restore: restoreHistory,
              }}
              drive={drive}
              onArmFocus={setFocusArmed}
              onBeginEdit={beginEdit}
              onEndEdit={endEdit}
              onPatchCamera={patchCamera}
              onUpdate={updateProject}
              onEditShot={(transform) => void editShot(transform)}
              onDeleteKeyframe={deleteKeyframe}
              onKeyframeTime={changeKeyframeTime}
              onLength={changeLength}
              onSegmentChange={setSelectedSegment}
              onSetLens={changeLens}
              onSetSetup={changeSetup}
              onDone={finishShot}
            />
          )}
          {stage === "shots" && (
            <ShotsPanel
              project={project}
              disabled={busyControls}
              view={preferences.shotsView}
              onViewChange={(shotsView) => void services.updatePreferences({ shotsView })}
              onOpen={(shot) => {
                openShot(shot);
                setStage("compose");
              }}
              onEdit={setEditingShotId}
              onReorder={(id, direction) =>
                updateProject({ shots: reorderShot(projectRef.current, id, direction) })
              }
              onIncludedChange={(id, included) =>
                updateProject({ shotSheet: setShotIncluded(projectRef.current, id, included) })
              }
              onCompose={() => setStage("compose")}
              onHighlight={setOverviewHighlight}
            />
          )}
          {stage === "export" && (
            <ExportPanel
              project={project}
              includedCount={includedCount}
              sceneReady={sceneReady}
              busy={exportOpen || isScrubbing || overviewOpen}
              activeShotId={activeShotId}
              onFlush={async () => {
                snapshotCurrentProject();
                await saves.flush();
                return projectRef.current;
              }}
              onOpenShotPlan={() => void openShotPlan()}
              onOpenVideo={(shotIds) => {
                if (renderingRef.current || shotIds.length === 0) return;
                stop(false);
                endEdit();
                snapshotCurrentProject();
                setVideoShotIds(shotIds);
              }}
              onShowShots={() => setStage("shots")}
            />
          )}
        </div>
        <nav className="stage-tabs" role="tablist" aria-label="Workspace stages">
          {STAGES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={stage === id}
              className={stage === id ? "is-active" : undefined}
              onClick={() => setStage(id)}
            >
              <Icon size={20} />
              <span>{label}</span>
              {id === "shots" && project.shots.length > 0 && (
                <i key={project.shots.length} className="tab-count">
                  {project.shots.length}
                </i>
              )}
            </button>
          ))}
        </nav>
      </section>

      {videoShots.length > 0 && engineRef.current && (
        <Suspense
          fallback={
            <Sheet title="Preparing export" onClose={() => setVideoShotIds(null)}>
              <p role="status">Loading video tools…</p>
            </Sheet>
          }
        >
          <VideoExportDialog
            engine={engineRef.current}
            shots={videoShots}
            projectName={`${project.name} ${project.projectSceneName}`}
            attribution={project.scene.attribution}
            onClose={() => setVideoShotIds(null)}
          />
        </Suspense>
      )}

      {editingShot && (
        <ShotEditSheet
          shot={editingShot}
          onSave={(patch) => {
            updateProject({
              shots: projectRef.current.shots.map((shot) =>
                shot.id === editingShot.id ? { ...shot, ...patch } : shot,
              ),
            });
            setEditingShotId(null);
          }}
          onDelete={() => {
            if (activeShotIdRef.current === editingShot.id) {
              stop(false);
              setActiveShotId(null);
              setAtKeyframeId(null);
            }
            updateProject(deleteShotFromProject(projectRef.current, editingShot.id));
            setEditingShotId(null);
          }}
          onDuplicate={() => {
            const shots = [...projectRef.current.shots];
            const index = shots.findIndex((shot) => shot.id === editingShot.id);
            shots.splice(index + 1, 0, {
              ...structuredClone(editingShot),
              id: makeId(),
              name: `${editingShot.name} (copy)`,
              createdAt: new Date().toISOString(),
            });
            updateProject({ shots });
            setEditingShotId(null);
          }}
          onClose={() => setEditingShotId(null)}
        />
      )}

      {overlay === "library" && (
        <ActionSheet
          title="Open shot"
          onClose={() => setOverlay(null)}
          actions={[
            ...(activeShot
              ? [
                  {
                    label: "Free camera",
                    icon: <Camera size={18} />,
                    onSelect: finishShot,
                  },
                ]
              : []),
            ...project.shots.map((shot, index) => ({
              label: `${index + 1}. ${shot.name} · ${shotKindLabel(shot)} · ${lensLabel(shot.setup.lens)}`,
              icon: shot.thumbnailDataUrl ? (
                <img className="action-thumb" src={shot.thumbnailDataUrl} alt="" />
              ) : (
                <Camera size={18} />
              ),
              onSelect: () => {
                openShot(shot);
                if (stage !== "compose") setStage("compose");
              },
            })),
          ]}
        />
      )}
      {overlay === "more" && (
        <ActionSheet
          title="View options"
          onClose={() => setOverlay(null)}
          actions={[
            {
              label: `Aspect ratio · ${aspectLabel(project.camera.output.aspectRatio)}`,
              icon: <Crop size={18} />,
              onSelect: () => setOverlay("aspect"),
            },
            {
              label: `Walking speed · ${WALK_LABELS[preferences.walkSpeed]}`,
              icon: <Footprints size={18} />,
              onSelect: () => setOverlay("walk"),
            },
            {
              label: preferences.showJoysticks ? "Hide thumb sticks" : "Show thumb sticks",
              icon: <Gamepad2 size={18} />,
              onSelect: () =>
                void services.updatePreferences({ showJoysticks: !preferences.showJoysticks }),
            },
            {
              label: showMarkers ? "Hide shots in scene" : "Show shots in scene",
              icon: showMarkers ? <EyeOff size={18} /> : <Eye size={18} />,
              onSelect: () => void services.updatePreferences({ showShotMarkers: !showMarkers }),
            },
            {
              label: "Reset camera position",
              icon: <RotateCcw size={18} />,
              onSelect: () => {
                const initialCamera = initialCameraForScene(project.scene, preferences.camera);
                patchCamera(
                  activeShot
                    ? { pose: initialCamera.pose }
                    : {
                        ...initialCamera,
                        ...(project.scene.localAsset
                          ? { near: project.camera.near, far: project.camera.far }
                          : {}),
                      },
                );
              },
            },
          ]}
        />
      )}
      {overlay === "walk" && (
        <ActionSheet
          title="Walking speed"
          onClose={() => setOverlay(null)}
          actions={(Object.keys(WALK_LABELS) as (keyof typeof WALK_LABELS)[]).map((speed) => ({
            label: `${WALK_LABELS[speed]}${preferences.walkSpeed === speed ? " ✓" : ""}`,
            onSelect: () => void services.updatePreferences({ walkSpeed: speed }),
          }))}
        />
      )}
      {overlay === "aspect" && (
        <ActionSheet
          title={activeShot ? `Aspect ratio of ${activeShot.name}` : "Aspect ratio"}
          onClose={() => setOverlay(null)}
          actions={ASPECT_CHOICES.map(([label, value]) => ({
            label: `${label}${Math.abs(project.camera.output.aspectRatio - value) < 0.01 ? " ✓" : ""}`,
            onSelect: () =>
              activeShot
                ? changeSetup({ aspectRatio: value })
                : patchCamera({ output: { aspectRatio: value, crop: "center-inside-sensor" } }),
          }))}
        />
      )}
    </div>
  );
}
