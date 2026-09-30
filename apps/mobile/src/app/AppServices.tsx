import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { resolveSceneAsset } from "../services/sceneImport";
import { IndexedDBProjectStore, type ProjectStore } from "../store/ProjectStore";
import { FirestoreProjectRepository } from "../store/CloudProjectRepository";
import { SyncedProjectStore, type SyncState } from "../store/SyncedProjectStore";
import { createWorkspaceStore, type WorkspaceStore } from "../store/WorkspaceStore";
import {
  createPurchaseService,
  type PurchaseService,
  type PurchaseState,
} from "../services/PurchaseService";
import { createAuthService, type AuthService, type AuthState } from "../services/AuthService";
import { getFirebaseApp } from "../services/firebase";
import type { Project, SceneDescriptor } from "../types/project";
import {
  DEFAULT_APP_PREFERENCES,
  type AppPreferences,
  type CameraPreset,
} from "@oculo/scene-schema";
import { setReducedMotionPreference } from "../theme/motion";
import { setHapticsEnabled } from "../services/haptics";
import { setStatusBarAppearance } from "../services/statusBar";
import { applyAppearance } from "../theme/appearance";

export type ResolveScene = (
  scene: SceneDescriptor,
  signal: AbortSignal,
) => Promise<{ scene: SceneDescriptor; release: () => void }>;

export interface AppServices {
  local: IndexedDBProjectStore;
  store: ProjectStore;
  workspaces: WorkspaceStore;
  synced: SyncedProjectStore | null;
  purchases: PurchaseService;
  auth: AuthService;
  resolveScene: ResolveScene;
  purchase: PurchaseState;
  setPurchase: (state: PurchaseState) => void;
  authState: AuthState;
  syncState: SyncState | null;
  /** Saved projects, newest first. */
  projects: Project[];
  projectsLoaded: boolean;
  libraryError: string;
  refreshLibrary: () => Promise<void>;
  /** Opens the paywall when the free project is already used; resolves whether creation may continue. */
  canCreateProject: () => Promise<boolean>;
  paywallOpen: boolean;
  setPaywallOpen: (open: boolean) => void;
  signOut: () => Promise<void>;
  deleteAccount: (password?: string) => Promise<void>;
  preferences: AppPreferences;
  preferencesLoaded: boolean;
  updatePreferences: (patch: Partial<Omit<AppPreferences, "version">>) => Promise<void>;
  presets: CameraPreset[];
  savePreset: (preset: CameraPreset) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
}

const ServicesContext = createContext<AppServices | null>(null);

export function useAppServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("useAppServices must be used inside AppServicesProvider");
  return services;
}

export function AppServicesProvider({ children }: { children: ReactNode }) {
  const [purchase, setPurchase] = useState<PurchaseState>({ isPro: false, available: false });
  const purchaseRef = useRef(purchase);
  purchaseRef.current = purchase;
  const local = useMemo(
    () => new IndexedDBProjectStore("oculo", () => (purchaseRef.current.isPro ? Infinity : 1)),
    [],
  );
  const resolveScene = useCallback<ResolveScene>(
    (scene, signal) => resolveSceneAsset(scene, local, signal),
    [local],
  );
  const store = useMemo<ProjectStore>(() => {
    const firebaseApp = getFirebaseApp();
    return firebaseApp === null
      ? local
      : new SyncedProjectStore(local, new FirestoreProjectRepository(firebaseApp));
  }, [local]);
  const workspaces = useMemo(() => createWorkspaceStore(store), [store]);
  const synced = store instanceof SyncedProjectStore ? store : null;
  const purchases = useMemo<PurchaseService>(() => createPurchaseService(), []);
  const auth = useMemo(() => createAuthService(), []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [authState, setAuthState] = useState<AuthState>(() => auth.getState());
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_APP_PREFERENCES);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [presets, setPresets] = useState<CameraPreset[]>([]);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const purchaseOwnerRef = useRef<string | null | undefined>(undefined);
  const purchaseEpochRef = useRef(0);
  const deletingAccountUidRef = useRef<string | null>(null);

  const refreshLibrary = useCallback(async () => {
    try {
      setProjects(await store.list());
      setLibraryError("");
    } catch (reason) {
      setLibraryError(
        reason instanceof Error
          ? reason.message
          : "Saved projects could not be loaded. Please retry.",
      );
    } finally {
      setProjectsLoaded(true);
    }
  }, [store]);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => auth.subscribe(setAuthState), [auth]);

  useEffect(() => {
    let active = true;
    void Promise.all([local.getPreferences(), local.listCameraPresets()])
      .then(([storedPreferences, storedPresets]) => {
        if (!active) return;
        setPreferences(storedPreferences);
        setPresets(storedPresets);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setPreferencesLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [local]);

  // Until stored preferences load, the first-paint script in index.html owns the theme.
  useEffect(
    () =>
      preferencesLoaded
        ? applyAppearance(preferences.appearance, setStatusBarAppearance)
        : undefined,
    [preferences.appearance, preferencesLoaded],
  );

  useEffect(() => {
    setReducedMotionPreference(preferences.reduceMotion);
    setHapticsEnabled(preferences.haptics);
  }, [preferences.reduceMotion, preferences.haptics]);

  const updatePreferences = useCallback(
    async (patch: Partial<Omit<AppPreferences, "version">>) => {
      const next = { ...preferencesRef.current, ...patch };
      preferencesRef.current = next;
      setPreferences(next);
      await local.putPreferences(next);
    },
    [local],
  );
  const savePreset = useCallback(
    async (preset: CameraPreset) => {
      await local.putCameraPreset(preset);
      setPresets(await local.listCameraPresets());
    },
    [local],
  );
  const deletePreset = useCallback(
    async (id: string) => {
      await local.deleteCameraPreset(id);
      setPresets(await local.listCameraPresets());
    },
    [local],
  );

  useEffect(() => {
    if (synced === null) return;
    return synced.subscribeSyncState((state) => {
      setSyncState(state);
      if (state.status === "synced") void refreshLibrary();
    });
  }, [refreshLibrary, synced]);

  useEffect(() => {
    let active = true;
    const owner = authState.status === "signed-in" ? authState.user.uid : null;
    if (owner !== purchaseOwnerRef.current) {
      purchaseOwnerRef.current = owner;
      purchaseEpochRef.current += 1;
      setPurchase({ isPro: false, available: false, message: "Checking your purchases…" });
    }
    const epoch = purchaseEpochRef.current;
    const publish = (state: PurchaseState) => {
      if (active && epoch === purchaseEpochRef.current) setPurchase(state);
    };
    // Reauthentication may emit the same Firebase user during deletion. Do not
    // reattach that user's billing or restart uploads after the explicit drain.
    if (owner !== null && owner === deletingAccountUidRef.current) return;
    if (authState.status === "signed-in") {
      synced?.setUser(authState.user.uid);
      void purchases
        .logIn(authState.user.uid)
        .then(publish)
        .catch(() => undefined);
    } else if (authState.status === "signed-out" || authState.status === "unavailable") {
      synced?.setUser(null);
      void purchases
        .logOut()
        .then(publish)
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [authState, purchases, synced]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (deletingAccountUidRef.current !== null) return;
      const epoch = purchaseEpochRef.current;
      if (document.visibilityState === "visible")
        void purchases
          .refresh()
          .then((state) => {
            if (active && epoch === purchaseEpochRef.current) setPurchase(state);
          })
          .catch(() => undefined);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [purchases]);

  const signOut = useCallback(async () => {
    await synced?.clearSyncState();
    try {
      await auth.signOut();
    } catch (reason) {
      const current = auth.getState();
      if (current.status === "signed-in") synced?.setUser(current.user.uid);
      throw reason;
    }
  }, [auth, synced]);

  const deleteAccount = useCallback(
    async (password?: string) => {
      const initial = auth.getState();
      const uid = initial.status === "signed-in" ? initial.user.uid : null;
      let billingDetached = false;
      let deletionEpoch: number | undefined;
      const stillSameAccount = () => {
        const current = auth.getState();
        return current.status === "signed-in" && current.user.uid === uid;
      };
      try {
        await auth.deleteAccount({
          ...(password === undefined ? {} : { password }),
          // Reauthentication completes first, while the Firebase session is valid.
          beforeDelete: async () => {
            if (uid === null || !stillSameAccount())
              throw new Error("The signed-in account changed. Open Account and try again.");
            deletingAccountUidRef.current = uid;
            deletionEpoch = ++purchaseEpochRef.current;
            setPurchase({ isPro: false, available: false, message: "Deleting account…" });
            // logOut requests the anonymous identity synchronously, then drains
            // queued SDK operations. Roll back even if applying that request fails.
            billingDetached = true;
            await purchases.logOut();
            if (!stillSameAccount() || deletionEpoch !== purchaseEpochRef.current)
              throw new Error("The signed-in account changed. Open Account and try again.");
            await synced?.deleteCloudData();
            if (!stillSameAccount() || deletionEpoch !== purchaseEpochRef.current)
              throw new Error("The signed-in account changed. Open Account and try again.");
          },
        });
        await synced?.clearSyncState();
        synced?.setUser(null);
      } catch (reason) {
        if (
          billingDetached &&
          uid !== null &&
          stillSameAccount() &&
          deletionEpoch === purchaseEpochRef.current
        ) {
          // Cloud deletion leaves sync quiesced. Do not restart uploads here:
          // a failed deletion must not recreate backups the user just removed.
          const restoreEpoch = ++purchaseEpochRef.current;
          try {
            const restored = await purchases.logIn(uid);
            if (stillSameAccount() && restoreEpoch === purchaseEpochRef.current)
              setPurchase(restored);
          } catch {
            if (stillSameAccount() && restoreEpoch === purchaseEpochRef.current)
              setPurchase({
                isPro: false,
                available: false,
                message:
                  "Purchase access could not refresh. Use Refresh availability in Oculo Pro to retry.",
              });
          }
        }
        throw reason;
      } finally {
        if (deletingAccountUidRef.current === uid) deletingAccountUidRef.current = null;
      }
    },
    [auth, purchases, synced],
  );

  const canCreateProject = useCallback(async () => {
    const saved = (await local.list()).filter((project) => project.tutorial !== true);
    if (!purchaseRef.current.isPro && saved.length >= 1) {
      setPaywallOpen(true);
      return false;
    }
    return true;
  }, [local]);

  const value = useMemo<AppServices>(
    () => ({
      local,
      store,
      workspaces,
      synced,
      purchases,
      auth,
      resolveScene,
      purchase,
      setPurchase,
      authState,
      syncState,
      projects,
      projectsLoaded,
      libraryError,
      refreshLibrary,
      canCreateProject,
      paywallOpen,
      setPaywallOpen,
      signOut,
      deleteAccount,
      preferences,
      preferencesLoaded,
      updatePreferences,
      presets,
      savePreset,
      deletePreset,
    }),
    [
      preferences,
      preferencesLoaded,
      updatePreferences,
      presets,
      savePreset,
      deletePreset,
      local,
      store,
      workspaces,
      synced,
      purchases,
      auth,
      resolveScene,
      purchase,
      authState,
      syncState,
      projects,
      projectsLoaded,
      libraryError,
      refreshLibrary,
      canCreateProject,
      paywallOpen,
      signOut,
      deleteAccount,
    ],
  );

  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}
