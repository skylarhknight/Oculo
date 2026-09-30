import { describe, expect, it } from "vitest";
import { initialStack, stackReducer, topRoute } from "./stack";

const gallery = { name: "gallery" } as const;
const project = { name: "project", projectId: "p" } as const;
const scene = { name: "scene", projectId: "p", sceneId: "s", stage: "compose" } as const;

describe("navigation stack", () => {
  it("pushes with a push transition and pops with the leaving entry retained", () => {
    let state = initialStack([gallery]);
    state = stackReducer(state, { type: "push", route: project });
    expect(state.transition).toBe("push");
    expect(topRoute(state)).toEqual(project);
    const pushedKey = state.entries.at(-1)!.key;
    state = stackReducer(state, { type: "pop" });
    expect(state.transition).toBe("pop");
    expect(state.leaving?.key).toBe(pushedKey);
    expect(topRoute(state)).toEqual(gallery);
    state = stackReducer(state, { type: "settled" });
    expect(state.leaving).toBeNull();
    expect(state.transition).toBe("none");
  });

  it("never pops the root", () => {
    const state = initialStack([gallery]);
    expect(stackReducer(state, { type: "pop" })).toBe(state);
  });

  it("pops back to the nearest named route", () => {
    let state = initialStack([gallery]);
    for (const route of [project, scene]) state = stackReducer(state, { type: "push", route });
    state = stackReducer(state, { type: "popTo", name: "gallery" });
    expect(state.entries.map((entry) => entry.route.name)).toEqual(["gallery"]);
    expect(state.leaving?.route.name).toBe("scene");
  });

  it("updates the top route in place without a transition or new key", () => {
    let state = initialStack([gallery]);
    state = stackReducer(state, { type: "push", route: scene });
    state = stackReducer(state, { type: "settled" });
    const key = state.entries.at(-1)!.key;
    state = stackReducer(state, { type: "update", route: { ...scene, stage: "shots" } });
    expect(state.entries.at(-1)).toEqual({ key, route: { ...scene, stage: "shots" } });
    expect(state.transition).toBe("none");
    expect(stackReducer(state, { type: "update", route: gallery })).toBe(state);
  });

  it("gives every entry a unique key, even after replace and reset", () => {
    let state = initialStack([gallery]);
    state = stackReducer(state, { type: "push", route: project });
    state = stackReducer(state, { type: "replace", route: scene });
    state = stackReducer(state, { type: "reset", routes: [gallery, project] });
    state = stackReducer(state, { type: "push", route: scene });
    const keys = state.entries.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("pushes several routes with one transition", () => {
    const state = stackReducer(initialStack([gallery]), { type: "push", route: [project, scene] });
    expect(state.entries.map((entry) => entry.route.name)).toEqual(["gallery", "project", "scene"]);
    expect(state.transition).toBe("push");
  });
});
