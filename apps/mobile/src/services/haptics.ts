import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

/**
 * Fire-and-forget haptic cues. Failures (web, simulator, disabled hardware)
 * are silently ignored so callers never need to branch on platform.
 */

let enabled = true;

/** Mirrors the Accessibility preference; cues become no-ops when off. */
export function setHapticsEnabled(value: boolean): void {
  enabled = value;
}

export function tapHaptic(): void {
  if (!enabled) return;
  void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}

export function confirmHaptic(): void {
  if (!enabled) return;
  void Haptics.notification({ type: NotificationType.Success }).catch(() => undefined);
}

export function warnHaptic(): void {
  if (!enabled) return;
  void Haptics.notification({ type: NotificationType.Warning }).catch(() => undefined);
}
