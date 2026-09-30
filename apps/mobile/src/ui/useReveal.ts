import { useEffect, type RefObject } from "react";
import { prefersReducedMotion } from "../theme/motion";

/** Share of an element that must be on screen before it rises into place. */
const THRESHOLD = 0.12;

/**
 * Scroll reveals, as on apple.com: each matching element under `container` fades and
 * rises into place the first time it scrolls into view, staggered with its neighbours.
 *
 * Elements are hidden only once an observer is watching them, so content never stays
 * invisible: without IntersectionObserver, or with Reduce Motion, nothing is hidden.
 * Pass `key` to pick up elements added later (a list that grows).
 */
export function useReveal(
  container: RefObject<HTMLElement | null>,
  selector = ":scope > *",
  key: unknown = undefined,
): void {
  useEffect(() => {
    const root = container.current;
    if (!root || typeof IntersectionObserver === "undefined" || prefersReducedMotion()) return;
    const targets = [...root.querySelectorAll<HTMLElement>(selector)].filter(
      (element) => !element.dataset.reveal,
    );
    if (targets.length === 0) return;
    let batch = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        batch = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const element = entry.target as HTMLElement;
          element.style.setProperty("--reveal-i", String(batch++));
          element.dataset.reveal = "shown";
          observer.unobserve(element);
        }
      },
      { threshold: THRESHOLD },
    );
    for (const element of targets) {
      element.dataset.reveal = "pending";
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
      // Anything still waiting is shown, so a re-run never strands hidden content.
      for (const element of targets)
        if (element.dataset.reveal === "pending") element.dataset.reveal = "shown";
    };
  }, [container, selector, key]);
}
