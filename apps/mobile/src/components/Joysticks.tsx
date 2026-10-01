import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { NavigationInput } from "@oculo/scene-core";
import { tapHaptic } from "../services/haptics";

export type NavigationDriver = (input: Partial<NavigationInput>) => void;

/** Time an assistive-technology activation holds a nudge, since it has no press length. */
const NUDGE_MS = 250;

interface StickProps {
  label: string;
  hint: string;
  className: string;
  /** Receives -1..1 on each axis; up is +y. */
  onChange: (x: number, y: number) => void;
  disabled: boolean;
}

const KEY_AXES: Record<string, readonly [number, number]> = {
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/**
 * A thumb stick. The knob follows the finger inside its ring and springs back on release.
 * With focus, the arrow keys push it while held.
 */
function Stick({ label, hint, className, onChange, disabled }: StickProps) {
  const ring = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const keys = useRef(new Set<string>());
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const emit = (x: number, y: number) => {
    setKnob({ x, y });
    onChange(x, y);
  };
  const release = () => {
    pointer.current = null;
    keys.current.clear();
    emit(0, 0);
  };
  const track = (clientX: number, clientY: number) => {
    const rect = ring.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const radius = rect.width / 2;
    let x = (clientX - rect.left - radius) / radius;
    let y = -(clientY - rect.top - radius) / radius;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    emit(x, y);
  };
  const fromKeys = () => {
    let x = 0;
    let y = 0;
    for (const key of keys.current) {
      const axis = KEY_AXES[key];
      if (axis) {
        x += axis[0];
        y += axis[1];
      }
    }
    emit(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
  };

  useEffect(() => {
    if (disabled && (pointer.current !== null || keys.current.size > 0)) release();
  }, [disabled]);

  return (
    <div
      ref={ring}
      className={`stick ${className}`}
      role="group"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-description={hint}
      aria-disabled={disabled}
      data-active={knob.x !== 0 || knob.y !== 0}
      onPointerDown={(event) => {
        if (disabled || pointer.current !== null) return;
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        tapHaptic();
        track(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (event.pointerId === pointer.current) track(event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        if (event.pointerId === pointer.current) release();
      }}
      onPointerCancel={release}
      onLostPointerCapture={(event) => {
        if (event.pointerId === pointer.current) release();
      }}
      onKeyDown={(event) => {
        if (disabled || !KEY_AXES[event.key]) return;
        event.preventDefault();
        keys.current.add(event.key);
        fromKeys();
      }}
      onKeyUp={(event) => {
        if (!keys.current.delete(event.key)) return;
        fromKeys();
      }}
      onBlur={() => {
        if (keys.current.size) release();
      }}
    >
      <span
        className="stick__knob"
        style={{
          translate: `calc(${knob.x} * var(--stick-travel)) calc(${-knob.y} * var(--stick-travel))`,
        }}
      />
    </div>
  );
}

/**
 * A button that moves the camera while pressed. Switch Control and VoiceOver activate
 * without a press length, so a click that no press preceded nudges for a moment.
 */
export function HoldButton({
  label,
  input,
  drive,
  disabled,
  className,
  children,
}: {
  label: string;
  input: Partial<NavigationInput>;
  drive: NavigationDriver;
  disabled: boolean;
  className?: string;
  children: ReactNode;
}) {
  const pressed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const neutral = Object.fromEntries(Object.keys(input).map((key) => [key, 0]));
  const stop = () => {
    clearTimeout(timer.current);
    drive(neutral);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(event) => {
        pressed.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drive(input);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onClick={() => {
        if (pressed.current) {
          pressed.current = false;
          return;
        }
        drive(input);
        clearTimeout(timer.current);
        timer.current = setTimeout(stop, NUDGE_MS);
      }}
    >
      {children}
    </button>
  );
}

/**
 * Dual thumb sticks in the capture row: the move stick, the capture controls passed as
 * children, the crane buttons, then the look stick.
 */
export function Joysticks({
  drive,
  disabled,
  children,
}: {
  drive: NavigationDriver;
  disabled: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="joysticks" aria-label="Camera movement" role="group">
      <Stick
        className="stick--move"
        label="Move camera"
        hint="Push up to walk forward, sideways to step left or right."
        disabled={disabled}
        onChange={(x, y) => drive({ moveX: x, moveZ: y })}
      />
      {children}
      <div className="crane">
        <HoldButton
          className="crane__button"
          label="Raise camera"
          input={{ vertical: 1 }}
          drive={drive}
          disabled={disabled}
        >
          <ChevronUp size={18} />
        </HoldButton>
        <HoldButton
          className="crane__button"
          label="Lower camera"
          input={{ vertical: -1 }}
          drive={drive}
          disabled={disabled}
        >
          <ChevronDown size={18} />
        </HoldButton>
      </div>
      <Stick
        className="stick--look"
        label="Aim camera"
        hint="Push sideways to pan and up or down to tilt."
        disabled={disabled}
        onChange={(x, y) => drive({ yawRate: x, pitchRate: y })}
      />
    </div>
  );
}
