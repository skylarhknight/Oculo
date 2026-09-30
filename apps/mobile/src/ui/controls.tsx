import type { CSSProperties, ReactNode } from "react";
import { Check } from "lucide-react";

export function displayCameraValue(value: number): string {
  return Number(value.toFixed(1)).toString();
}

export function PanelTitle({ index, title }: { index?: string; title: string }) {
  return (
    <div className="panel-title">
      {index && <span>{index}</span>}
      <h3>{title}</h3>
    </div>
  );
}

export function RangeControl({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  format,
  disabled,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  /** Replaces the default "value + unit" readout, for example on a log scale. */
  format?: (value: number) => string;
  disabled?: boolean;
  /** Shown instead of the readout when disabled explains why. */
  hint?: string | undefined;
}) {
  const amount = ((value - min) / (max - min)) * 100;
  const readout = format ? format(value) : `${displayCameraValue(value)}${unit}`;
  return (
    <label className={`range-control${disabled ? " is-disabled" : ""}`}>
      <span>
        <b>{label}</b>
        <output>{disabled && hint ? hint : readout}</output>
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        // The readout is an <output>, which a <label> would label first; name the slider directly.
        aria-label={label}
        aria-valuetext={readout}
        style={{ "--range-value": `${amount}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: ReactNode;
}) {
  return (
    <label className="toggle-row">
      <span>
        {label}
        {description && <small>{description}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i>
        <Check size={11} />
      </i>
    </label>
  );
}

/** Segmented control for 2–4 mutually exclusive options. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="segmented-control"
      role="radiogroup"
      aria-label={label}
      style={
        {
          "--seg-count": options.length,
          "--seg-index": Math.max(
            0,
            options.findIndex((option) => option.value === value),
          ),
        } as CSSProperties
      }
    >
      {options.map((option) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? "is-active" : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "Yesterday" : `${days} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
