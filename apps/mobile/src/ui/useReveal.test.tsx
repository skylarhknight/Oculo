// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setReducedMotionPreference } from "../theme/motion";
import { useReveal } from "./useReveal";

function List({ count }: { count: number }) {
  const ref = useRef<HTMLUListElement>(null);
  useReveal(ref, ":scope > li", count);
  return (
    <ul ref={ref}>
      {Array.from({ length: count }, (_, index) => (
        <li key={index}>Item {index}</li>
      ))}
    </ul>
  );
}

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly observed: Element[] = [];
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve() {}
  disconnect() {}
  show(element: Element) {
    this.callback(
      [{ isIntersecting: true, target: element } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeObserver.instances = [];
  setReducedMotionPreference(false);
});

describe("scroll reveals", () => {
  it("hides items until they scroll into view, then shows them in order", () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const { container } = render(<List count={3} />);
    const items = [...container.querySelectorAll("li")];
    expect(items.map((item) => item.dataset.reveal)).toEqual(["pending", "pending", "pending"]);
    act(() => FakeObserver.instances[0]!.show(items[1]!));
    expect(items[1]!.dataset.reveal).toBe("shown");
    expect(items[0]!.dataset.reveal).toBe("pending");
  });

  it("never hides anything without an observer or with Reduce Motion", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const plain = render(<List count={2} />);
    expect(plain.container.querySelector("[data-reveal]")).toBeNull();
    plain.unmount();

    vi.stubGlobal("IntersectionObserver", FakeObserver);
    setReducedMotionPreference(true);
    const reduced = render(<List count={2} />);
    expect(reduced.container.querySelector("[data-reveal]")).toBeNull();
  });

  it("shows whatever is still waiting when it stops watching", () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const { container, unmount } = render(<List count={2} />);
    const items = [...container.querySelectorAll("li")];
    unmount();
    expect(items.every((item) => item.dataset.reveal === "shown")).toBe(true);
  });
});
