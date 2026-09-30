import { useCallback, useEffect, useRef } from "react";
import { tapHaptic } from "../services/haptics";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;

/** Long-press opens a context menu, with a haptic tick; the following click is swallowed. */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const latest = useRef(onLongPress);
  latest.current = onLongPress;

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    origin.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  return {
    consumed: () => {
      const value = fired.current;
      fired.current = false;
      return value;
    },
    handlers: {
      onPointerDown: (event: React.PointerEvent) => {
        if (event.button !== 0) return;
        fired.current = false;
        origin.current = { x: event.clientX, y: event.clientY };
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          fired.current = true;
          tapHaptic();
          latest.current();
        }, HOLD_MS);
      },
      onPointerMove: (event: React.PointerEvent) => {
        const start = origin.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE)
          cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu: (event: React.MouseEvent) => {
        event.preventDefault();
        cancel();
        fired.current = true;
        latest.current();
      },
    },
  };
}
