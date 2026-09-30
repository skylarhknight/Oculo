import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";

/**
 * Status bar appearance. Screens follow the app's Appearance setting; the scene
 * workspace is always dark, so it asks for light status-bar content while it is on
 * screen. Failures and non-native platforms are ignored.
 */
let appAppearance: "light" | "dark" = "dark";
let onDarkScreen = false;

function apply(): void {
  if (!Capacitor.isNativePlatform()) return;
  // Style.Dark is light text for dark backgrounds; Style.Light is dark text.
  const style = onDarkScreen || appAppearance === "dark" ? Style.Dark : Style.Light;
  void StatusBar.setStyle({ style }).catch(() => undefined);
}

/** The resolved app appearance (after "match system" is applied). */
export function setStatusBarAppearance(appearance: "light" | "dark"): void {
  appAppearance = appearance;
  apply();
}

/** Whether an always-dark screen (the scene workspace) is on top. */
export function setStatusBarOnDarkScreen(dark: boolean): void {
  onDarkScreen = dark;
  apply();
}
