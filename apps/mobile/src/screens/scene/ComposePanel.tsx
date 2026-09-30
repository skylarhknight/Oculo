import { useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  APERTURE_STOPS,
  clampFocal,
  createSpeedCurvePreset,
  formatFStop,
  lensAllowsZoom,
  lensLabel,
  nearestStop,
  rollDegrees,
  SENSOR_PRESETS,
  shotAsPath,
  withRoll,
  type CameraSpeedCurvePreset,
} from "@oculo/camera-core";
import { lensFocalRange, SHOT_DURATION_RANGE } from "@oculo/scene-schema";
import { useAppServices } from "../../app/AppServices";
import { HoldButton, type NavigationDriver } from "../../components/Joysticks";
import { SpeedCurveEditor } from "../../components/SpeedCurveEditor";
import { aspectLabel } from "../../services/cameraState";
import type {
  CinematicCamera,
  SceneWorkspace,
  Shot,
  ShotLens,
  ShotSetup,
} from "../../types/project";
import { displayCameraValue, RangeControl, Segmented, Toggle } from "../../ui/controls";
import { Sheet } from "../../ui/Sheet";
import { ASPECT_CHOICES, formatSeconds, shotKindLabel, type Transport } from "./workspaceShared";

const SPEED_PRESETS: readonly [CameraSpeedCurvePreset, string][] = [
  ["constant", "Constant"],
  ["ease-in", "Ease in"],
  ["ease-out", "Ease out"],
  ["ease-in-out", "Ease in/out"],
];
const FOCUS = { min: 0.3, max: 100 };
const FREE_FOCAL = { min: 12, max: 300 };

/** The Compose panel's sections; one shows at a time. */
export type ComposeTab = "lens" | "move" | "notes";

export interface ComposePanelProps {
  project: SceneWorkspace;
  /** The shot being edited; null while roaming with the free camera. */
  shot: Shot | null;
  sceneReady: boolean;
  disabled: boolean;
  transport: Transport;
  /** The keyframe under the playhead, if any. */
  atKeyframeId: string | null;
  selectedSegment: number;
  error: string;
  leaving: boolean;
  exportOpen: boolean;
  focusArmed: boolean;
  tab: ComposeTab;
  history: { canUndo: boolean; canRedo: boolean; restore: (direction: "undo" | "redo") => void };
  drive: NavigationDriver;
  onTabChange: (tab: ComposeTab) => void;
  onArmFocus: (armed: boolean) => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onPatchCamera: (patch: Partial<CinematicCamera>) => void;
  onUpdate: (patch: Partial<SceneWorkspace>, immediate?: boolean) => SceneWorkspace;
  onEditShot: (transform: (shot: Shot) => Shot) => void;
  /** Renames or annotates the open shot; `commit` saves at once (on blur). */
  onShotText: (patch: { name?: string; notes?: string }, commit: boolean) => void;
  onDeleteKeyframe: (id: string) => void;
  onKeyframeTime: (id: string, seconds: number) => void;
  onLength: (seconds: number) => void;
  onSegmentChange: (segment: number) => void;
  onSetLens: (lens: ShotLens) => void;
  onSetSetup: (
    patch: Partial<Pick<ShotSetup, "sensorWidthMm" | "sensorHeightMm">> & {
      aspectRatio?: number;
    },
  ) => void;
  onDone: () => void;
}

/** Groups continuous slider drags into one undo step. */
function editGroup(onBeginEdit: () => void, onEndEdit: () => void) {
  return {
    onPointerDownCapture: (event: React.PointerEvent) => {
      if (event.target instanceof HTMLInputElement) onBeginEdit();
    },
    onPointerUpCapture: onEndEdit,
    onPointerCancelCapture: onEndEdit,
    onFocusCapture: (event: React.FocusEvent) => {
      if (event.target instanceof HTMLInputElement) onBeginEdit();
    },
    onBlurCapture: onEndEdit,
    onKeyDownCapture: (event: React.KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement && event.key.startsWith("Arrow")) onBeginEdit();
    },
    onKeyUpCapture: (event: React.KeyboardEvent) => {
      if (event.key.startsWith("Arrow")) onEndEdit();
    },
  };
}

const TABS: readonly { value: ComposeTab; label: string }[] = [
  { value: "lens", label: "Lens" },
  { value: "move", label: "Move" },
  { value: "notes", label: "Notes" },
];

/**
 * Compose tools under the viewfinder. The header says what is being edited; one section
 * shows at a time: Lens (what the camera sees), Move (keyframes and timing), Notes.
 * Playback lives on the bar over the scene, so nothing here repeats it.
 */
export function ComposePanel(props: ComposePanelProps) {
  const { project, shot, disabled, error, tab, onTabChange } = props;
  const [setupOpen, setSetupOpen] = useState(false);
  return (
    <div className="compose-panel">
      <ComposeHeader {...props} />
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <Segmented label="Compose tools" value={tab} options={TABS} onChange={onTabChange} />
      <div className="compose-section" key={tab} data-tab={tab}>
        {tab === "lens" && (
          <div inert={disabled} {...editGroup(props.onBeginEdit, props.onEndEdit)}>
            <RollingControls {...props} />
            <button className="compose-row" onClick={() => setSetupOpen(true)}>
              <span>
                <b>Lens setup</b>
                <small>
                  {shot
                    ? lensLabel(shot.setup.lens)
                    : `${displayCameraValue(project.camera.focalLengthMm)}mm`}{" "}
                  · {aspectLabel(project.camera.output.aspectRatio)} · sensor, grid, presets
                </small>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </div>
        )}
        {tab === "move" && <MoveSection {...props} />}
        {tab === "notes" && <NotesSection {...props} />}
      </div>
      {setupOpen && (
        <Sheet
          title={shot ? `Lens setup · ${shot.name}` : "Lens setup"}
          onClose={() => {
            props.onEndEdit();
            setSetupOpen(false);
          }}
        >
          <div inert={disabled} {...editGroup(props.onBeginEdit, props.onEndEdit)}>
            {shot ? <ShotSetupControls {...props} shot={shot} /> : <FreeLensControls {...props} />}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function ComposeHeader({ project, shot, onDone }: ComposePanelProps) {
  if (!shot)
    return (
      <div className="compose-header">
        <div>
          <strong>Free camera</strong>
          <small>
            {displayCameraValue(project.camera.focalLengthMm)}mm ·{" "}
            {aspectLabel(project.camera.output.aspectRatio)} · frame it, then tap the shutter
          </small>
        </div>
      </div>
    );
  return (
    <div className="compose-header">
      <div>
        <strong>{shot.name}</strong>
        <small>
          {shotKindLabel(shot)} · {lensLabel(shot.setup.lens)}
        </small>
      </div>
      <button className="btn btn--small btn--secondary" onClick={onDone}>
        <X size={16} /> Close shot
      </button>
    </div>
  );
}

/** Keyframes, length and speed for the open shot; precise moves for everyone. */
function MoveSection(props: ComposePanelProps) {
  const {
    shot,
    transport,
    sceneReady,
    atKeyframeId,
    selectedSegment,
    disabled,
    leaving,
    exportOpen,
    history,
    onDeleteKeyframe,
    onKeyframeTime,
    onLength,
    onSegmentChange,
    onEditShot,
    onBeginEdit,
    onEndEdit,
  } = props;
  const [curveOpen, setCurveOpen] = useState(false);
  if (!shot)
    return (
      <div className="compose-empty" inert={disabled}>
        <p className="meta">
          Save a shot with the shutter, then add keyframes to make the camera move.
        </p>
        <PreciseMoves {...props} />
      </div>
    );
  const moving = shot.keyframes.length > 1;
  const selected = shot.keyframes.find((frame) => frame.id === atKeyframeId);
  const selectedIndex = selected ? shot.keyframes.indexOf(selected) : -1;
  const segment = Math.min(selectedSegment, Math.max(0, shot.keyframes.length - 2));
  const segmentCurve = shot.keyframes[segment]?.speedCurve;
  const applyPreset = (preset: CameraSpeedCurvePreset) =>
    onEditShot((current) => ({
      ...current,
      keyframes: current.keyframes.map((frame, index) =>
        index === segment ? { ...frame, speedCurve: createSpeedCurvePreset(preset) } : frame,
      ),
    }));
  return (
    <div className="shot-timing" inert={disabled}>
      {selected ? (
        <div className="keyframe-detail">
          <span className="keyframe-detail__badge" aria-hidden="true">
            <i /> {selectedIndex + 1}
          </span>
          <label className="field field--inline">
            <span>Keyframe {selectedIndex + 1} time</span>
            <input
              type="number"
              min="0"
              max={SHOT_DURATION_RANGE.max}
              step="0.1"
              disabled={selectedIndex === 0}
              aria-describedby={selectedIndex === 0 ? "keyframe-time-why" : undefined}
              value={Number(selected.timeSeconds.toFixed(2))}
              onChange={(event) => {
                if (!event.target.value || !Number.isFinite(event.target.valueAsNumber)) return;
                onKeyframeTime(selected.id, event.target.valueAsNumber);
              }}
            />
          </label>
          <button
            className="btn btn--small btn--ghost"
            disabled={!moving}
            aria-label={`Delete keyframe ${selectedIndex + 1}`}
            aria-describedby={moving ? undefined : "keyframe-delete-why"}
            onClick={() => onDeleteKeyframe(selected.id)}
          >
            <Trash2 size={16} /> Delete
          </button>
          {selectedIndex === 0 && (
            <small className="meta" id="keyframe-time-why">
              The first keyframe starts the shot at 0s.
            </small>
          )}
          {!moving && (
            <small className="meta" id="keyframe-delete-why">
              A shot keeps at least one keyframe.
            </small>
          )}
        </div>
      ) : (
        <p className="meta">
          Tap a diamond on the timeline to edit that keyframe. Add keyframe records the camera at
          the playhead.
        </p>
      )}
      <div className="length-control" {...editGroup(onBeginEdit, onEndEdit)}>
        <RangeControl
          label="Shot length in seconds"
          value={shot.durationSeconds}
          min={SHOT_DURATION_RANGE.min}
          max={Math.max(SHOT_DURATION_RANGE.min + 1, Math.min(SHOT_DURATION_RANGE.max, 30))}
          step={0.5}
          unit="s"
          format={formatSeconds}
          onChange={onLength}
        />
      </div>
      {moving && (
        <div className="speed-control">
          <div className="speed-control__head">
            <b>Speed</b>
            {shot.keyframes.length > 2 ? (
              <select
                aria-label="Segment"
                value={segment}
                onChange={(event) => onSegmentChange(Number(event.target.value))}
              >
                {shot.keyframes.slice(0, -1).map((frame, index) => (
                  <option key={frame.id} value={index}>
                    Keyframe {index + 1} → {index + 2}
                  </option>
                ))}
              </select>
            ) : (
              <span className="meta">Keyframe 1 → 2</span>
            )}
          </div>
          <div className="chip-row" role="radiogroup" aria-label="Speed through this segment">
            {SPEED_PRESETS.map(([preset, label]) => {
              const reference = createSpeedCurvePreset(preset);
              const active =
                JSON.stringify(segmentCurve ?? createSpeedCurvePreset("constant")) ===
                JSON.stringify(reference);
              return (
                <button
                  key={preset}
                  role="radio"
                  aria-checked={active}
                  className={`chip${active ? " is-active" : ""}`}
                  onClick={() => applyPreset(preset)}
                >
                  {label}
                </button>
              );
            })}
            <button className="chip" onClick={() => setCurveOpen(true)}>
              Edit curve
            </button>
          </div>
        </div>
      )}
      <PreciseMoves {...props} />
      {curveOpen && (
        <Sheet
          title="Edit camera speed"
          className="expanded-graph"
          closeLabel="Close speed curve"
          onClose={() => {
            onEndEdit();
            setCurveOpen(false);
          }}
          footer={
            <div className="graph-footer">
              <button
                className="icon-btn icon-btn--filled"
                aria-label="Undo camera edit"
                disabled={!history.canUndo || transport.isPlaying}
                onClick={() => history.restore("undo")}
              >
                <Undo2 size={18} />
              </button>
              <button
                className="icon-btn icon-btn--filled"
                aria-label="Redo camera edit"
                disabled={!history.canRedo || transport.isPlaying}
                onClick={() => history.restore("redo")}
              >
                <Redo2 size={18} />
              </button>
              <button
                className="btn btn--secondary btn--block"
                disabled={!sceneReady}
                onClick={transport.isPlaying ? () => transport.stop(true) : transport.play}
              >
                {transport.isPlaying ? "Stop preview" : "Preview shot"}
              </button>
            </div>
          }
        >
          <SpeedCurveEditor
            path={shotAsPath(shot)}
            disabled={transport.isPlaying || transport.isScrubbing || leaving || exportOpen}
            timeSeconds={transport.playheadRef.current}
            selectedSegment={segment}
            onSegmentChange={onSegmentChange}
            onEditStart={onBeginEdit}
            onEditEnd={onEndEdit}
            onChange={(path) =>
              onEditShot((current) => ({
                ...current,
                keyframes: current.keyframes.map((frame, index) => {
                  const curve = path.keyframes[index]?.speedCurve;
                  if (curve) return { ...frame, speedCurve: curve };
                  const copy = { ...frame };
                  delete copy.speedCurve;
                  return copy;
                }),
              }))
            }
          />
        </Sheet>
      )}
    </div>
  );
}

/** Buttons that move the camera, for switch, keyboard and screen reader users. */
function PreciseMoves({ drive, disabled, sceneReady }: ComposePanelProps) {
  return (
    <details className="tool-section">
      <summary>
        Precise moves
        <span className="meta">Hold to move, pan or tilt</span>
      </summary>
      <div className="tool-body">
        <NudgePad drive={drive} disabled={disabled || !sceneReady} />
      </div>
    </details>
  );
}

/** The open shot's name and notes, saved as you type. */
function NotesSection({ shot, onShotText }: ComposePanelProps) {
  if (!shot)
    return (
      <p className="compose-empty meta">
        Save a shot with the shutter to name it and add notes for the crew.
      </p>
    );
  return (
    <div className="notes-section">
      <label className="field">
        <span>Shot name</span>
        <input
          value={shot.name}
          maxLength={60}
          onChange={(event) => onShotText({ name: event.target.value }, false)}
          onBlur={(event) =>
            onShotText({ name: event.target.value.trim() || nextFallbackName(shot) }, true)
          }
        />
      </label>
      <label className="field">
        <span>Notes</span>
        <textarea
          value={shot.notes ?? ""}
          rows={4}
          maxLength={10000}
          placeholder="Blocking, intent, lens notes…"
          onChange={(event) => onShotText({ notes: event.target.value }, false)}
          onBlur={(event) => onShotText({ notes: event.target.value.trim() }, true)}
        />
      </label>
      <p className="meta">Notes appear under this shot in the shot plan and PDF.</p>
    </div>
  );
}

const nextFallbackName = (shot: Shot) => shot.name.trim() || "Shot";

/** Settings a camera operator changes while rolling; the FAB records them into keyframes. */
function RollingControls({
  project,
  shot,
  sceneReady,
  focusArmed,
  onArmFocus,
  onPatchCamera,
}: ComposePanelProps) {
  const camera = project.camera;
  const lens = shot?.setup.lens;
  const range = lens ? lensFocalRange(lens) : FREE_FOCAL;
  const zoomLocked = lens !== undefined && !lensAllowsZoom(lens);
  const focus = camera.focusDistanceM ?? 3;
  const stop = nearestStop(camera.apertureFStop ?? 2.8);
  const roll = rollDegrees(camera.pose.quaternion);
  return (
    <>
      <RangeControl
        label="Focal length"
        value={lens ? clampFocal(lens, camera.focalLengthMm) : camera.focalLengthMm}
        min={range.min}
        max={zoomLocked ? range.min + 1 : range.max}
        step={1}
        unit="mm"
        disabled={zoomLocked}
        hint={zoomLocked ? `${displayCameraValue(range.min)}mm prime` : undefined}
        onChange={(focalLengthMm) =>
          onPatchCamera({ focalLengthMm: lens ? clampFocal(lens, focalLengthMm) : focalLengthMm })
        }
      />
      <div className="focus-control">
        <RangeControl
          label="Focus"
          value={Math.log10(focus)}
          min={Math.log10(FOCUS.min)}
          max={Math.log10(FOCUS.max)}
          step={0.01}
          unit=""
          format={(value) => `${displayCameraValue(10 ** value)} m`}
          onChange={(value) => onPatchCamera({ focusDistanceM: Number((10 ** value).toFixed(2)) })}
        />
        <button
          className={`btn btn--small ${focusArmed ? "btn--primary" : "btn--secondary"}`}
          aria-pressed={focusArmed}
          disabled={!sceneReady}
          onClick={() => onArmFocus(!focusArmed)}
        >
          <Crosshair size={16} /> {focusArmed ? "Tap the scene…" : "Tap to focus"}
        </button>
      </div>
      <RangeControl
        label="Aperture"
        value={APERTURE_STOPS.indexOf(stop as (typeof APERTURE_STOPS)[number])}
        min={0}
        max={APERTURE_STOPS.length - 1}
        step={1}
        unit=""
        format={(index) => formatFStop(APERTURE_STOPS[Math.round(index)] ?? stop)}
        onChange={(index) => onPatchCamera({ apertureFStop: APERTURE_STOPS[Math.round(index)] })}
      />
      <RangeControl
        label="Dutch angle"
        value={Math.round(roll)}
        min={-45}
        max={45}
        step={1}
        unit="°"
        onChange={(degrees) => {
          const snapped = Math.abs(degrees) <= 2 ? 0 : degrees;
          onPatchCamera({
            pose: { ...camera.pose, quaternion: withRoll(camera.pose.quaternion, snapped) },
          });
        }}
      />
    </>
  );
}

function ShotSetupControls({
  project,
  shot,
  onSetLens,
  onSetSetup,
  onUpdate,
}: ComposePanelProps & { shot: Shot }) {
  const { lens } = shot.setup;
  const [confirmLens, setConfirmLens] = useState<ShotLens | null>(null);
  const clamps = (next: ShotLens) =>
    shot.keyframes.some((frame) => clampFocal(next, frame.focalLengthMm) !== frame.focalLengthMm);
  const request = (next: ShotLens) => {
    if (next.kind === "zoom" && next.maxFocalLengthMm <= next.minFocalLengthMm) return;
    if (clamps(next)) setConfirmLens(next);
    else onSetLens(next);
  };
  const range = lensFocalRange(lens);
  const sensorId =
    Object.values(SENSOR_PRESETS).find(
      (preset) =>
        preset.widthMm === shot.setup.sensorWidthMm &&
        preset.heightMm === shot.setup.sensorHeightMm,
    )?.id ?? "custom";
  return (
    <>
      <Segmented
        label="Lens type"
        value={lens.kind}
        onChange={(kind) =>
          request(
            kind === "prime"
              ? { kind: "prime", focalLengthMm: Math.round(project.camera.focalLengthMm) }
              : {
                  kind: "zoom",
                  minFocalLengthMm: Math.min(range.min, 24),
                  maxFocalLengthMm: Math.max(range.max, 70),
                },
          )
        }
        options={[
          { value: "prime", label: "Prime" },
          { value: "zoom", label: "Zoom" },
        ]}
      />
      {lens.kind === "prime" ? (
        <RangeControl
          label="Prime focal length"
          value={lens.focalLengthMm}
          min={FREE_FOCAL.min}
          max={FREE_FOCAL.max}
          step={1}
          unit="mm"
          onChange={(focalLengthMm) => request({ kind: "prime", focalLengthMm })}
        />
      ) : (
        <>
          <RangeControl
            label="Widest"
            value={lens.minFocalLengthMm}
            min={FREE_FOCAL.min}
            max={lens.maxFocalLengthMm - 1}
            step={1}
            unit="mm"
            onChange={(minFocalLengthMm) => request({ ...lens, minFocalLengthMm })}
          />
          <RangeControl
            label="Longest"
            value={lens.maxFocalLengthMm}
            min={lens.minFocalLengthMm + 1}
            max={FREE_FOCAL.max}
            step={1}
            unit="mm"
            onChange={(maxFocalLengthMm) => request({ ...lens, maxFocalLengthMm })}
          />
        </>
      )}
      <label className="field">
        <span>Sensor</span>
        <select
          value={sensorId}
          onChange={(event) => {
            const preset = Object.values(SENSOR_PRESETS).find(
              (candidate) => candidate.id === event.target.value,
            );
            if (preset)
              onSetSetup({ sensorWidthMm: preset.widthMm, sensorHeightMm: preset.heightMm });
          }}
        >
          <option value="custom">Custom</option>
          {Object.values(SENSOR_PRESETS).map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <AspectChoices
        value={shot.setup.output.aspectRatio}
        onChange={(aspectRatio) => onSetSetup({ aspectRatio })}
      />
      <OverlayToggles project={project} onUpdate={onUpdate} />
      {confirmLens && (
        <Sheet
          title="Change lens?"
          onClose={() => setConfirmLens(null)}
          footer={
            <button
              className="btn btn--primary btn--block"
              onClick={() => {
                onSetLens(confirmLens);
                setConfirmLens(null);
              }}
            >
              Change lens
            </button>
          }
        >
          <p>
            Some keyframes use a focal length outside {lensLabel(confirmLens)}. They will be set to
            the nearest focal length the new lens has.
          </p>
        </Sheet>
      )}
    </>
  );
}

function AspectChoices({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <div className="chip-row" role="radiogroup" aria-label="Output aspect ratio">
      {ASPECT_CHOICES.map(([label, ratio]) => {
        const active = Math.abs(value - ratio) < 0.01;
        return (
          <button
            key={label}
            role="radio"
            aria-checked={active}
            className={`chip${active ? " is-active" : ""}`}
            onClick={() => onChange(ratio)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function OverlayToggles({ project, onUpdate }: Pick<ComposePanelProps, "project" | "onUpdate">) {
  return (
    <>
      <Toggle
        label="Composition grid"
        checked={project.settings.showGrid}
        onChange={(showGrid) => onUpdate({ settings: { ...project.settings, showGrid } })}
      />
      <Toggle
        label="Frame outline"
        checked={project.settings.showSafeFrame}
        onChange={(showSafeFrame) => onUpdate({ settings: { ...project.settings, showSafeFrame } })}
      />
    </>
  );
}

/** Before a shot exists: presets and the free camera's lens and format. */
function FreeLensControls({ project, onPatchCamera, onUpdate }: ComposePanelProps) {
  const { presets, savePreset } = useAppServices();
  const [naming, setNaming] = useState(false);
  const camera = project.camera;
  const sensor =
    Object.values(SENSOR_PRESETS).find(
      (preset) =>
        preset.widthMm === camera.sensorWidthMm && preset.heightMm === camera.sensorHeightMm,
    )?.id ?? "custom";
  return (
    <>
      <div className="chip-row preset-row" aria-label="Camera presets">
        {presets.map((preset) => {
          const active =
            preset.focalLengthMm === camera.focalLengthMm &&
            preset.sensorWidthMm === camera.sensorWidthMm &&
            preset.sensorHeightMm === camera.sensorHeightMm &&
            Math.abs(preset.aspectRatio - camera.output.aspectRatio) < 0.001;
          return (
            <button
              key={preset.id}
              className={`chip${active ? " is-active" : ""}`}
              aria-pressed={active}
              onClick={() =>
                onPatchCamera({
                  focalLengthMm: preset.focalLengthMm,
                  sensorWidthMm: preset.sensorWidthMm,
                  sensorHeightMm: preset.sensorHeightMm,
                  output: { aspectRatio: preset.aspectRatio, crop: "center-inside-sensor" },
                })
              }
            >
              {preset.name}
            </button>
          );
        })}
        <button className="chip" onClick={() => setNaming(true)}>
          <Plus size={14} /> Save preset
        </button>
      </div>
      <label className="field">
        <span>Sensor preset</span>
        <select
          value={sensor}
          onChange={(event) => {
            const preset = Object.values(SENSOR_PRESETS).find(
              (candidate) => candidate.id === event.target.value,
            );
            if (preset)
              onPatchCamera({ sensorWidthMm: preset.widthMm, sensorHeightMm: preset.heightMm });
          }}
        >
          <option value="custom">Custom</option>
          {Object.values(SENSOR_PRESETS).map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <AspectChoices
        value={camera.output.aspectRatio}
        onChange={(aspectRatio) =>
          onPatchCamera({ output: { aspectRatio, crop: "center-inside-sensor" } })
        }
      />
      <p className="meta">
        Centered crop within the sensor. The shutter saves a shot on this lens as a prime; switch it
        to a zoom in the shot&apos;s lens setup.
      </p>
      <OverlayToggles project={project} onUpdate={onUpdate} />
      {naming && (
        <PresetNameSheet
          camera={camera}
          onClose={() => setNaming(false)}
          onSave={async (name) => {
            await savePreset({
              version: 1,
              id: crypto.randomUUID(),
              name,
              focalLengthMm: camera.focalLengthMm,
              sensorWidthMm: camera.sensorWidthMm,
              sensorHeightMm: camera.sensorHeightMm,
              aspectRatio: camera.output.aspectRatio,
              createdAt: Date.now(),
            });
            setNaming(false);
          }}
        />
      )}
    </>
  );
}

/** Press-and-hold camera moves, reachable by keyboard, switch and screen reader. */
function NudgePad({ drive, disabled }: { drive: NavigationDriver; disabled: boolean }) {
  const buttons: [string, Parameters<NavigationDriver>[0], React.ReactNode][] = [
    ["Move forward", { moveZ: 1 }, <ArrowUp key="f" size={18} />],
    ["Move back", { moveZ: -1 }, <ArrowDown key="b" size={18} />],
    ["Move left", { moveX: -1 }, <ArrowLeft key="l" size={18} />],
    ["Move right", { moveX: 1 }, <ArrowRight key="r" size={18} />],
    ["Raise camera", { vertical: 1 }, <ChevronUp key="u" size={18} />],
    ["Lower camera", { vertical: -1 }, <ChevronDown key="d" size={18} />],
    ["Pan left", { yawRate: -1 }, <RotateCcw key="pl" size={18} />],
    ["Pan right", { yawRate: 1 }, <RotateCw key="pr" size={18} />],
    ["Tilt up", { pitchRate: 1 }, <ChevronUp key="tu" size={18} />],
    ["Tilt down", { pitchRate: -1 }, <ChevronDown key="td" size={18} />],
  ];
  return (
    <div className="nudge-pad">
      {buttons.map(([label, input, icon]) => (
        <HoldButton
          key={label}
          className="btn btn--small btn--secondary"
          label={label}
          input={input}
          drive={drive}
          disabled={disabled}
        >
          {icon}
          <span>{label}</span>
        </HoldButton>
      ))}
    </div>
  );
}

function PresetNameSheet({
  camera,
  onSave,
  onClose,
}: {
  camera: CinematicCamera;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(
    `${Math.round(camera.focalLengthMm)}mm ${aspectLabel(camera.output.aspectRatio)}`,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(name.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The preset could not be saved.");
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Save camera preset"
      onClose={onClose}
      busy={busy}
      footer={
        <button
          className="btn btn--primary btn--block"
          disabled={busy || !name.trim()}
          onClick={() => void submit()}
        >
          Save preset
        </button>
      }
    >
      <label className="field">
        <span>Preset name</span>
        <input
          value={name}
          maxLength={40}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className="meta">
        {displayCameraValue(camera.focalLengthMm)}mm lens ·{" "}
        {displayCameraValue(camera.sensorWidthMm)}×{displayCameraValue(camera.sensorHeightMm)}mm
        sensor · {aspectLabel(camera.output.aspectRatio)}
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
