import { useEffect, useRef, useState } from "react";
import { AppServicesProvider, useAppServices } from "./app/AppServices";
import { Paywall } from "./components/Paywall";
import { NavigationStack } from "./navigation/Navigation";
import type { Route } from "./navigation/routes";
import { GalleryScreen } from "./screens/GalleryScreen";
import { ProjectScreen } from "./screens/ProjectScreen";
import { SceneGalleryScreen } from "./screens/SceneGalleryScreen";
import { ShotPlanScreen } from "./screens/scene/CoveringScreens";
import { SceneWorkspaceScreen } from "./screens/scene/SceneWorkspaceScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SplashScreen } from "./screens/SplashScreen";
import { setStatusBarOnDarkScreen } from "./services/statusBar";
import { createTutorialProject } from "./services/tutorial";
import { durationMs } from "./theme/motion";

function renderScreen(route: Route) {
  switch (route.name) {
    case "gallery":
      return <GalleryScreen />;
    case "settings":
      return <SettingsScreen />;
    case "project":
      return <ProjectScreen projectId={route.projectId} />;
    case "scenes":
      return <SceneGalleryScreen {...(route.projectId ? { projectId: route.projectId } : {})} />;
    case "scene":
      return (
        <SceneWorkspaceScreen
          projectId={route.projectId}
          sceneId={route.sceneId}
          stage={route.stage}
          {...(route.shotId ? { shotId: route.shotId } : {})}
        />
      );
    case "shotplan":
      return <ShotPlanScreen projectId={route.projectId} sceneId={route.sceneId} />;
  }
}

/** Seeds the tutorial once, on a device with no projects, and respects a later deletion. */
function useTutorialSeed() {
  const services = useAppServices();
  const { projectsLoaded, preferencesLoaded, projects, preferences } = services;
  const attempted = useRef(false);
  useEffect(() => {
    if (!projectsLoaded || !preferencesLoaded || attempted.current) return;
    attempted.current = true;
    if (preferences.tutorialSeeded) return;
    void (async () => {
      try {
        if (projects.length === 0) {
          await services.store.put(createTutorialProject());
          await services.refreshLibrary();
        }
        await services.updatePreferences({ tutorialSeeded: true });
      } catch {
        // The gallery's empty state still offers the tutorial.
      }
    })();
  }, [preferences.tutorialSeeded, preferencesLoaded, projects.length, projectsLoaded, services]);
}

// The scene workspace is always dark; every other screen follows the Appearance setting.
const matchStatusBar = (route: Route) => setStatusBarOnDarkScreen(route.name === "scene");

function AppShell() {
  const services = useAppServices();
  const ready = services.projectsLoaded && services.preferencesLoaded;
  const [splashMounted, setSplashMounted] = useState(true);
  useTutorialSeed();
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setSplashMounted(false), durationMs("--dur-slow"));
    return () => clearTimeout(timer);
  }, [ready]);

  return (
    <>
      {ready && (
        <NavigationStack
          initial={[{ name: "gallery" }]}
          renderScreen={renderScreen}
          onTopRouteChange={matchStatusBar}
        />
      )}
      {services.paywallOpen && (
        <Paywall
          purchase={services.purchase}
          service={services.purchases}
          onChange={services.setPurchase}
          onClose={() => services.setPaywallOpen(false)}
        />
      )}
      {splashMounted && <SplashScreen leaving={ready} />}
    </>
  );
}

export default function App() {
  return (
    <AppServicesProvider>
      <AppShell />
    </AppServicesProvider>
  );
}
