import type { Route } from "./routes";

export interface StackEntry {
  key: string;
  route: Route;
}

export type Transition = "none" | "push" | "pop";

export interface StackState {
  entries: StackEntry[];
  /** How the current top entry arrived; drives the single screen transition. */
  transition: Transition;
  /** The entry leaving during a pop, kept until its exit animation ends. */
  leaving: StackEntry | null;
  nextKey: number;
}

export type StackAction =
  /** Pushes one route, or several with a single transition (for example project then scene). */
  | { type: "push"; route: Route | Route[] }
  | { type: "pop" }
  | { type: "popTo"; name: Route["name"] }
  /** Replaces the top screen with one route, or several with a single transition. */
  | { type: "replace"; route: Route | Route[] }
  | { type: "reset"; routes: Route[] }
  /** Updates the top route in place (for example a scene's stage tab); never animates. */
  | { type: "update"; route: Route }
  | { type: "settled" };

export function initialStack(routes: Route[]): StackState {
  if (routes.length === 0) throw new Error("A navigation stack needs a root route");
  return {
    entries: routes.map((route, index) => ({ key: `r${index}`, route })),
    transition: "none",
    leaving: null,
    nextKey: routes.length,
  };
}

export function topRoute(state: StackState): Route {
  return state.entries.at(-1)!.route;
}

export function stackReducer(state: StackState, action: StackAction): StackState {
  switch (action.type) {
    case "push": {
      const routes = Array.isArray(action.route) ? action.route : [action.route];
      if (routes.length === 0) return state;
      return {
        entries: [
          ...state.entries,
          ...routes.map((route, index) => ({ key: `r${state.nextKey + index}`, route })),
        ],
        transition: "push",
        leaving: null,
        nextKey: state.nextKey + routes.length,
      };
    }
    case "pop": {
      if (state.entries.length <= 1) return state;
      return {
        ...state,
        entries: state.entries.slice(0, -1),
        transition: "pop",
        leaving: state.entries.at(-1)!,
      };
    }
    case "popTo": {
      let index = state.entries.length - 1;
      while (index >= 0 && state.entries[index]!.route.name !== action.name) index -= 1;
      if (index < 0 || index === state.entries.length - 1) return state;
      return {
        ...state,
        entries: state.entries.slice(0, index + 1),
        transition: "pop",
        leaving: state.entries.at(-1)!,
      };
    }
    case "replace": {
      const routes = Array.isArray(action.route) ? action.route : [action.route];
      if (routes.length === 0) return state;
      return {
        entries: [
          ...state.entries.slice(0, -1),
          ...routes.map((route, index) => ({ key: `r${state.nextKey + index}`, route })),
        ],
        transition: "push",
        leaving: null,
        nextKey: state.nextKey + routes.length,
      };
    }
    case "reset":
      return {
        entries: action.routes.map((route, index) => ({
          key: `r${state.nextKey + index}`,
          route,
        })),
        transition: "none",
        leaving: null,
        nextKey: state.nextKey + action.routes.length,
      };
    case "update": {
      const top = state.entries.at(-1)!;
      if (top.route.name !== action.route.name) return state;
      return {
        ...state,
        entries: [...state.entries.slice(0, -1), { ...top, route: action.route }],
      };
    }
    case "settled":
      if (state.transition === "none" && state.leaving === null) return state;
      return { ...state, transition: "none", leaving: null };
  }
}
