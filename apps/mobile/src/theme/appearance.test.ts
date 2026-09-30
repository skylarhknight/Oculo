// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_STORAGE_KEY, applyAppearance, resolveAppearance } from "./appearance";

function mockSystem(light: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: light,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    listeners,
    change(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

describe("appearance", () => {
  it("forces light or dark regardless of the system", () => {
    mockSystem(true);
    expect(resolveAppearance("dark")).toBe("dark");
    applyAppearance("dark")();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
  });

  it("follows the system while matching it, and stops when cleaned up", () => {
    const system = mockSystem(false);
    const resolved: string[] = [];
    const cleanup = applyAppearance("system", (value) => resolved.push(value));
    expect(document.documentElement.dataset.theme).toBe("dark");
    system.change(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(resolved).toEqual(["dark", "light"]);
    cleanup();
    expect(system.listeners.size).toBe(0);
  });
});
