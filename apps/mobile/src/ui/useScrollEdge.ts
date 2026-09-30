import { useCallback, useRef } from "react";

/**
 * Marks the enclosing `.screen` with `data-scrolled="true"` once content scrolls
 * under the navigation bar, so CSS can add bar material and collapse the large
 * title. Attach the returned ref to a zero-height sentinel at the top of the
 * scrolling content.
 */
export function useScrollEdge() {
  const observer = useRef<IntersectionObserver | null>(null);
  return useCallback((sentinel: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const screen = sentinel.closest<HTMLElement>(".screen");
    const root = sentinel.closest<HTMLElement>(".screen-scroll");
    if (!screen) return;
    observer.current = new IntersectionObserver(
      ([entry]) => {
        if (entry) screen.dataset.scrolled = String(!entry.isIntersecting);
      },
      { root },
    );
    observer.current.observe(sentinel);
  }, []);
}
