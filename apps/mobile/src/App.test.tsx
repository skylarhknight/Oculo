import { DEFAULT_APP_PREFERENCES, migrateScene, shotKeyframeCamera } from "@oculo/scene-schema";
import { rollDegrees } from "@oculo/camera-core";
// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CameraState, SceneEngine } from "@oculo/scene-core";
import type { SceneViewer } from "./components/SceneViewer";
import type { ScenePreview } from "./components/ScenePreview";
import { AuthError, type AuthService, type AuthState, type AuthUser } from "./services/AuthService";
import type * as AuthModule from "./services/AuthService";
import type { PurchaseService, PurchaseState } from "./services/PurchaseService";
import type { GeneratedSheetPage, SheetDocument } from "./services/shotSheet";
import type * as SheetModule from "./services/shotSheet";
import type { PreparedShare, SharingService } from "./services/SharingService";
import type { BackupProjectCandidate, SyncState } from "./store/SyncedProjectStore";
import type { GalleryAsset, ProjectStore } from "./store/ProjectStore";
import type * as StoreModule from "./store/ProjectStore";
import { cloneCamera, DEFAULT_CAMERA, type Project, type SceneWorkspace } from "./types/project";
import { firstScene, migrated, type SingleSceneDocument } from "./test/projectFixtures";
import { fromCameraState, toCameraState } from "./services/cameraState";
import App from "./App";
import { SCENE_GALLERY } from "./config/sceneCatalog";

type EngineDouble = Pick<
  SceneEngine,
  | "getCameraState"
  | "setCameraState"
  | "setPlaybackActive"
  | "captureShot"
  | "captureStillsAt"
  | "start"
  | "stop"
  | "setPlanOverlay"
  | "setPlanOverlayVisible"
  | "pickShotMarker"
  | "setNavigationEnabled"
  | "pickFocusDistance"
  | "enterMapView"
  | "exitMapView"
  | "teleportToMannequin"
  | "onMapViewChange"
  | "preloadMapView"
  | "isMapViewActive"
  | "projectShotMarkers"
> & {
  navigation: { setInput: ReturnType<typeof vi.fn>; speedMultiplier: number };
  readonly map: MapDouble | undefined;
  mapControls: MapDouble;
};

interface MapDouble {
  readonly phase: string;
  startCarry: ReturnType<typeof vi.fn>;
  carryTo: ReturnType<typeof vi.fn>;
  drop: ReturnType<typeof vi.fn>;
  placeAt: ReturnType<typeof vi.fn>;
  figureScreenPosition: ReturnType<typeof vi.fn>;
  rotateBy: ReturnType<typeof vi.fn>;
  snapTo: ReturnType<typeof vi.fn>;
  turn: ReturnType<typeof vi.fn>;
}

const harness = vi.hoisted(() => ({
  projects: new Map<string, Project>(),
  firebaseEnabled: false,
  authState: { status: "signed-out" } as AuthState,
  authListeners: new Set<(state: AuthState) => void>(),
  list: vi.fn<ProjectStore["list"]>(),
  get: vi.fn<ProjectStore["get"]>(),
  put: vi.fn<ProjectStore["put"]>(),
  delete: vi.fn<ProjectStore["delete"]>(),
  setUser: vi.fn<(uid: string | null) => void>(),
  clearSyncState: vi.fn<() => Promise<void>>(),
  deleteCloudData: vi.fn<() => Promise<void>>(),
  listBackupCandidates: vi.fn<() => Promise<BackupProjectCandidate[]>>(),
  adoptLocalProjects: vi.fn<(ids: readonly string[]) => Promise<void>>(),
  syncNow: vi.fn<() => Promise<void>>(),
  galleryAssets: new Map<string, GalleryAsset>(),
  previewed: [] as string[],
  auth: {
    getState: vi.fn<AuthService["getState"]>(),
    subscribe: vi.fn<AuthService["subscribe"]>(),
    signInWithGoogle: vi.fn<AuthService["signInWithGoogle"]>(),
    signInWithApple: vi.fn<AuthService["signInWithApple"]>(),
    signInWithEmail: vi.fn<AuthService["signInWithEmail"]>(),
    signUpWithEmail: vi.fn<AuthService["signUpWithEmail"]>(),
    sendPasswordReset: vi.fn<AuthService["sendPasswordReset"]>(),
    signOut: vi.fn<AuthService["signOut"]>(),
    deleteAccount: vi.fn<AuthService["deleteAccount"]>(),
  },
  purchases: {
    initialize: vi.fn<PurchaseService["initialize"]>(),
    refresh: vi.fn<PurchaseService["refresh"]>(),
    logIn: vi.fn<PurchaseService["logIn"]>(),
    logOut: vi.fn<PurchaseService["logOut"]>(),
    purchasePro: vi.fn<PurchaseService["purchasePro"]>(),
    restore: vi.fn<PurchaseService["restore"]>(),
  },
  viewerMounts: vi.fn(),
  viewerProps: null as ComponentProps<typeof SceneViewer> | null,
  holdSceneReady: false,
  pickedShot: undefined as string | undefined,
  focusDistance: undefined as number | undefined,
  engine: null as EngineDouble | null,
  generate: vi.fn<(document: SheetDocument) => Promise<GeneratedSheetPage[]>>(),
  prepare: vi.fn<SharingService["prepare"]>(),
  share: vi.fn<PreparedShare["share"]>(),
  download: vi.fn<PreparedShare["download"]>(),
  dispose: vi.fn<PreparedShare["dispose"]>(),
}));

// Keep the actual editor, persistence coordinator, sheet model/workspace, and
// account UI. Substitute only device/provider boundaries and PNG rendering.
vi.mock("./store/ProjectStore", async (importOriginal) => ({
  ...(await importOriginal<typeof StoreModule>()),
  IndexedDBProjectStore: class {
    list = harness.list;
    get = harness.get;
    put = harness.put;
    delete = harness.delete;
    async duplicateProject(id: string, newId: string, name: string) {
      const source = harness.projects.get(id);
      if (!source) throw new Error("The project to duplicate no longer exists");
      const copy = { ...structuredClone(source), id: newId, name };
      harness.projects.set(newId, copy);
      return copy;
    }
    async getPreferences() {
      return { ...DEFAULT_APP_PREFERENCES, tutorialSeeded: true };
    }
    async putPreferences() {}
    async listCameraPresets() {
      return [];
    }
    async putCameraPreset() {}
    async deleteCameraPreset() {}
    async getGalleryAsset(versionId: string) {
      return harness.galleryAssets.get(versionId);
    }
    async putGalleryAsset(asset: GalleryAsset) {
      harness.galleryAssets.set(asset.versionId, asset);
    }
    async listGalleryAssets() {
      return [...harness.galleryAssets.values()].map(
        ({ versionId, sceneId, sha256, byteSize, savedAt }) => ({
          versionId,
          sceneId,
          sha256,
          byteSize,
          savedAt,
        }),
      );
    }
    async deleteGalleryAsset(versionId: string) {
      harness.galleryAssets.delete(versionId);
    }
  },
}));
vi.mock("./store/SyncedProjectStore", () => ({
  SyncedProjectStore: class {
    list = harness.list;
    get = harness.get;
    put = harness.put;
    delete = harness.delete;
    setUser = harness.setUser;
    clearSyncState = harness.clearSyncState;
    listBackupCandidates = harness.listBackupCandidates;
    adoptLocalProjects = harness.adoptLocalProjects;
    syncNow = harness.syncNow;
    listConflicts = async () => [];
    recoverConflict = async () => undefined;
    async deleteCloudData() {
      // The real store quiesces sync before attempting cloud deletion and keeps
      // its pending deletion barrier until a retry completes or the user signs out.
      harness.setUser(null);
      await harness.deleteCloudData();
    }
    subscribeSyncState(listener: (state: SyncState) => void) {
      listener({ status: "idle", pendingCount: 0 });
      return () => undefined;
    }
  },
}));
vi.mock("./store/CloudProjectRepository", () => ({ FirestoreProjectRepository: class {} }));
vi.mock("./services/firebase", () => ({
  getFirebaseApp: () => (harness.firebaseEnabled ? {} : null),
}));
vi.mock("./services/AuthService", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  createAuthService: () => harness.auth,
}));
vi.mock("./services/PurchaseService", () => ({
  createPurchaseService: () => harness.purchases,
}));
vi.mock("./services/haptics", () => ({
  confirmHaptic: async () => undefined,
  tapHaptic: async () => undefined,
  warnHaptic: async () => undefined,
  setHapticsEnabled: () => undefined,
}));
vi.mock("./components/MagicWindowControls", () => ({
  MagicWindowControls: ({ disabled }: { disabled?: boolean }) =>
    createElement("button", { disabled, "data-testid": "handheld-control" }, "Handheld camera"),
}));
// The gallery preview owns a WebGL engine; stand in with its reported states.
vi.mock("./components/ScenePreview", async () => {
  const { useEffect } = await import("react");
  return {
    ScenePreview: function FakeScenePreview(props: ComponentProps<typeof ScenePreview>) {
      const name = props.descriptor?.name;
      useEffect(() => {
        if (!name) return props.onStatus("idle");
        harness.previewed.push(name);
        props.onStatus("ready");
      }, [name]);
      return createElement("canvas", { "data-testid": "scene-preview", "aria-label": props.label });
    },
  };
});
vi.mock("./components/SceneViewer", async () => {
  const { useEffect, useRef } = await import("react");
  const { toCameraState: convertCamera } = await import("./services/cameraState");
  return {
    SceneViewer: function FakeSceneViewer(props: ComponentProps<typeof SceneViewer>) {
      harness.viewerProps = props;
      const initial = useRef(props);
      useEffect(() => {
        const input = initial.current;
        let camera = convertCamera(input.camera);
        const base = {
          getCameraState: vi.fn(() => structuredClone(camera)),
          setCameraState: vi.fn((next: CameraState) => {
            camera = structuredClone(next);
          }),
          setPlaybackActive: vi.fn(),
          captureShot: vi.fn(() => ({
            camera: structuredClone(camera),
            thumbnailDataUrl: "data:image/png;base64,Y2FwdHVyZWQ=",
          })),
          captureStillsAt: vi.fn(async (cameras: readonly CameraState[]) =>
            cameras.map(() => "data:image/jpeg;base64,cmVuZGVyZWQ="),
          ),
          start: vi.fn(),
          stop: vi.fn(),
          setPlanOverlay: vi.fn(),
          setPlanOverlayVisible: vi.fn(),
          pickShotMarker: vi.fn(() => harness.pickedShot),
          setNavigationEnabled: vi.fn(),
          pickFocusDistance: vi.fn(() => harness.focusDistance),
          navigation: { setInput: vi.fn(), speedMultiplier: 1 },
        };
        // Keep the map getter live (a spread would freeze it).
        const engine = Object.defineProperties(
          base,
          Object.getOwnPropertyDescriptors(
            mapDouble(
              () => camera,
              (next) => {
                camera = next;
              },
            ),
          ),
        ) as unknown as EngineDouble;
        harness.engine = engine;
        input.engineRef.current = engine as unknown as SceneEngine;
        harness.viewerMounts();
        if (!harness.holdSceneReady) input.onReady?.();
        return () => {
          input.engineRef.current = null;
          harness.engine = null;
        };
      }, []);
      return createElement("canvas", { "data-testid": "scene-viewer" });
    },
  };
});
vi.mock("./components/VideoExportDialog", () => ({
  VideoExportDialog: ({ onClose, shots }: { onClose: () => void; shots: { name: string }[] }) =>
    createElement(
      "button",
      { onClick: onClose, "data-shots": shots.map((shot) => shot.name).join("|") },
      "Close test export",
    ),
}));
vi.mock("./services/shotSheet", async (importOriginal) => ({
  ...(await importOriginal<typeof SheetModule>()),
  generateShotSheet: harness.generate,
}));
vi.mock("./services/SharingService", () => ({
  createSharingService: () => ({ prepare: harness.prepare }),
}));

/** Map-view session double: phases advance synchronously, the teleport lands at `teleportTo`. */
function mapDouble(read: () => CameraState, write: (camera: CameraState) => void) {
  let phase = "off";
  const listeners = new Set<(event: { phase: string; azimuth: number }) => void>();
  const setPhase = (next: string) => {
    phase = next;
    for (const listener of listeners) listener({ phase: next as never, azimuth: 0 });
  };
  const controls: MapDouble = {
    get phase() {
      return phase;
    },
    startCarry: vi.fn(() => setPhase("dragging")),
    carryTo: vi.fn(() => true),
    drop: vi.fn(() => {
      setPhase("placed");
      return true;
    }),
    placeAt: vi.fn(() => {
      setPhase("placed");
      return true;
    }),
    figureScreenPosition: vi.fn(() => ({ x: 100, y: 100 })),
    rotateBy: vi.fn(),
    snapTo: vi.fn(),
    turn: vi.fn(),
  };
  return {
    mapControls: controls,
    get map() {
      return phase === "off" ? undefined : controls;
    },
    onMapViewChange: vi.fn((listener: (event: { phase: string; azimuth: number }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as unknown as SceneEngine["onMapViewChange"],
    get isMapViewActive() {
      return phase !== "off";
    },
    preloadMapView: vi.fn(async () => undefined),
    enterMapView: vi.fn(async () => {
      setPhase("entering");
      setPhase("map");
    }),
    exitMapView: vi.fn(async () => setPhase("off")),
    projectShotMarkers: vi.fn(() => []) as SceneEngine["projectShotMarkers"],
    teleportToMannequin: vi.fn(async () => {
      setPhase("off");
      write({ ...read(), position: [7, 1.6, -2] });
      return structuredClone(read());
    }),
  };
}

const account: AuthUser = {
  uid: "filmmaker",
  email: "filmmaker@example.com",
  displayName: "Filmmaker",
  emailVerified: true,
  providerIds: ["google.com"],
};
const free: PurchaseState = { isPro: false, available: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function emitAuth(state: AuthState) {
  harness.authState = state;
  for (const listener of harness.authListeners) listener(state);
}

function projectFixture(): SingleSceneDocument {
  const start = cloneCamera(DEFAULT_CAMERA);
  const end = cloneCamera(DEFAULT_CAMERA);
  end.pose.position = [4, 2, -3];
  end.pose.quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  end.focalLengthMm = 85;
  end.sensorWidthMm = 24;
  end.sensorHeightMm = 18;
  return {
    sceneId: "test-location",
    assetVersionId: "legacy-scene:test-location",
    schemaVersion: 2,
    id: "scout-project",
    name: "Scout plan",
    scene: migrateScene({
      id: "test-location",
      name: "Scouted interior",
      splatUrl: "https://example.com/scout.spz",
      source: "bundled",
    }),
    updatedAt: 100,
    durationSeconds: 8,
    camera: cloneCamera(DEFAULT_CAMERA),
    shots: [
      {
        assetVersionId: "legacy-scene:test-location",
        id: "wide",
        sceneId: "test-location",
        name: "Wide entrance",
        createdAt: "2026-09-10T10:00:00.000Z",
        camera: start,
        thumbnailDataUrl: "data:image/png;base64,d2lkZQ==",
      },
      {
        assetVersionId: "legacy-scene:test-location",
        id: "detail",
        sceneId: "test-location",
        name: "Window detail",
        createdAt: "2026-09-10T10:01:00.000Z",
        camera: end,
        thumbnailDataUrl: "data:image/png;base64,ZGV0YWls",
      },
    ],
    path: {
      sceneId: "test-location",
      assetVersionId: "legacy-scene:test-location",
      id: "main-path",
      name: "Main camera path",
      keyframes: [],
    },
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  };
}

function seed(project = projectFixture()) {
  harness.projects.set(project.id, migrated(project));
  return project;
}

/** The saved scene as the workspace edits it. */
function saved(): SceneWorkspace {
  const project = harness.projects.get("scout-project");
  if (!project) throw new Error("Expected the saved project");
  return firstScene(project);
}

function engine(): EngineDouble {
  if (!harness.engine) throw new Error("Expected the scene viewer to be open");
  return harness.engine;
}

function button(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

type User = ReturnType<typeof userEvent.setup>;

/** Gallery → project → scene workspace (or project → scene after leaving a scene). */
/** From the gallery, opens the project; from the project page, does nothing. */
async function openProject(user: User) {
  if (screen.queryByRole("button", { name: "New scene" })) return;
  await user.click(await screen.findByRole("button", { name: "Open Scout plan" }));
}

async function openEditor(user: User) {
  await openProject(user);
  await user.click(await screen.findByRole("button", { name: "Open scene Scouted interior" }));
  await screen.findByTestId("scene-viewer");
  await waitFor(() => expect(button("New shot").disabled).toBe(false));
}

async function leaveEditor(user: User) {
  await user.click(button("Back to project"));
  await screen.findByRole("button", { name: "Open scene Scouted interior" });
}

async function openStage(user: User, name: "Shots" | "Compose" | "Export") {
  await user.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }));
}

async function openEditorSheet(user: User) {
  await openStage(user, "Export");
  await user.click(button("Preview and share plan"));
  await screen.findByRole("heading", { name: "Shot sheet", level: 1 });
}

/** Opens the shot plan from the project page, without loading the scene. */
async function openLibrarySheet(user: User) {
  await openProject(user);
  await user.click(await screen.findByRole("button", { name: "Export shot plan" }));
  await screen.findByRole("heading", { name: "Shot sheet", level: 1 });
}

/** Saves a shot from the current camera with the shutter, then sets its lens type. */
async function createShot(user: User, lens: "Prime" | "Zoom" = "Prime") {
  await user.click(button("New shot"));
  await screen.findByRole("button", { name: "Add keyframe" });
  if (lens === "Zoom") {
    await user.click(screen.getByRole("radio", { name: "Lens" }));
    await user.click(screen.getByRole("button", { name: /^Lens setup/ }));
    const sheet = await screen.findByRole("dialog", { name: /^Lens setup/ });
    await user.click(within(sheet).getByRole("radio", { name: "Zoom" }));
    await user.click(within(sheet).getByRole("button", { name: /^Close lens setup/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Lens setup/ })).toBeNull());
  }
}

/** The fixture plus an older scene-level move, which opens as a "Camera move" shot. */
function seedMoving() {
  const project = projectFixture();
  project.path.keyframes = [
    { timeSeconds: 0, camera: cloneCamera(project.shots[0]!.camera) },
    { timeSeconds: 8, camera: cloneCamera(project.shots[1]!.camera) },
  ];
  return seed(project);
}

async function openMove(user: User) {
  await openStage(user, "Shots");
  await user.click(button("Open Camera move"));
  await screen.findByRole("button", { name: "Play Camera move" });
}

/** Saves now, the way leaving the app does. */
async function saveNow() {
  await act(async () => {
    fireEvent(window, new Event("pagehide"));
    await Promise.resolve();
  });
}

/** What the scene viewer reports after the renderer's camera moves. */
const fromCameraStateFor = (state: CameraState) =>
  fromCameraState(state, harness.viewerProps!.camera);

async function openSettings(user: User) {
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Account" });
}

/** Only playback uses these frames; saves and user interactions keep real timers. */
function controlFrames() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockReturnValue(1000);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (frameId: number) => frames.delete(frameId));
  const advance = async (elapsedSeconds: number) => {
    const pending = [...frames.values()];
    frames.clear();
    expect(pending.length).toBeGreaterThan(0);
    await act(async () => {
      for (const callback of pending) callback(1000 + elapsedSeconds * 1000);
    });
  };
  return Object.assign(advance, { pending: () => frames.size });
}

beforeEach(() => {
  harness.galleryAssets.clear();
  harness.previewed = [];
  vi.resetAllMocks();
  harness.projects.clear();
  harness.firebaseEnabled = false;
  harness.authState = { status: "signed-out" };
  harness.authListeners.clear();
  harness.engine = null;
  harness.viewerProps = null;
  harness.holdSceneReady = false;
  harness.pickedShot = undefined;
  harness.focusDistance = undefined;
  harness.list.mockImplementation(async () => structuredClone([...harness.projects.values()]));
  harness.get.mockImplementation(async (id) => structuredClone(harness.projects.get(id)));
  harness.put.mockImplementation(async (project) => {
    harness.projects.set(project.id, structuredClone(project));
  });
  harness.delete.mockImplementation(async (id) => {
    harness.projects.delete(id);
  });
  harness.auth.getState.mockImplementation(() => harness.authState);
  harness.auth.subscribe.mockImplementation((listener) => {
    harness.authListeners.add(listener);
    listener(harness.authState);
    return () => harness.authListeners.delete(listener);
  });
  harness.auth.signInWithGoogle.mockImplementation(async () => {
    emitAuth({ status: "signed-in", user: account });
    return account;
  });
  harness.auth.signOut.mockImplementation(async () => emitAuth({ status: "signed-out" }));
  for (const method of Object.values(harness.purchases)) method.mockResolvedValue(free);
  harness.clearSyncState.mockResolvedValue(undefined);
  harness.deleteCloudData.mockResolvedValue(undefined);
  harness.listBackupCandidates.mockResolvedValue([]);
  harness.adoptLocalProjects.mockResolvedValue(undefined);
  harness.syncNow.mockResolvedValue(undefined);
  harness.generate.mockResolvedValue([
    {
      name: "scout-plan-01.png",
      mimeType: "image/png",
      blob: new Blob(["generated sheet"], { type: "image/png" }),
      width: 1440,
      height: 2036,
    },
  ]);
  harness.share.mockResolvedValue("shared");
  harness.prepare.mockResolvedValue({
    files: [{ name: "scout-plan-01.png", mimeType: "image/png", size: 15 }],
    canShare: true,
    canDownload: true,
    share: harness.share,
    download: harness.download,
    dispose: harness.dispose,
  });
  URL.createObjectURL = vi.fn(() => "blob:shot-sheet-preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  cleanup();
  // Editor/sheet teardown flushes the real coordinator before the next fixture.
  await act(async () => undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App scene-to-shot-sheet workflow", () => {
  it.each(["New project", "Duplicate"])(
    "offers Pro for %s when the free project is occupied and preserves existing work",
    async (action) => {
      seed();
      const original = structuredClone(saved());
      const user = userEvent.setup();
      render(createElement(App));
      await screen.findByRole("button", { name: "Open Scout plan" });
      if (action === "Duplicate") {
        await user.click(button("More actions for Scout plan"));
        await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
      } else await user.click(button(action));
      expect(await screen.findByRole("dialog", { name: /Keep your projects/ })).toBeDefined();
      expect(harness.projects.size).toBe(1);
      expect(saved()).toEqual(original);
      await user.click(button("Close Oculo Pro"));
      await openEditor(user);
      expect(button("New shot")).toBeDefined();
    },
  );

  it("does not count the tutorial toward the free project", async () => {
    seed();
    const tutorial = migrated({ ...projectFixture(), id: "tutorial" });
    harness.projects.set("tutorial", { ...tutorial, tutorial: true, name: "Tutorial" });
    const user = userEvent.setup();
    render(createElement(App));
    await screen.findByRole("button", { name: "Open Tutorial" });
    await user.click(button("New project"));
    expect(await screen.findByRole("dialog", { name: /Keep your projects/ })).toBeDefined();
    harness.projects.delete("scout-project");
    await user.click(button("Close Oculo Pro"));
    await user.click(button("New project"));
    expect(await screen.findByRole("button", { name: "Preview Small Garden" })).toBeDefined();
  });

  it("allows Pro to create a second demo project and lands in its scene", async () => {
    seed();
    harness.purchases.logOut.mockResolvedValue({ ...free, isPro: true });
    const user = userEvent.setup();
    render(createElement(App));
    await screen.findByRole("button", { name: "Oculo Pro" });
    await user.click(button("New project"));
    // Nothing is picked yet, so Select waits.
    expect(button("Select").disabled).toBe(true);
    await user.click(await screen.findByRole("button", { name: "Preview Small Garden" }));
    expect(harness.previewed).toEqual(["Small Garden"]);
    expect(button("Preview Small Garden").getAttribute("aria-pressed")).toBe("true");
    await user.click(button("Select scene"));
    await waitFor(() => expect(harness.projects.size).toBe(2));
    expect(harness.projects.has("scout-project")).toBe(true);
    const created = [...harness.projects.values()].find(
      (project) => project.id !== "scout-project",
    );
    expect(created?.name).toBe("Small Garden");
    expect(created?.scenes.map((scene) => scene.name)).toEqual(["Small Garden"]);
    await screen.findByTestId("scene-viewer");
    await user.click(button("Back to project"));
    expect(await screen.findByRole("button", { name: "Open scene Small Garden" })).toBeDefined();
  });

  it("names settings and shot sheets, excludes the workspace, and returns keyboard focus after closing", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await user.click(await screen.findByRole("button", { name: "Open Scout plan" }));
    const settings = await screen.findByRole("button", { name: "Project settings" });
    await user.click(settings);
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Project settings" }));
    expect(screen.queryByRole("button", { name: "New scene" })).toBeNull();
    expect(button("Close project settings")).toBeDefined();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(settings);
    await openEditor(user);
    await openStage(user, "Shots");
    const edit = button("Edit Wide entrance");
    await user.click(edit);
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Edit shot" }));
    expect(screen.queryByRole("button", { name: "New shot" })).toBeNull();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Unsaved title");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(edit);
    expect(button("Edit Wide entrance")).toBe(edit);
    expect(screen.queryByRole("button", { name: "Edit Unsaved title" })).toBeNull();
    await user.click(edit);
    await user.click(button("Delete shot"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Wide entrance" })).toBeNull();
    expect(button("Edit Window detail")).toBeDefined();
    await waitFor(() => expect(saved().shots.map((shot) => shot.id)).toEqual(["detail"]));
  });

  it("keeps Oculo Pro open during a purchase and restores focus after a cancelled purchase", async () => {
    const available: PurchaseState = { ...free, available: true, mode: "demo" };
    harness.purchases.logOut.mockResolvedValue(available);
    const pending = deferred<PurchaseState>();
    harness.purchases.purchasePro.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(createElement(App));
    const opener = await screen.findByRole("button", { name: "Upgrade" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", {
      name: /Keep your projects/,
      description: /one saved project/,
    });
    expect(document.activeElement).toBe(dialog);
    await user.click(button("Get Oculo Pro"));
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(dialog.parentElement!);
    expect(button("Close Oculo Pro").disabled).toBe(true);
    expect(screen.getByRole("dialog")).toBe(dialog);
    await act(async () => pending.resolve({ ...available, cancelled: true }));
    expect(
      screen.getByText("Purchase cancelled. Your projects are unchanged.").getAttribute("role"),
    ).toBe("status");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(opener);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps account focus and its original opener across a sign-in content replacement", async () => {
    const user = userEvent.setup();
    render(createElement(App));
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const opener = await screen.findByRole("button", { name: "Account" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Account" });
    await user.click(button("Continue with Google"));
    await screen.findByRole("button", { name: "Sign out" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(document.activeElement).toBe(dialog);
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(opener);
  });

  it("opens a one-shot library sheet and shares it without loading a scene or requiring a move", async () => {
    const project = projectFixture();
    project.shots = project.shots.slice(0, 1);
    seed(project);
    const user = userEvent.setup();
    render(createElement(App));
    await openLibrarySheet(user);
    await user.click(await screen.findByRole("button", { name: "Preview shot sheet" }));
    await screen.findByRole("region", { name: "Generated shot sheet preview" });
    expect(harness.get).toHaveBeenCalledWith(project.id);
    expect(harness.generate.mock.calls[0]?.[0].shots.map((shot) => shot.id)).toEqual(["wide"]);
    expect(harness.viewerMounts).not.toHaveBeenCalled();
    expect(harness.share).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Share shot sheet" }));
    await screen.findByText("Files handed to the selected app.");
    expect(harness.share).toHaveBeenCalledTimes(1);
    await user.click(button("Close shot sheet"));
    await screen.findByRole("button", { name: "Export shot plan" });
    expect(harness.viewerMounts).not.toHaveBeenCalled();
  });

  it("cleans exclusions when a shot is deleted in the editor, then generates the remaining sheet", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await openEditorSheet(user);
    await user.click(screen.getByLabelText("Include Wide entrance"));
    await user.click(button("Close shot sheet"));
    await screen.findByTestId("scene-viewer");
    expect(saved().shotSheet?.excludedShotIds).toEqual(["wide"]);
    await openStage(user, "Shots");
    await user.click(button("Edit Wide entrance"));
    await user.click(button("Delete shot"));
    await openEditorSheet(user);
    expect(screen.queryByLabelText("Include Wide entrance")).toBeNull();
    await user.click(button("Preview shot sheet"));
    await screen.findByRole("region", { name: "Generated shot sheet preview" });
    expect(saved().shotSheet?.excludedShotIds).toEqual([]);
    expect(saved().shots.map((shot) => shot.id)).toEqual(["detail"]);
    expect(harness.generate.mock.calls[0]?.[0].shots.map((shot) => shot.id)).toEqual(["detail"]);
  });

  it("renders hydrated tray images and opens a saved shot at its first keyframe after reopening", async () => {
    const project = projectFixture();
    project.shots[1]!.camera.output.aspectRatio = 1;
    seed(project);
    // Library summaries may omit media; opening the editor must use the fresh,
    // hydrated store read and give the browser an actual image to lay out.
    harness.list.mockResolvedValueOnce([
      migrated({
        ...structuredClone(project),
        shots: project.shots.map((shot) => {
          const metadata = { ...shot };
          delete metadata.thumbnailDataUrl;
          return metadata;
        }),
      }),
    ]);
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await openStage(user, "Shots");

    const open = button("Open Window detail");
    const image = open.querySelector("img");
    expect(harness.get).toHaveBeenCalledWith(project.id);
    expect(image?.getAttribute("src")).toBe(project.shots[1]!.thumbnailDataUrl);
    expect(image?.draggable).toBe(false);
    await user.click(image!);
    expect(engine().getCameraState()).toEqual(toCameraState(project.shots[1]!.camera));
    // Opening a shot edits it in Compose.
    expect(await screen.findByRole("button", { name: "Add keyframe" })).toBeDefined();
    expect(button("Close shot")).toBeDefined();

    await leaveEditor(user);
    await openEditor(user);
    await openStage(user, "Shots");
    expect(button("Open Window detail").querySelector("img")?.getAttribute("src")).toBe(
      project.shots[1]!.thumbnailDataUrl,
    );
    expect(engine().getCameraState()).toEqual(toCameraState(project.shots[1]!.camera));
  });

  it("creates a static shot from the live camera atomically and shows it in the library sheet", async () => {
    const project = projectFixture();
    project.shots = [];
    seed(project);
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    // Renderer navigation is ahead of the throttled React camera snapshot.
    const live = {
      ...toCameraState(project.camera),
      position: [8, 3, -4] as [number, number, number],
    };
    engine().setCameraState(live);
    await createShot(user);
    await waitFor(() => expect(saved().shots).toHaveLength(1));
    const shot = saved().shots[0]!;
    expect(shot.keyframes).toHaveLength(1);
    expect(shot.keyframes[0]!.pose.position).toEqual(live.position);
    expect(shot.setup.lens).toEqual({ kind: "prime", focalLengthMm: 35 });
    expect(shot.thumbnailDataUrl).toBe("data:image/png;base64,Y2FwdHVyZWQ=");
    expect(engine().captureShot).toHaveBeenCalledWith({ maxSize: 480 });
    expect(button("Choose shot").textContent).toContain("Static · 3.0s");
    await openStage(user, "Shots");
    expect(button("Open Shot 01").querySelector("img")?.getAttribute("src")).toBe(
      shot.thumbnailDataUrl,
    );
    await leaveEditor(user);
    await openLibrarySheet(user);
    expect(await screen.findByAltText("Saved frame for Shot 01")).toBeDefined();
    await user.click(button("Preview shot sheet"));
    await screen.findByRole("region", { name: "Generated shot sheet preview" });
    expect(harness.generate.mock.calls[0]?.[0].shots[0]?.camera.pose.position).toEqual(
      live.position,
    );
    expect(harness.viewerMounts).toHaveBeenCalledTimes(1);
  });

  it("keeps unsaved edits in the editor when leaving fails and completes the sheet transition on retry", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    harness.put.mockRejectedValueOnce(new Error("Device storage is full"));
    await openStage(user, "Export");
    await user.click(button("Preview and share plan"));
    await screen.findByText(/Device storage is full/);
    expect(screen.getByTestId("scene-viewer")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Shot sheet", level: 1 })).toBeNull();
    expect(engine().start).toHaveBeenCalled();
    await user.click(screen.getAllByRole("button", { name: "Retry save" })[0]!);
    await waitFor(() => expect(screen.queryByText(/Device storage is full/)).toBeNull());
    await user.click(button("Preview and share plan"));
    await screen.findByRole("heading", { name: "Shot sheet", level: 1 });
    expect(saved().shots).toHaveLength(2);
  });

  it("turns a static shot into a moving shot and plays to its exact last keyframe after changing its length", async () => {
    const project = projectFixture();
    project.shots = [];
    seed(project);
    const user = userEvent.setup();
    const advance = controlFrames();
    render(createElement(App));
    await openEditor(user);
    await createShot(user, "Zoom");
    const end = { ...engine().getCameraState(), position: [4, 2, -3] as [number, number, number] };
    engine().setCameraState(end);
    await user.click(button("Add keyframe"));
    await waitFor(() => expect(saved().shots[0]!.keyframes).toHaveLength(2));
    let shot = saved().shots[0]!;
    expect(shot.keyframes.map((frame) => frame.timeSeconds)).toEqual([0, 3]);
    expect(shot.keyframes[1]!.pose.position).toEqual(end.position);
    expect(button("Choose shot").textContent).toContain("Moving · 2 keyframes · 3.0s");

    await user.click(screen.getByRole("radio", { name: "Move" }));
    fireEvent.change(screen.getByRole("slider", { name: "Shot length in seconds" }), {
      target: { value: "6" },
    });
    await waitFor(() => expect(saved().shots[0]!.durationSeconds).toBe(6));
    shot = saved().shots[0]!;
    expect(shot.keyframes.map((frame) => frame.timeSeconds)).toEqual([0, 6]);

    vi.mocked(engine().setCameraState).mockClear();
    await user.click(button("Play Shot 01"));
    expect(engine().setPlaybackActive).toHaveBeenLastCalledWith(true);
    expect(vi.mocked(engine().setPlaybackActive).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(engine().setCameraState).mock.invocationCallOrder[0]!,
    );
    expect(button("Handheld camera").disabled).toBe(true);
    await advance(6.1);
    await screen.findByRole("button", { name: "Play Shot 01" });
    expect(engine().getCameraState()).toEqual(
      toCameraState(shotKeyframeCamera(shot.setup, shot.keyframes[1]!)),
    );
    expect(engine().setPlaybackActive).toHaveBeenLastCalledWith(false);
    expect(button("Handheld camera").disabled).toBe(false);
    expect(advance.pending()).toBe(0);
  });

  it("updates the keyframe under the playhead and inserts keyframes between others", async () => {
    const project = projectFixture();
    project.shots = [];
    seed(project);
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await createShot(user);
    engine().setCameraState({ ...engine().getCameraState(), position: [4, 1, 0] });
    await user.click(button("Add keyframe"));
    // Moving the camera away from a keyframe offers to update it in place.
    engine().setCameraState({ ...engine().getCameraState(), position: [5, 1, 0] });
    act(() => harness.viewerProps?.onCameraChange(fromCameraStateFor(engine().getCameraState())));
    await user.click(await screen.findByRole("button", { name: "Update keyframe 2" }));
    await waitFor(() =>
      expect(saved().shots[0]!.keyframes.map((frame) => frame.pose.position)).toEqual([
        project.camera.pose.position,
        [5, 1, 0],
      ]),
    );
    // Between keyframes, Add keyframe records where the playhead is.
    const slider = screen.getByRole("slider", { name: "Shot 01 playhead" });
    fireEvent.keyDown(slider, { key: "Home" });
    for (let step = 0; step < 15; step += 1) fireEvent.keyDown(slider, { key: "ArrowRight" });
    engine().setCameraState({ ...engine().getCameraState(), position: [2, 3, 0] });
    await user.click(button("Add keyframe"));
    await waitFor(() => expect(saved().shots[0]!.keyframes).toHaveLength(3));
    const middle = saved().shots[0]!.keyframes[1]!;
    expect(middle.timeSeconds).toBeCloseTo(1.5, 6);
    expect(middle.pose.position).toEqual([2, 3, 0]);
    await user.click(button("Keyframe 2 at 1.5s"));
    await user.click(screen.getByRole("radio", { name: "Move" }));
    await user.click(button("Delete keyframe 2"));
    await waitFor(() => expect(saved().shots[0]!.keyframes).toHaveLength(2));
  });

  it("keeps zoom inside the shot's lens: a prime locks it and a zoom clamps it", async () => {
    const project = projectFixture();
    project.shots = [];
    seed(project);
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await createShot(user);
    expect(
      (screen.getByRole("slider", { name: "Focal length" }) as HTMLInputElement).disabled,
    ).toBe(true);
    await user.click(button("Close shot"));
    await createShot(user, "Zoom");
    const zoom = screen.getByRole("slider", { name: "Focal length" }) as HTMLInputElement;
    expect(zoom.disabled).toBe(false);
    expect(zoom.max).toBe("70");
    fireEvent.change(zoom, { target: { value: "50" } });
    await user.click(button("Add keyframe"));
    await waitFor(() => expect(saved().shots[1]!.keyframes).toHaveLength(2));
    expect(saved().shots[1]!.setup.lens).toEqual({
      kind: "zoom",
      minFocalLengthMm: 24,
      maxFocalLengthMm: 70,
    });
    expect(saved().shots[1]!.keyframes[1]!.focalLengthMm).toBeCloseTo(50, 6);
  });

  it("sets focus by tapping the scene and records focus, aperture and dutch angle", async () => {
    const project = projectFixture();
    project.shots = [];
    seed(project);
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await createShot(user);
    await user.click(button("Tap to focus"));
    expect(screen.getByText("Tap the subject to focus")).toBeDefined();
    harness.focusDistance = 2.456;
    const canvas = screen.getByTestId("scene-viewer");
    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 30 });
    fireEvent.pointerUp(canvas, { clientX: 20, clientY: 30 });
    expect(engine().pickFocusDistance).toHaveBeenCalledWith(20, 30);
    expect(screen.queryByText("Tap what should be sharp")).toBeNull();
    fireEvent.change(screen.getByRole("slider", { name: "Aperture" }), { target: { value: "5" } });
    fireEvent.change(screen.getByRole("slider", { name: "Dutch angle" }), {
      target: { value: "20" },
    });
    await user.click(await screen.findByRole("button", { name: "Update keyframe 1" }));
    await waitFor(() => expect(saved().shots[0]!.keyframes[0]!.focusDistanceM).toBe(2.46));
    const keyframe = saved().shots[0]!.keyframes[0]!;
    expect(keyframe.apertureFStop).toBe(8);
    expect(rollDegrees(keyframe.pose.quaternion)).toBeCloseTo(20, 4);
  });

  it("undoes and redoes keyframe edits with the keyboard", async () => {
    const project = projectFixture();
    project.shots = [];
    seed(project);
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await createShot(user);
    await user.click(button("Add keyframe"));
    await waitFor(() => expect(saved().shots[0]!.keyframes).toHaveLength(2));
    await user.keyboard("{Control>}z{/Control}");
    await saveNow();
    await waitFor(() => expect(saved().shots[0]!.keyframes).toHaveLength(1));
    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await saveNow();
    await waitFor(() => expect(saved().shots[0]!.keyframes).toHaveLength(2));
  });

  it("opens an older camera move as a moving shot and plays it to its end", async () => {
    seedMoving();
    const user = userEvent.setup();
    const advance = controlFrames();
    render(createElement(App));
    await openEditor(user);
    await openMove(user);
    const shot = saved().shots.find((item) => item.name === "Camera move")!;
    expect(shot.keyframes).toHaveLength(2);
    await user.click(button("Play Camera move"));
    await advance(8.1);
    await screen.findByRole("button", { name: "Play Camera move" });
    expect(engine().getCameraState()).toEqual(
      toCameraState(shotKeyframeCamera(shot.setup, shot.keyframes[1]!)),
    );
  });

  it.each(["visibilitychange", "pagehide"])(
    "pauses and saves the displayed frame on %s without restarting when visible",
    async (eventName) => {
      seedMoving();
      const user = userEvent.setup();
      const advance = controlFrames();
      render(createElement(App));
      await openEditor(user);
      await openMove(user);
      await user.click(button("Play Camera move"));
      await advance(2);
      const backgroundCamera = engine().getCameraState();
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      await act(async () => {
        (eventName === "pagehide" ? window : document).dispatchEvent(new Event(eventName));
      });
      expect(button("Play Camera move")).toBeDefined();
      expect(engine().setPlaybackActive).toHaveBeenLastCalledWith(false);
      expect(advance.pending()).toBe(0);
      await waitFor(() => expect(toCameraState(saved().camera)).toEqual(backgroundCamera));
      visibility.mockReturnValue("visible");
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(engine().getCameraState()).toEqual(backgroundCamera);
      expect(button("Play Camera move")).toBeDefined();
      expect(advance.pending()).toBe(0);
    },
  );

  it("releases playback before waiting for navigation saves and keeps handheld input disabled until departure", async () => {
    seedMoving();
    const user = userEvent.setup();
    const advance = controlFrames();
    render(createElement(App));
    await openEditor(user);
    await openMove(user);
    await user.click(button("Play Camera move"));
    await advance(2);
    const activeEngine = engine();
    const finalCamera = activeEngine.getCameraState();
    const pending = deferred<void>();
    harness.put.mockImplementationOnce(async (project) => {
      await pending.promise;
      harness.projects.set(project.id, structuredClone(project));
    });
    await openStage(user, "Export");
    await user.click(button("Preview and share plan"));
    expect(activeEngine.setPlaybackActive).toHaveBeenLastCalledWith(false);
    expect(activeEngine.stop).toHaveBeenCalled();
    expect(activeEngine.getCameraState()).toEqual(finalCamera);
    // Handheld is a Compose control; it is not offered on the Export stage at all.
    expect(screen.queryByTestId("handheld-control")).toBeNull();
    expect(advance.pending()).toBe(0);
    expect(screen.queryByRole("heading", { name: "Shot sheet", level: 1 })).toBeNull();
    await act(async () => pending.resolve());
    await screen.findByRole("heading", { name: "Shot sheet", level: 1 });
    expect(toCameraState(saved().camera)).toEqual(finalCamera);
  });

  it("releases the acquired engine on editor teardown even when the scene viewer clears its ref", async () => {
    seedMoving();
    const user = userEvent.setup();
    const advance = controlFrames();
    const view = render(createElement(App));
    await openEditor(user);
    await openMove(user);
    await user.click(button("Play Camera move"));
    await advance(2);
    const activeEngine = engine();
    const finalCamera = activeEngine.getCameraState();
    view.unmount();
    expect(harness.engine).toBeNull();
    expect(activeEngine.setPlaybackActive).toHaveBeenLastCalledWith(false);
    expect(activeEngine.getCameraState()).toEqual(finalCamera);
    expect(advance.pending()).toBe(0);
  });

  it("pauses navigation while anything else owns the camera and drives it from the sticks", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await waitFor(() => expect(engine().setNavigationEnabled).toHaveBeenLastCalledWith(true));
    // Tap to focus owns the next tap, so the scene stops moving until it is done.
    await user.click(button("Tap to focus"));
    expect(engine().setNavigationEnabled).toHaveBeenLastCalledWith(false);
    await user.click(button("Cancel"));
    await waitFor(() => expect(engine().setNavigationEnabled).toHaveBeenLastCalledWith(true));
    // The switch- and screen-reader-friendly nudges drive the same navigation input.
    await user.click(screen.getByRole("radio", { name: "Move" }));
    await user.click(screen.getByText("Precise moves"));
    await user.click(button("Move forward"));
    expect(engine().navigation.setInput).toHaveBeenCalledWith({ moveZ: 1 });
    await waitFor(() =>
      expect(engine().navigation.setInput).toHaveBeenLastCalledWith({ moveZ: 0 }),
    );
  });
});

describe("reversible camera editing", () => {
  it("holds history and shot recall until a retried scene has prepared its first frame", async () => {
    seedMoving();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await openMove(user);
    await user.click(screen.getByRole("radio", { name: "Move" }));
    await user.click(screen.getByRole("radio", { name: "Ease in" }));
    await user.click(button("Undo camera edit"));
    expect(button("Undo camera edit").disabled).toBe(false);
    expect(button("Redo camera edit").disabled).toBe(false);
    await saveNow();
    const before = structuredClone(saved());
    act(() => harness.viewerProps?.onError?.("Scene interrupted"));
    harness.holdSceneReady = true;
    await user.click(button("Retry scene"));
    expect(button("Undo camera edit").disabled).toBe(true);
    expect(button("Redo camera edit").disabled).toBe(true);
    await openStage(user, "Shots");
    expect(button("Open Window detail").disabled).toBe(true);
    await saveNow();
    await user.keyboard("{Control>}z{/Control}");
    await saveNow();
    expect(saved().shots).toEqual(before.shots);
    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await saveNow();
    expect(saved().shots).toEqual(before.shots);
    expect(saved().camera).toEqual(before.camera);
    act(() => harness.viewerProps?.onReady?.());
    expect(button("Undo camera edit").disabled).toBe(false);
    expect(button("Redo camera edit").disabled).toBe(false);
    expect(button("Open Window detail").disabled).toBe(false);
  });

  it("undoes a length change with the matching playhead so resuming does not jump", async () => {
    seedMoving();
    const advance = controlFrames();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await openMove(user);
    await user.click(button("Play Camera move"));
    await advance(6);
    await user.click(button("Stop Camera move"));
    const camera = engine().getCameraState();
    await user.click(screen.getByRole("radio", { name: "Move" }));
    fireEvent.change(screen.getByRole("slider", { name: "Shot length in seconds" }), {
      target: { value: "4" },
    });
    const playhead = () =>
      screen.getByRole("slider", { name: "Camera move playhead" }).getAttribute("aria-valuenow");
    expect(playhead()).toBe("3");
    await user.click(button("Undo camera edit"));
    expect(playhead()).toBe("6");
    expect(engine().getCameraState()).toEqual(camera);
    await user.click(button("Redo camera edit"));
    expect(playhead()).toBe("3");
  });

  it("renders several shots stitched together as one sequence video", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await openStage(user, "Export");
    await user.click(screen.getByRole("radio", { name: /Video/ }));
    await user.click(screen.getByRole("radio", { name: "Sequence" }));
    const list = within(screen.getByRole("list", { name: "Shots in the sequence" }));
    expect(list.getAllByRole("checkbox")).toHaveLength(2);
    await user.click(button("Render sequence"));
    expect((await screen.findByRole("button", { name: "Close test export" })).dataset.shots).toBe(
      "Wide entrance|Window detail",
    );
    await user.click(button("Close test export"));
    // Leaving a shot out keeps the rest in shot-list order.
    await user.click(list.getAllByRole("checkbox")[0]!);
    expect(screen.getByText(/^1 shot · /)).toBeDefined();
    await user.click(button("Render sequence"));
    expect((await screen.findByRole("button", { name: "Close test export" })).dataset.shots).toBe(
      "Window detail",
    );
  });

  it("preserves the live camera when opening export and persists it during an interrupted export", async () => {
    seedMoving();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    const live = { ...engine().getCameraState(), position: [7, 8, 9] as [number, number, number] };
    engine().setCameraState(live);
    await openStage(user, "Export");
    await user.click(screen.getByRole("radio", { name: /Video/ }));
    expect((screen.getByLabelText("Shot") as HTMLSelectElement).value).toBe("move-main-path");
    await user.click(button("Render shot preview"));
    expect(engine().getCameraState()).toEqual(live);
    engine().setCameraState({ ...live, position: [99, 99, 99] });
    fireEvent(window, new Event("pagehide"));
    await waitFor(() => expect(saved().camera.pose.position).toEqual([7, 8, 9]));
    engine().setCameraState(live); // The capture adapter restores its acquired camera.
    await user.click(button("Close test export"));
    await saveNow();
    expect(saved().camera.pose.position).toEqual([7, 8, 9]);
  });

  it("holds camera ownership while scrubbing, releases on cancellation, and supports keyboard endpoints", async () => {
    seedMoving();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await openMove(user);
    const shot = saved().shots.find((item) => item.name === "Camera move")!;
    const slider = screen.getByRole("slider", { name: "Camera move playhead" });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
    const down = new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 25 });
    Object.defineProperty(down, "pointerId", { value: 4 });
    fireEvent(slider, down);
    expect(engine().setPlaybackActive).toHaveBeenLastCalledWith(true);
    expect(button("Handheld camera").disabled).toBe(true);
    fireEvent.pointerCancel(slider);
    expect(engine().setPlaybackActive).toHaveBeenLastCalledWith(false);
    expect(button("Handheld camera").disabled).toBe(false);
    fireEvent.keyDown(slider, { key: "End" });
    expect(engine().getCameraState()).toEqual(
      toCameraState(shotKeyframeCamera(shot.setup, shot.keyframes[1]!)),
    );
    fireEvent.keyDown(slider, { key: "Home" });
    expect(engine().getCameraState()).toEqual(
      toCameraState(shotKeyframeCamera(shot.setup, shot.keyframes[0]!)),
    );
  });
});

describe("App account backup integration", () => {
  it("resets Pro immediately on account change and ignores the previous account's late purchase results", async () => {
    seed();
    harness.authState = { status: "signed-in", user: account };
    const pro: PurchaseState = { isPro: true, available: true };
    const previousLogin = deferred<PurchaseState>();
    const previousRefresh = deferred<PurchaseState>();
    const nextLogin = deferred<PurchaseState>();
    harness.purchases.logIn
      .mockResolvedValueOnce(pro)
      .mockReturnValueOnce(previousLogin.promise)
      .mockReturnValueOnce(nextLogin.promise);
    harness.purchases.refresh.mockReturnValueOnce(previousRefresh.promise);
    render(createElement(App));
    await screen.findByRole("button", { name: "Oculo Pro" });

    // An auth refresh for the same account and a foreground refresh may both
    // still be in flight when the filmmaker changes accounts.
    await act(async () => {
      emitAuth({ status: "signed-in", user: { ...account } });
      window.dispatchEvent(new Event("focus"));
    });
    expect(harness.purchases.refresh).toHaveBeenCalledTimes(1);
    const nextAccount = { ...account, uid: "second-filmmaker" };
    await act(async () => {
      emitAuth({ status: "signed-in", user: nextAccount });
    });
    expect(harness.purchases.logIn).toHaveBeenLastCalledWith(nextAccount.uid);
    expect(button("Upgrade")).toBeDefined();
    await act(async () => {
      previousLogin.resolve(pro);
    });
    expect(button("Upgrade")).toBeDefined();
    await act(async () => {
      previousRefresh.resolve(pro);
    });
    expect(button("Upgrade")).toBeDefined();

    await act(async () => {
      nextLogin.resolve(pro);
    });
    expect(button("Oculo Pro")).toBeDefined();
  });

  it("binds sign-in without adopting existing local projects until an explicit selection is backed up", async () => {
    seed();
    harness.firebaseEnabled = true;
    harness.listBackupCandidates.mockResolvedValue([
      {
        projectId: "scout-project",
        name: "Scout plan",
        shotCount: 2,
        missingImageCount: 0,
        legacyOwnershipUnknown: false,
      },
    ]);
    const user = userEvent.setup();
    render(createElement(App));
    await openSettings(user);
    await user.click(button("Account"));
    expect(
      screen.getByText(/Existing local projects stay on this device until you select them/),
    ).toBeDefined();
    expect(harness.adoptLocalProjects).not.toHaveBeenCalled();
    await user.click(button("Continue with Google"));
    const checkbox = await screen.findByLabelText("Scout plan");
    expect(harness.setUser).toHaveBeenLastCalledWith(account.uid);
    expect(harness.purchases.logIn).toHaveBeenCalledWith(account.uid);
    expect(harness.adoptLocalProjects).not.toHaveBeenCalled();
    expect(button(/Back up selected projects/).disabled).toBe(true);
    expect(screen.getByText(/Destination: Firebase cloud storage/).textContent).toContain(
      account.email,
    );
    await user.click(checkbox);
    expect(harness.adoptLocalProjects).not.toHaveBeenCalled();
    await user.click(button(/Back up selected projects/));
    await waitFor(() => expect(harness.adoptLocalProjects).toHaveBeenCalledWith(["scout-project"]));
    await screen.findByText(/Selected projects are linked to this account/);
  });

  it("rebinds sync after failed sign-out and quiesces it before each retry", async () => {
    seed();
    harness.firebaseEnabled = true;
    harness.authState = { status: "signed-in", user: account };
    harness.auth.signOut.mockRejectedValueOnce(new Error("Sign-out could not finish"));
    const user = userEvent.setup();
    render(createElement(App));
    await openSettings(user);
    await user.click(button("Account"));
    await user.click(button("Sign out"));
    await screen.findByText("Sign-out could not finish");
    expect(harness.clearSyncState).toHaveBeenCalledTimes(1);
    expect(harness.clearSyncState.mock.invocationCallOrder[0]).toBeLessThan(
      harness.auth.signOut.mock.invocationCallOrder[0]!,
    );
    expect(harness.setUser).toHaveBeenCalledTimes(2);
    expect(harness.setUser).toHaveBeenLastCalledWith(account.uid);
    expect(harness.setUser.mock.invocationCallOrder[1]).toBeGreaterThan(
      harness.auth.signOut.mock.invocationCallOrder[0]!,
    );
    expect(harness.authState.status).toBe("signed-in");
    await user.click(button("Sign out"));
    await waitFor(() => expect(harness.authState.status).toBe("signed-out"));
    expect(harness.clearSyncState).toHaveBeenCalledTimes(2);
    expect(harness.setUser).toHaveBeenLastCalledWith(null);
    expect(harness.projects.has("scout-project")).toBe(true);
    expect(harness.adoptLocalProjects).not.toHaveBeenCalled();
  });

  it("drains billing before cloud and Firebase deletion, retains local projects, and reports pending profile cleanup", async () => {
    seed();
    const original = structuredClone(saved());
    harness.firebaseEnabled = true;
    harness.authState = { status: "signed-in", user: account };
    harness.purchases.logIn.mockResolvedValue({ ...free, isPro: true });
    const detached = deferred<PurchaseState>();
    const cloudDeleted = deferred<void>();
    const localSyncCleared = deferred<void>();
    const events: string[] = [];
    harness.purchases.logOut.mockImplementationOnce(async () => {
      events.push("billing drain");
      return detached.promise;
    });
    harness.deleteCloudData.mockImplementation(async () => {
      events.push("cloud delete");
      return cloudDeleted.promise;
    });
    harness.auth.deleteAccount.mockImplementation(async (options) => {
      events.push("reauthenticated");
      await options?.beforeDelete?.();
      events.push("Firebase delete");
      emitAuth({ status: "signed-out" });
    });
    harness.clearSyncState.mockReturnValue(localSyncCleared.promise);
    const user = userEvent.setup();
    render(createElement(App));
    await screen.findByRole("button", { name: "Oculo Pro" });
    await openSettings(user);
    const opener = button("Account");
    await user.click(opener);
    await user.click(button("Delete account"));
    await user.click(button("Delete forever"));
    expect(events).toEqual(["reauthenticated", "billing drain"]);
    expect(button("Close account panel").disabled).toBe(true);
    await act(async () => detached.resolve(free));
    expect(events).toEqual(["reauthenticated", "billing drain", "cloud delete"]);
    // A same-user token/reauth event must not restart account-bound SDK work.
    await act(async () => emitAuth({ status: "signed-in", user: { ...account } }));
    expect(harness.purchases.logIn).toHaveBeenCalledTimes(1);
    await act(async () => cloudDeleted.resolve());
    expect(events).toEqual(["reauthenticated", "billing drain", "cloud delete", "Firebase delete"]);
    expect(button("Continue with Google").disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Account" })).toBeDefined();
    await act(async () => localSyncCleared.resolve());
    expect(
      screen.getByText(/Your Firebase account and cloud backups are deleted/).textContent,
    ).toContain("may still be processing");
    expect(button("Close account panel").disabled).toBe(false);
    expect(saved()).toEqual(original);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(opener);
  });

  it.each(["billing", "cloud", "Firebase"] as const)(
    "restores billing while retaining the sync deletion barrier after %s deletion failure",
    async (stage) => {
      seed();
      harness.firebaseEnabled = true;
      harness.authState = { status: "signed-in", user: account };
      const restored = deferred<PurchaseState>();
      harness.purchases.logIn
        .mockResolvedValueOnce({ ...free, isPro: true })
        .mockReturnValueOnce(restored.promise);
      const failure = new Error(`${stage} deletion failed`);
      if (stage === "billing") harness.purchases.logOut.mockRejectedValueOnce(failure);
      if (stage === "cloud") harness.deleteCloudData.mockRejectedValueOnce(failure);
      harness.auth.deleteAccount.mockImplementation(async (options) => {
        await options?.beforeDelete?.();
        throw failure;
      });
      const user = userEvent.setup();
      render(createElement(App));
      await screen.findByRole("button", { name: "Oculo Pro" });
      await openSettings(user);
      await user.click(button("Account"));
      await user.click(button("Delete account"));
      await user.click(button("Delete forever"));
      await waitFor(() => expect(harness.purchases.logIn).toHaveBeenCalledTimes(2));
      expect(harness.purchases.logIn).toHaveBeenLastCalledWith(account.uid);
      expect(harness.setUser.mock.calls).toEqual(
        stage === "billing" ? [[account.uid]] : [[account.uid], [null]],
      );
      expect(button("Close account panel").disabled).toBe(true);
      await act(async () => restored.resolve({ ...free, isPro: true }));
      expect(screen.getByRole("alert").textContent).toBe(failure.message);
      expect(harness.authState).toEqual({ status: "signed-in", user: account });
      expect(harness.clearSyncState).not.toHaveBeenCalled();
      // Billing recovery must not release the pending deletion barrier or bind
      // the same sync owner again, which could recreate already-deleted backups.
      expect(harness.setUser.mock.calls).toEqual(
        stage === "billing" ? [[account.uid]] : [[account.uid], [null]],
      );
      expect(harness.deleteCloudData).toHaveBeenCalledTimes(stage === "billing" ? 0 : 1);
      expect(harness.projects.has("scout-project")).toBe(true);
      await user.keyboard("{Escape}");
      expect(button("Oculo Pro")).toBeDefined();
    },
  );

  it("leaves billing and cloud data alone when deletion reauthentication is cancelled", async () => {
    seed();
    harness.firebaseEnabled = true;
    harness.authState = { status: "signed-in", user: account };
    harness.auth.deleteAccount.mockRejectedValue(new AuthError("cancelled", "Cancelled"));
    const user = userEvent.setup();
    render(createElement(App));
    await openSettings(user);
    await user.click(button("Account"));
    await user.click(button("Delete account"));
    await user.click(button("Delete forever"));
    await waitFor(() => expect(button("Delete forever").disabled).toBe(false));
    expect(harness.purchases.logOut).not.toHaveBeenCalled();
    expect(harness.purchases.logIn).toHaveBeenCalledTimes(1);
    expect(harness.deleteCloudData).not.toHaveBeenCalled();
    expect(harness.clearSyncState).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Your Firebase account and cloud backups are deleted/)).toBeNull();
  });

  it("ignores late billing rollback after a different account becomes current", async () => {
    seed();
    harness.firebaseEnabled = true;
    harness.authState = { status: "signed-in", user: account };
    const restored = deferred<PurchaseState>();
    harness.purchases.logIn
      .mockResolvedValueOnce({ ...free, isPro: true })
      .mockReturnValueOnce(restored.promise)
      .mockResolvedValue(free);
    harness.auth.deleteAccount.mockImplementation(async (options) => {
      await options?.beforeDelete?.();
      throw new Error("Deletion failed");
    });
    const user = userEvent.setup();
    render(createElement(App));
    await screen.findByRole("button", { name: "Oculo Pro" });
    await openSettings(user);
    await user.click(button("Account"));
    await user.click(button("Delete account"));
    await user.click(button("Delete forever"));
    await waitFor(() => expect(harness.purchases.logIn).toHaveBeenCalledTimes(2));
    await act(async () =>
      emitAuth({
        status: "signed-in",
        user: { ...account, uid: "second", displayName: "Second account" },
      }),
    );
    expect(harness.purchases.logIn).toHaveBeenLastCalledWith("second");
    await act(async () => restored.resolve({ ...free, isPro: true }));
    expect(harness.setUser).toHaveBeenLastCalledWith("second");
    expect(screen.queryByText("Deletion failed")).toBeNull();
    await user.keyboard("{Escape}");
    expect(button("Upgrade")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Oculo Pro" })).toBeNull();
  });

  it("aborts before Firebase deletion if the account changes during cloud cleanup", async () => {
    seed();
    harness.firebaseEnabled = true;
    harness.authState = { status: "signed-in", user: account };
    const cloudDeleted = deferred<void>();
    const deleteFirebaseUser = vi.fn();
    harness.deleteCloudData.mockReturnValue(cloudDeleted.promise);
    harness.auth.deleteAccount.mockImplementation(async (options) => {
      await options?.beforeDelete?.();
      deleteFirebaseUser();
    });
    const user = userEvent.setup();
    render(createElement(App));
    await openSettings(user);
    await user.click(button("Account"));
    await user.click(button("Delete account"));
    await user.click(button("Delete forever"));
    await waitFor(() => expect(harness.deleteCloudData).toHaveBeenCalledTimes(1));
    await act(async () => emitAuth({ status: "signed-in", user: { ...account, uid: "second" } }));
    await act(async () => cloudDeleted.resolve());
    expect(deleteFirebaseUser).not.toHaveBeenCalled();
    expect(harness.purchases.logIn.mock.calls.map(([uid]) => uid)).toEqual([account.uid, "second"]);
    expect(harness.clearSyncState).not.toHaveBeenCalled();
    expect(screen.queryByText(/Your Firebase account and cloud backups are deleted/)).toBeNull();
  });
});

describe("project → scene → shot flow", () => {
  it("adds a second scene to a project and keeps each scene's shots separate", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await user.click(await screen.findByRole("button", { name: "Open Scout plan" }));
    await user.click(await screen.findByRole("button", { name: "New scene" }));
    expect(await screen.findByText("Add a scene")).toBeDefined();
    await user.click(await screen.findByRole("button", { name: "Preview Small Garden" }));
    // The top-right Select confirms too.
    await user.click(button("Select"));
    await screen.findByTestId("scene-viewer");
    await waitFor(() => expect(button("New shot").disabled).toBe(false));
    await createShot(user);
    await waitFor(() => expect(harness.projects.get("scout-project")?.scenes).toHaveLength(2));
    await waitFor(() =>
      expect(harness.projects.get("scout-project")?.scenes[1]?.shots).toHaveLength(1),
    );
    expect(saved().shots.map((shot) => shot.id)).toEqual(["wide", "detail"]);
    await user.click(button("Back to project"));
    expect(await screen.findByRole("button", { name: "Open scene Small Garden" })).toBeDefined();
    expect(button("Open scene Scouted interior")).toBeDefined();
  });

  it("renames and deletes scenes, but never the last one", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await user.click(await screen.findByRole("button", { name: "Open Scout plan" }));
    await user.click(
      await screen.findByRole("button", { name: "More actions for scene Scouted interior" }),
    );
    expect(
      (screen.getByRole("menuitem", { name: "Delete scene" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("menuitem", { name: "Rename scene" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Lobby");
    await user.click(button("Save name"));
    await screen.findByRole("button", { name: "Open scene Lobby" });
    expect(harness.projects.get("scout-project")?.scenes[0]?.name).toBe("Lobby");
  });

  it("opens the map, places the cinematographer, and lands there as one undoable move", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    const before = toCameraState(saved().camera).position;
    await user.click(button("Map"));
    const workspace = document.querySelector(".workspace-screen") as HTMLElement;
    await waitFor(() => expect(engine().enterMapView).toHaveBeenCalled());
    expect(workspace.dataset.map).toBe("true");
    expect(harness.viewerProps?.fullBleed).toBe(true);
    expect(screen.queryByRole("group", { name: /move stick/i })).toBeNull();
    await screen.findByText("Drag the cinematographer into the scene");
    // Keyboard and assistive activation places the figure without a drag.
    fireEvent.click(button("Place the cinematographer"));
    expect(engine().mapControls.placeAt).toHaveBeenCalled();
    await screen.findByText("Swipe to aim, then Go");
    fireEvent.keyDown(window, { key: "]" });
    expect(engine().mapControls.turn).toHaveBeenCalledWith(-Math.PI / 12);
    await user.click(button("Go"));
    await waitFor(() => expect(engine().teleportToMannequin).toHaveBeenCalled());
    await waitFor(() => expect(workspace.dataset.map).toBe("false"));
    await waitFor(() => expect(toCameraState(saved().camera).position).toEqual([7, 1.6, -2]));
    await user.click(button("Undo camera edit"));
    await waitFor(() => expect(toCameraState(saved().camera).position).toEqual(before));
  });

  it("rises to an overview with a pin per shot on the Shots tab and flies into a tapped one", async () => {
    seedMoving();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await openStage(user, "Shots");
    await waitFor(() =>
      expect(engine().enterMapView).toHaveBeenCalledWith(
        expect.objectContaining({ figure: false }),
      ),
    );
    const workspace = document.querySelector(".workspace-screen") as HTMLElement;
    await waitFor(() => expect(workspace.dataset.overview).toBe("true"));
    expect(harness.viewerProps?.fullBleed).toBe(true);
    // The overview shows every shot's frustum even when markers are hidden in Compose.
    expect(engine().setPlanOverlayVisible).toHaveBeenLastCalledWith(true);
    await user.click(await screen.findByRole("button", { name: "Open Camera move from the map" }));
    await screen.findByRole("button", { name: "Play Camera move" });
    await waitFor(() => expect(engine().exitMapView).toHaveBeenCalled());
    await waitFor(() => expect(workspace.dataset.overview).toBe("false"));
  });

  it("shows one playback bar over the scene with a marker per keyframe and a capture bar", async () => {
    seedMoving();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await openMove(user);
    expect(screen.getAllByRole("slider", { name: "Camera move playhead" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Play Camera move" })).toHaveLength(1);
    const keys = within(screen.getByRole("list", { name: "Keyframes on the timeline" }));
    const markers = keys.getAllByRole("button");
    expect(markers).toHaveLength(2);
    expect(markers[0]!.getAttribute("aria-current")).toBe("true");
    await user.click(markers[1]!);
    await waitFor(() =>
      expect(keys.getAllByRole("button")[1]!.getAttribute("aria-current")).toBe("true"),
    );
    expect(button("Add keyframe")).toBeDefined();
    // The shutter's side button saves another shot at once, no sheet in between.
    const count = saved().shots.length;
    await user.click(button("New shot"));
    await waitFor(() => expect(saved().shots).toHaveLength(count + 1));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Its notes are one tap away.
    await user.click(await screen.findByRole("button", { name: "Add notes" }));
    const notes = screen.getByRole("textbox", { name: "Notes" });
    await user.type(notes, "Dolly past the plant");
    fireEvent.blur(notes);
    await waitFor(() => expect(saved().shots.at(-1)!.notes).toBe("Dolly past the plant"));
  });

  it("switches between light, dark, and system appearance", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await openSettings(user);
    const appearance = within(screen.getByRole("radiogroup", { name: "Appearance" }));
    await user.click(appearance.getByRole("radio", { name: /Light/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    await user.click(appearance.getByRole("radio", { name: /Dark/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(appearance.getByRole("radio", { name: /Dark/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("closes the map without moving the camera and rotates it from buttons", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    const before = toCameraState(saved().camera);
    await user.click(button("Map"));
    await screen.findByText("Drag the cinematographer into the scene");
    await user.click(button("Rotate map right"));
    expect(engine().mapControls.rotateBy).toHaveBeenCalledWith(Math.PI / 4);
    await user.click(button("Close map"));
    await waitFor(() => expect(engine().exitMapView).toHaveBeenCalled());
    await waitFor(() =>
      expect((document.querySelector(".workspace-screen") as HTMLElement).dataset.map).toBe(
        "false",
      ),
    );
    expect(engine().teleportToMannequin).not.toHaveBeenCalled();
    expect(toCameraState(saved().camera)).toEqual(before);
  });

  it("teleports to a saved shot when its marker is tapped in the viewport", async () => {
    const project = seed();
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await waitFor(() => expect(engine().setPlanOverlay).toHaveBeenCalled());
    const overlay = vi.mocked(engine().setPlanOverlay).mock.calls.at(-1)?.[0];
    expect(overlay?.markers.map((marker) => marker.id)).toEqual(["wide", "detail"]);
    expect(engine().setPlanOverlayVisible).toHaveBeenLastCalledWith(true);
    harness.pickedShot = "detail";
    const canvas = screen.getByTestId("scene-viewer");
    const before = engine().getCameraState();
    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50 });
    fireEvent.pointerUp(canvas, { clientX: 51, clientY: 50 });
    // A tap asks first, so a stray touch never switches shots.
    expect(engine().getCameraState()).toEqual(before);
    await user.click(await screen.findByRole("button", { name: "Open Window detail" }));
    expect(engine().getCameraState()).toEqual(toCameraState(project.shots[1]!.camera));
    await waitFor(() =>
      expect(vi.mocked(engine().setPlanOverlay).mock.calls.at(-1)?.[0]?.selectedId).toBe("detail"),
    );
    await user.click(button("View options"));
    await user.click(screen.getByRole("menuitem", { name: "Hide shots in scene" }));
    expect(engine().setPlanOverlayVisible).toHaveBeenLastCalledWith(false);
  });

  it("renders missing shot images from their saved poses without marking the project edited", async () => {
    const project = projectFixture();
    delete project.shots[1]!.thumbnailDataUrl;
    seed(project);
    const updatedAt = saved().updatedAt;
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await waitFor(() =>
      expect(saved().shots[1]?.thumbnailDataUrl).toBe("data:image/jpeg;base64,cmVuZGVyZWQ="),
    );
    expect(engine().captureStillsAt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine().captureStillsAt).mock.calls[0]?.[0]).toEqual([
      toCameraState(project.shots[1]!.camera),
    ]);
    // Only the missing image is rendered; the existing one is kept.
    expect(saved().shots[0]?.thumbnailDataUrl).toBe(project.shots[0]!.thumbnailDataUrl);
    expect(saved().updatedAt).toBe(updatedAt);
    await waitFor(() => expect(button("New shot").disabled).toBe(false));
  });

  it("shares versioned camera data from the Export stage", async () => {
    seed();
    harness.prepare.mockImplementation(async (artifacts) => {
      const [artifact] = artifacts;
      return {
        files: artifacts.map(({ name, mimeType, blob }) => ({ name, mimeType, size: blob.size })),
        canShare: true,
        canDownload: true,
        share: harness.share,
        download: harness.download,
        dispose: harness.dispose,
        artifact,
      } as unknown as PreparedShare;
    });
    const user = userEvent.setup();
    render(createElement(App));
    await openEditor(user);
    await openStage(user, "Export");
    await user.click(screen.getByRole("radio", { name: /Data/ }));
    await user.click(button("Prepare camera data"));
    await user.click(await screen.findByRole("button", { name: "Share camera data" }));
    await screen.findByText("Camera data shared.");
    const artifact = harness.prepare.mock.calls[0]?.[0][0];
    expect(artifact?.mimeType).toBe("application/json");
    expect(artifact?.name).toBe("Scout plan - Scouted interior camera data.json");
    const plan = JSON.parse(await artifact!.blob.text()) as {
      type: string;
      project: { shots: { id: string }[] };
    };
    expect(plan.type).toBe("OculoShotPlan");
    expect(plan.project.shots.map((shot) => shot.id)).toEqual(["wide", "detail"]);
  });

  it("renames a project from the gallery overflow menu", async () => {
    seed();
    const user = userEvent.setup();
    render(createElement(App));
    await user.click(await screen.findByRole("button", { name: "More actions for Scout plan" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Scout plan v2{Enter}");
    await screen.findByRole("button", { name: "Open Scout plan v2" });
    expect(harness.projects.get("scout-project")?.name).toBe("Scout plan v2");
  });
});

describe("scene gallery", () => {
  const downloadScene = () => SCENE_GALLERY.find((scene) => scene.availability === "download")!;

  it("previews a download scene only once it is on the device, then opens it", async () => {
    harness.purchases.logOut.mockResolvedValue({ ...free, isPro: true });
    const user = userEvent.setup();
    render(createElement(App));
    await screen.findByRole("button", { name: "Oculo Pro" });
    await user.click(screen.getAllByRole("button", { name: "New project" })[0]!);
    const scene = downloadScene();
    // This build has no download host: the card says so and cannot be selected.
    await user.click(await screen.findByRole("button", { name: `Preview ${scene.title}` }));
    expect(await screen.findByText(/isn't available in this build/)).toBeDefined();
    expect(button("Select").disabled).toBe(true);
    expect(harness.previewed).toEqual([]);
    cleanup();

    harness.galleryAssets.set(scene.descriptor.asset.versionId, {
      versionId: scene.descriptor.asset.versionId,
      sceneId: scene.id,
      sha256: "0".repeat(64),
      byteSize: 3,
      savedAt: 1,
      data: new Blob([new Uint8Array([1, 2, 3])]),
    });
    render(createElement(App));
    await screen.findByRole("button", { name: "Oculo Pro" });
    await user.click(screen.getAllByRole("button", { name: "New project" })[0]!);
    const card = await screen.findByRole("button", { name: `Preview ${scene.title}` });
    await waitFor(() => expect(within(card).getByText("On device")).toBeDefined());
    await user.click(card);
    await waitFor(() => expect(harness.previewed).toEqual([scene.title]));
    await user.click(button("Select scene"));
    await screen.findByTestId("scene-viewer");
    const created = [...harness.projects.values()].find((project) => project.name === scene.title);
    expect(created?.scenes[0]?.scene.id).toBe(scene.id);
  });

  it("credits every scene with its creator, source, license, and changes", async () => {
    const user = userEvent.setup();
    render(createElement(App));
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Scene credits" }));
    const sheet = await screen.findByRole("dialog", { name: "Scene credits" });
    for (const scene of SCENE_GALLERY) {
      expect(within(sheet).getByText(scene.title)).toBeDefined();
      expect(within(sheet).getAllByText(scene.credit.changes).length).toBeGreaterThan(0);
    }
    const licenses = within(sheet).getAllByRole("link", { name: "CC BY 4.0" });
    expect(licenses).toHaveLength(SCENE_GALLERY.length);
    expect(licenses[0]?.getAttribute("href")).toBe("https://creativecommons.org/licenses/by/4.0/");
  });
});
