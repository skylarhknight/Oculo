import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { durationMs } from "../theme/motion";
import { HEAVY_ROUTES, SWIPE_BACK_DISABLED, type Route } from "./routes";
import { initialStack, stackReducer, type StackEntry, type StackState } from "./stack";
import "./navigation.css";

/** Resolves false to keep the user on the current screen (for example a failed save). */
export type LeaveGuard = () => Promise<boolean>;

export interface Navigation {
  route: Route;
  canGoBack: boolean;
  push(route: Route | Route[]): void;
  /** Runs the top screen's leave guard, then pops. */
  pop(): Promise<boolean>;
  popTo(name: Route["name"]): Promise<boolean>;
  replace(route: Route | Route[]): Promise<boolean>;
  reset(routes: Route[]): void;
  /** Changes parameters of the current screen without a transition. */
  update(route: Route): void;
}

const NavigationContext = createContext<Navigation | null>(null);
const GuardContext = createContext<((key: string, guard: LeaveGuard | null) => void) | null>(null);
const EntryContext = createContext<string | null>(null);

export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error("useNavigation must be used inside NavigationProvider");
  return navigation;
}

/** Registers a guard that runs before this screen is popped or replaced. */
export function useLeaveGuard(guard: LeaveGuard): void {
  const register = useContext(GuardContext);
  const key = useContext(EntryContext);
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => {
    if (!register || key === null) return;
    register(key, () => latest.current());
    return () => register(key, null);
  }, [register, key]);
}

interface ProviderProps {
  initial: Route[];
  renderScreen: (route: Route) => ReactNode;
  /** Called with the top route after each navigation, e.g. to match system chrome. */
  onTopRouteChange?: (route: Route) => void;
}

export function NavigationStack({ initial, renderScreen, onTopRouteChange }: ProviderProps) {
  const [state, dispatch] = useReducer(stackReducer, initial, initialStack);
  const topRoute = state.entries.at(-1)!.route;
  useEffect(() => onTopRouteChange?.(topRoute), [onTopRouteChange, topRoute]);
  const stateRef = useRef<StackState>(state);
  stateRef.current = state;
  const guards = useRef(new Map<string, LeaveGuard>());
  const busy = useRef(false);

  const registerGuard = useCallback((key: string, guard: LeaveGuard | null) => {
    if (guard) guards.current.set(key, guard);
    else guards.current.delete(key);
  }, []);

  const guarded = useCallback(async (action: () => void): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    try {
      const top = stateRef.current.entries.at(-1)!;
      const guard = guards.current.get(top.key);
      if (guard && !(await guard())) return false;
      action();
      return true;
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (state.transition === "none" && state.leaving === null) return;
    const timer = setTimeout(() => dispatch({ type: "settled" }), durationMs("--dur-slow"));
    return () => clearTimeout(timer);
  }, [state.transition, state.leaving]);

  const navigation = useMemo<Navigation>(
    () => ({
      route: state.entries.at(-1)!.route,
      canGoBack: state.entries.length > 1,
      push: (route) => dispatch({ type: "push", route }),
      pop: () =>
        stateRef.current.entries.length > 1
          ? guarded(() => dispatch({ type: "pop" }))
          : Promise.resolve(false),
      popTo: (name) => guarded(() => dispatch({ type: "popTo", name })),
      replace: (route) => guarded(() => dispatch({ type: "replace", route })),
      reset: (routes) => dispatch({ type: "reset", routes }),
      update: (route) => dispatch({ type: "update", route }),
    }),
    [guarded, state.entries],
  );

  const top = state.entries.at(-1)!;
  const below = state.entries.at(-2);
  // Keep the screen underneath mounted so swipe-back reveals it and scroll position survives,
  // unless it owns a renderer.
  const keepBelow = below && !HEAVY_ROUTES.has(below.route.name) ? below : undefined;
  const layers: { entry: StackEntry; role: "below" | "top" | "leaving" }[] = [];
  if (keepBelow) layers.push({ entry: keepBelow, role: "below" });
  layers.push({ entry: top, role: "top" });
  if (state.leaving) layers.push({ entry: state.leaving, role: "leaving" });

  return (
    <NavigationContext.Provider value={navigation}>
      <GuardContext.Provider value={registerGuard}>
        <div className="nav-stack" data-transition={state.transition}>
          {layers.map(({ entry, role }) => (
            <ScreenLayer
              key={entry.key}
              entry={entry}
              role={role}
              transition={state.transition}
              canSwipeBack={
                role === "top" &&
                state.entries.length > 1 &&
                !SWIPE_BACK_DISABLED.has(entry.route.name)
              }
              onSwipeBack={() => void navigation.pop()}
            >
              {renderScreen(entry.route)}
            </ScreenLayer>
          ))}
        </div>
      </GuardContext.Provider>
    </NavigationContext.Provider>
  );
}

const EDGE_WIDTH = 20;
const COMMIT_FRACTION = 0.35;
const COMMIT_VELOCITY = 0.5;

function ScreenLayer({
  entry,
  role,
  transition,
  canSwipeBack,
  onSwipeBack,
  children,
}: {
  entry: StackEntry;
  role: "below" | "top" | "leaving";
  transition: StackState["transition"];
  canSwipeBack: boolean;
  onSwipeBack: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ id: number; x: number; t: number; dx: number } | null>(null);

  const phase =
    role === "leaving"
      ? "exit-pop"
      : role === "below"
        ? transition === "push"
          ? "cover"
          : "covered"
        : transition === "push"
          ? "enter-push"
          : transition === "pop"
            ? "enter-pop"
            : "idle";

  const setOffset = (dx: number | null) => {
    const element = ref.current;
    if (!element) return;
    const belowLayer = element.previousElementSibling as HTMLElement | null;
    if (dx === null) {
      element.style.removeProperty("--swipe-x");
      element.removeAttribute("data-swiping");
      belowLayer?.style.removeProperty("--swipe-progress");
      belowLayer?.removeAttribute("data-revealing");
      return;
    }
    element.dataset.swiping = "true";
    element.style.setProperty("--swipe-x", `${dx}px`);
    if (belowLayer) {
      belowLayer.dataset.revealing = "true";
      belowLayer.style.setProperty(
        "--swipe-progress",
        String(Math.min(1, dx / element.clientWidth)),
      );
    }
  };

  return (
    <EntryContext.Provider value={entry.key}>
      <div
        ref={ref}
        className="nav-screen"
        data-phase={phase}
        data-route={entry.route.name}
        inert={role !== "top"}
        aria-hidden={role !== "top"}
        onPointerDown={(event) => {
          if (!canSwipeBack || event.pointerType === "mouse") return;
          if (event.clientX > EDGE_WIDTH) return;
          swipe.current = { id: event.pointerId, x: event.clientX, t: event.timeStamp, dx: 0 };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = swipe.current;
          if (!current || current.id !== event.pointerId) return;
          current.dx = Math.max(0, event.clientX - current.x);
          setOffset(current.dx);
        }}
        onPointerUp={(event) => {
          const current = swipe.current;
          if (!current || current.id !== event.pointerId) return;
          swipe.current = null;
          const width = ref.current?.clientWidth ?? 1;
          const velocity = current.dx / Math.max(1, event.timeStamp - current.t);
          setOffset(null);
          if (current.dx / width > COMMIT_FRACTION || velocity > COMMIT_VELOCITY) onSwipeBack();
        }}
        onPointerCancel={() => {
          swipe.current = null;
          setOffset(null);
        }}
      >
        {children}
      </div>
    </EntryContext.Provider>
  );
}
