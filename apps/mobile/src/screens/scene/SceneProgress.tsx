import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { CircleStop, Play } from "lucide-react";
import type { Shot } from "../../types/project";
import { formatSeconds, formatTime, type Transport } from "./workspaceShared";

/**
 * Keyboard and pointer handling for a playhead track: drag to scrub, Home/End and the
 * arrow keys to seek. Shared by the panel timeline and the progress bar over the scene.
 */
export function scrubTrackHandlers(shot: Shot, transport: Transport, enabled: boolean) {
  const duration = shot.durationSeconds;
  const at = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration;
  };
  return {
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const now = transport.playheadRef.current;
      const time =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? duration
            : event.key === "ArrowLeft"
              ? now - (event.shiftKey ? 1 : 0.1)
              : event.key === "ArrowRight"
                ? now + (event.shiftKey ? 1 : 0.1)
                : null;
      if (time === null) return;
      event.preventDefault();
      transport.scrubTo(time);
    },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !enabled) return;
      event.currentTarget.focus();
      transport.beginScrub(event.currentTarget, event.pointerId);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const time = at(event);
      if (time !== null) transport.commitPlayhead(time);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (!transport.isScrubPointer(event.pointerId)) return;
      const time = at(event);
      if (time !== null) transport.setPlayhead(time);
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      if (!transport.isScrubPointer(event.pointerId)) return;
      const time = at(event);
      if (time !== null) transport.setPlayhead(time);
      transport.finishScrub();
    },
    onPointerCancel: transport.finishScrub,
    onLostPointerCapture: transport.finishScrub,
  };
}

interface SceneProgressProps {
  shot: Shot;
  transport: Transport;
  sceneReady: boolean;
  /** The keyframe under the playhead, if any. */
  atKeyframeId: string | null;
  onSelectKeyframe: (id: string) => void;
}

/**
 * A slim playback bar over the scene while a shot is open: play/stop, a scrubbable
 * track, and a diamond for each keyframe that jumps the playhead to it. The fill and
 * playhead follow `--playhead` (0–1), which the workspace sets every frame.
 */
export function SceneProgress({
  shot,
  transport,
  sceneReady,
  atKeyframeId,
  onSelectKeyframe,
}: SceneProgressProps) {
  const duration = shot.durationSeconds;
  const moving = shot.keyframes.length > 1;
  const now = transport.playheadRef.current;
  return (
    <div
      className="scene-progress"
      ref={transport.progressRef}
      data-playing={transport.isPlaying}
      data-scrubbing={transport.isScrubbing}
      style={{ "--playhead": duration > 0 ? now / duration : 0 } as CSSProperties}
    >
      <button
        className="scene-progress__play"
        aria-label={transport.isPlaying ? `Stop ${shot.name}` : `Play ${shot.name}`}
        disabled={!sceneReady || !moving}
        onClick={transport.isPlaying ? () => transport.stop(true) : transport.play}
      >
        {transport.isPlaying ? <CircleStop size={16} /> : <Play size={14} fill="currentColor" />}
      </button>
      <div className="scene-progress__lane">
        <div
          className="scene-progress__track"
          ref={transport.progressTrackRef}
          role="slider"
          tabIndex={0}
          aria-label={`${shot.name} playhead`}
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={now}
          aria-valuetext={`${formatSeconds(now)} of ${formatSeconds(duration)}`}
          aria-disabled={!sceneReady}
          {...scrubTrackHandlers(shot, transport, sceneReady)}
        >
          <span className="scene-progress__rail">
            <span className="scene-progress__fill" />
          </span>
          <span className="scene-progress__head" aria-hidden="true" />
        </div>
        <ol className="scene-progress__keys" aria-label="Keyframes on the timeline">
          {shot.keyframes.map((frame, index) => (
            <li
              key={frame.id}
              style={
                {
                  "--i": index,
                  left: `${duration > 0 ? (frame.timeSeconds / duration) * 100 : 0}%`,
                } as CSSProperties
              }
            >
              <button
                className="scene-progress__key"
                data-active={frame.id === atKeyframeId}
                aria-label={`Keyframe ${index + 1} at ${formatSeconds(frame.timeSeconds)}`}
                aria-current={frame.id === atKeyframeId ? "true" : undefined}
                disabled={!sceneReady}
                onClick={() => onSelectKeyframe(frame.id)}
              >
                <i aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      </div>
      <span className="scene-progress__time">
        <output ref={transport.progressTimeRef}>{formatTime(now)}</output>
        <small> / {formatTime(duration)}</small>
      </span>
    </div>
  );
}
