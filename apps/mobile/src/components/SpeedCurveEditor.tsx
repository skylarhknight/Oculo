import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { createSpeedCurvePreset, sampleSpeedCurve } from "@oculo/camera-core";
import {
  MAX_SPEED_CURVE_POINTS,
  MAX_SPEED_WEIGHT,
  type CameraPath,
  type CameraSpeedCurve,
  type CameraSpeedPoint,
} from "@oculo/scene-schema";
import "../speedCurve.css";

interface SpeedCurveEditorProps {
  path: CameraPath;
  onChange: (path: CameraPath) => void;
  disabled?: boolean;
  timeSeconds?: number;
  selectedSegment?: number;
  onSegmentChange?: (index: number) => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
  onExpand?: () => void;
}

const GRAPH = { width: 360, height: 192, left: 32, right: 344, top: 16, bottom: 162 };
const MIN_GAP = 0.01;
const PRESETS = [
  ["constant", "Constant"],
  ["ease-in", "Ease in"],
  ["ease-out", "Ease out"],
  ["ease-in-out", "Ease in / out"],
] as const;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const displayNumber = (value: number) => Number(value.toFixed(3));

interface DragSession {
  pointerId: number;
  pointIndex: number;
  segment: number;
  element: SVGCircleElement;
}

function releaseDrag(ref: { current: DragSession | null }) {
  const session = ref.current;
  ref.current = null;
  if (session?.element.hasPointerCapture?.(session.pointerId)) {
    session.element.releasePointerCapture(session.pointerId);
  }
}

/** Speed controls are local to one camera segment; camera poses and arrival times stay fixed. */
export function SpeedCurveEditor({
  path,
  onChange,
  disabled = false,
  timeSeconds,
  selectedSegment,
  onSegmentChange,
  onEditStart,
  onEditEnd,
  onExpand,
}: SpeedCurveEditorProps) {
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [pointIndex, setPointIndex] = useState(0);
  const [error, setError] = useState("");
  const [graphWidth, setGraphWidth] = useState(GRAPH.width);
  const [graphHeight, setGraphHeight] = useState(GRAPH.height);
  const graphBottom = graphHeight - 30;
  const yPosition = (speed: number) =>
    graphBottom - (speed / MAX_SPEED_WEIGHT) * (graphBottom - GRAPH.top);
  const graphRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const gestureRef = useRef(false);
  const editCallbacks = useRef({ onEditStart, onEditEnd });
  editCallbacks.current = { onEditStart, onEditEnd };
  const beginGesture = useCallback(() => {
    if (gestureRef.current) return;
    gestureRef.current = true;
    editCallbacks.current.onEditStart?.();
  }, []);
  const finishGesture = useCallback(() => {
    releaseDrag(dragRef);
    if (!gestureRef.current) return;
    gestureRef.current = false;
    editCallbacks.current.onEditEnd?.();
  }, []);
  const descriptionId = useId();
  const instructionsId = useId();
  const headingId = useId();
  const areaId = useId();
  const segment = clamp(selectedSegment ?? segmentIndex, 0, Math.max(0, path.keyframes.length - 2));
  const frame = path.keyframes[segment];
  const nextFrame = path.keyframes[segment + 1];
  const curve = frame?.speedCurve ?? createSpeedCurvePreset("constant");
  const selectedIndex = clamp(pointIndex, 0, curve.points.length - 1);
  const selectedPoint = curve.points[selectedIndex]!;
  const duration = nextFrame && frame ? nextFrame.timeSeconds - frame.timeSeconds : 0;
  const hasSegment = Boolean(frame && nextFrame && duration > 0);
  const graphRight = graphWidth - 16;
  const xPosition = (time: number) => GRAPH.left + time * (graphRight - GRAPH.left);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const resize = () => {
      const { width, height } = graph.getBoundingClientRect();
      if (height > 46) setGraphHeight(height);
      if (width > GRAPH.left + 16) setGraphWidth(width);
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(graph);
    return () => observer.disconnect();
  }, [hasSegment]);

  useEffect(() => {
    finishGesture();
    return finishGesture;
  }, [disabled, segment, path.id, curve.points.length, finishGesture]);

  if (!frame || !nextFrame || duration <= 0) return null;

  const emit = (nextCurve: CameraSpeedCurve | undefined) => {
    if (disabled) return false;
    if (nextCurve && !nextCurve.points.some((point) => point.speed > 0)) {
      setError("At least one point needs a speed above zero.");
      return false;
    }
    setError("");
    const keyframes = path.keyframes.map((keyframe, index) => {
      if (index !== segment) return keyframe;
      const updated = { ...keyframe };
      if (nextCurve) updated.speedCurve = nextCurve;
      else delete updated.speedCurve;
      return updated;
    });
    onChange({ ...path, keyframes });
    return true;
  };

  const timeBounds = (index: number): [number, number] => {
    if (index === 0) return [0, 0];
    if (index === curve.points.length - 1) return [1, 1];
    // Imported curves may have closer points than the editor normally creates.
    // Keep the existing time inside its bounds without ever crossing a neighbor.
    return [
      Math.min(curve.points[index - 1]!.time + MIN_GAP, curve.points[index]!.time),
      Math.max(curve.points[index + 1]!.time - MIN_GAP, curve.points[index]!.time),
    ];
  };

  const editPoint = (index: number, changes: Partial<CameraSpeedPoint>) => {
    if (
      disabled ||
      !curve.points[index] ||
      Object.values(changes).some((value) => !Number.isFinite(value))
    )
      return;
    const [min, max] = timeBounds(index);
    const point = { ...curve.points[index]!, ...changes };
    if (changes.time !== undefined) point.time = clamp(point.time, min, max);
    point.speed = clamp(point.speed, 0, MAX_SPEED_WEIGHT);
    point.intensity = clamp(point.intensity, 0, 1);
    emit({ ...curve, points: curve.points.map((current, i) => (i === index ? point : current)) });
  };

  const addPoint = () => {
    if (disabled || curve.points.length >= MAX_SPEED_CURVE_POINTS) return;
    finishGesture();
    let gapIndex = 0;
    for (let index = 1; index < curve.points.length - 1; index += 1) {
      if (
        curve.points[index + 1]!.time - curve.points[index]!.time >
        curve.points[gapIndex + 1]!.time - curve.points[gapIndex]!.time
      )
        gapIndex = index;
    }
    const before = curve.points[gapIndex]!;
    const after = curve.points[gapIndex + 1]!;
    if (after.time - before.time < MIN_GAP * 2) return;
    const time = (before.time + after.time) / 2;
    const point = { time, speed: sampleSpeedCurve(curve, time), intensity: 0.5 };
    if (
      emit({
        ...curve,
        points: [
          ...curve.points.slice(0, gapIndex + 1),
          point,
          ...curve.points.slice(gapIndex + 1),
        ],
      })
    ) {
      setPointIndex(gapIndex + 1);
    }
  };

  const removePoint = () => {
    if (disabled || selectedIndex === 0 || selectedIndex === curve.points.length - 1) return;
    finishGesture();
    if (emit({ ...curve, points: curve.points.filter((_, index) => index !== selectedIndex) })) {
      setPointIndex(selectedIndex - 1);
    }
  };

  const startDrag = (event: PointerEvent<SVGCircleElement>, index: number) => {
    if (disabled || event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    setPointIndex(index);
    setError("");
    event.currentTarget.focus();
    beginGesture();
    dragRef.current = {
      pointerId: event.pointerId,
      pointIndex: index,
      segment,
      element: event.currentTarget,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveDrag = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (disabled || !drag || drag.pointerId !== event.pointerId || drag.segment !== segment) return;
    const rect = graphRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * graphWidth;
    const y = ((event.clientY - rect.top) / rect.height) * graphHeight;
    editPoint(drag.pointIndex, {
      time: (x - GRAPH.left) / (graphRight - GRAPH.left),
      speed: ((graphBottom - y) / (graphBottom - GRAPH.top)) * MAX_SPEED_WEIGHT,
    });
  };

  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) finishGesture();
  };

  const keyPoint = (event: KeyboardEvent<SVGCircleElement>, index: number) => {
    if (disabled) return;
    const point = curve.points[index]!;
    const multiplier = event.shiftKey ? 10 : 1;
    const changes: Record<string, Partial<CameraSpeedPoint>> = {
      ArrowLeft: { time: point.time - MIN_GAP * multiplier },
      ArrowRight: { time: point.time + MIN_GAP * multiplier },
      ArrowUp: { speed: point.speed + 0.1 * multiplier },
      ArrowDown: { speed: point.speed - 0.1 * multiplier },
    };
    if (!changes[event.key]) return;
    event.preventDefault();
    setPointIndex(index);
    beginGesture();
    editPoint(index, changes[event.key]!);
  };

  const sampledLine = Array.from({ length: 97 }, (_, index) => {
    const time = index / 96;
    return `${index === 0 ? "M" : "L"} ${xPosition(time)} ${yPosition(sampleSpeedCurve(curve, time))}`;
  }).join(" ");
  const [minTime, maxTime] = timeBounds(selectedIndex);
  const endpoint = selectedIndex === 0 || selectedIndex === curve.points.length - 1;
  const cursorTime =
    timeSeconds === undefined ? undefined : (timeSeconds - frame.timeSeconds) / duration;

  return (
    <section className="speed-curve-editor" aria-labelledby={headingId} aria-disabled={disabled}>
      <div className="speed-curve-heading">
        <h3 id={headingId}>Speed over time</h3>
        {onExpand && (
          <button type="button" disabled={disabled} onClick={onExpand}>
            Expand graph
          </button>
        )}
        <button
          type="button"
          className="speed-curve-reset"
          disabled={disabled || !frame.speedCurve}
          onClick={() => {
            finishGesture();
            if (emit(undefined)) setPointIndex(0);
          }}
        >
          Reset
        </button>
      </div>
      <p id={descriptionId} className="speed-curve-description">
        Higher points move faster. Duration stays fixed.
      </p>
      {path.keyframes.length > 2 && (
        <label className="speed-curve-segment">
          <span>Segment</span>
          <select
            aria-label="Speed curve segment"
            value={segment}
            disabled={disabled}
            onChange={(event) => {
              if (disabled) return;
              finishGesture();
              setSegmentIndex(Number(event.target.value));
              onSegmentChange?.(Number(event.target.value));
              setPointIndex(0);
              setError("");
            }}
          >
            {path.keyframes.slice(0, -1).map((keyframe, index) => (
              <option key={index} value={index}>
                Point {index + 1} → {index + 2} · {displayNumber(keyframe.timeSeconds)}–
                {displayNumber(path.keyframes[index + 1]!.timeSeconds)} s
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="speed-curve-presets" aria-label="Speed presets">
        {PRESETS.map(([preset, label]) => (
          <button
            key={preset}
            type="button"
            disabled={disabled}
            onClick={() => {
              finishGesture();
              if (emit(createSpeedCurvePreset(preset))) setPointIndex(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="speed-curve-graph-label">
        <span>Relative speed</span>
        <span>{displayNumber(duration)} s segment</span>
      </div>
      <svg
        ref={graphRef}
        className="speed-curve-graph"
        viewBox={`0 0 ${graphWidth} ${graphHeight}`}
        preserveAspectRatio="none"
        role="group"
        aria-label="Speed curve graph"
        aria-describedby={`${descriptionId} ${instructionsId}`}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <defs>
          <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--color-accent)" }} stopOpacity="0.22" />
            <stop offset="100%" style={{ stopColor: "var(--color-accent)" }} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((speed) => (
          <g key={speed} className="speed-curve-grid" aria-hidden="true">
            <line x1={GRAPH.left} x2={graphRight} y1={yPosition(speed)} y2={yPosition(speed)} />
            <text x={GRAPH.left - 9} y={yPosition(speed) + 3} textAnchor="end">
              {speed}
            </text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((time) => (
          <g key={time} className="speed-curve-grid" aria-hidden="true">
            <line x1={xPosition(time)} x2={xPosition(time)} y1={GRAPH.top} y2={graphBottom} />
            <text x={xPosition(time)} y={graphBottom + 20} textAnchor="middle">
              {displayNumber(time * duration)}s
            </text>
          </g>
        ))}
        <path
          d={`${sampledLine} L ${graphRight} ${graphBottom} L ${GRAPH.left} ${graphBottom} Z`}
          fill={`url(#${areaId})`}
          aria-hidden="true"
        />
        <path d={sampledLine} className="speed-curve-line" aria-hidden="true" />
        {cursorTime !== undefined && cursorTime >= 0 && cursorTime <= 1 && (
          <line
            className="speed-curve-cursor"
            aria-label="Playback position"
            x1={xPosition(cursorTime)}
            x2={xPosition(cursorTime)}
            y1={GRAPH.top}
            y2={graphBottom}
          />
        )}
        {curve.points.map((point, index) => (
          <g
            key={index}
            className={`speed-curve-point${index === selectedIndex ? " is-selected" : ""}`}
          >
            <circle
              cx={xPosition(point.time)}
              cy={yPosition(point.speed)}
              r={index === selectedIndex ? 6 : 4.5}
              className="speed-curve-point-dot"
              aria-hidden="true"
            />
            <circle
              cx={xPosition(point.time)}
              cy={yPosition(point.speed)}
              r="22"
              className="speed-curve-point-handle"
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={`Speed point ${index + 1}`}
              aria-valuemin={0}
              aria-valuemax={MAX_SPEED_WEIGHT}
              aria-valuenow={displayNumber(point.speed)}
              aria-valuetext={`${displayNumber(point.time * duration)} seconds, relative speed ${displayNumber(point.speed)}`}
              aria-disabled={disabled}
              aria-describedby={instructionsId}
              onFocus={() => {
                if (!disabled) setPointIndex(index);
              }}
              onClick={() => {
                if (!disabled) setPointIndex(index);
              }}
              onPointerDown={(event) => startDrag(event, index)}
              onKeyDown={(event) => keyPoint(event, index)}
              onKeyUp={finishGesture}
              onBlur={finishGesture}
            />
          </g>
        ))}
      </svg>
      <p id={instructionsId} className="speed-curve-help">
        Drag points to shape the move. Arrow keys change time and speed.
      </p>
      <div className="speed-curve-point-toolbar">
        <span>
          Point {selectedIndex + 1}{" "}
          <span className="speed-curve-dim">of {curve.points.length}</span>
        </span>
        <div>
          <button
            type="button"
            disabled={disabled || curve.points.length >= MAX_SPEED_CURVE_POINTS}
            onClick={addPoint}
          >
            + Add point
          </button>
          <button type="button" disabled={disabled || endpoint} onClick={removePoint}>
            Remove point
          </button>
        </div>
      </div>
      <div className="speed-curve-fields">
        <label>
          <span>Time (s)</span>
          <input
            aria-label="Point time (seconds)"
            type="number"
            inputMode="decimal"
            onFocus={beginGesture}
            onBlur={finishGesture}
            min={minTime * duration}
            max={maxTime * duration}
            step="any"
            value={selectedPoint.time * duration}
            disabled={disabled || endpoint}
            onChange={(event) =>
              editPoint(selectedIndex, { time: event.target.valueAsNumber / duration })
            }
          />
        </label>
        <label>
          <span>Relative speed</span>
          <input
            aria-label="Point relative speed"
            type="number"
            inputMode="decimal"
            onFocus={beginGesture}
            onBlur={finishGesture}
            min="0"
            max={MAX_SPEED_WEIGHT}
            step="0.1"
            value={displayNumber(selectedPoint.speed)}
            disabled={disabled}
            onChange={(event) => editPoint(selectedIndex, { speed: event.target.valueAsNumber })}
          />
        </label>
      </div>
      <label className="speed-curve-intensity">
        <span>
          Curve intensity <output>{Math.round(selectedPoint.intensity * 100)}%</output>
        </span>
        <input
          aria-label="Curve intensity"
          onPointerDown={beginGesture}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          onLostPointerCapture={finishGesture}
          onKeyDown={beginGesture}
          onKeyUp={finishGesture}
          onBlur={finishGesture}
          type="range"
          min="0"
          max="100"
          step="1"
          value={Math.round(selectedPoint.intensity * 100)}
          disabled={disabled}
          onChange={(event) =>
            editPoint(selectedIndex, { intensity: event.target.valueAsNumber / 100 })
          }
        />
        <span className="speed-curve-intensity-scale">
          <span>Linear</span>
          <span>Softer bends</span>
        </span>
      </label>
      {error && (
        <p className="speed-curve-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
