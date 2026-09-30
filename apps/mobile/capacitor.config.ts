import type { CapacitorConfig } from "@capacitor/cli";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const basePlugins = [
  "@capacitor/filesystem",
  "@capacitor/haptics",
  "@capacitor/share",
  "@capacitor/status-bar",
  "@revenuecat/purchases-capacitor",
];
const pluginsFor = (configPath: string) =>
  existsSync(resolve(__dirname, configPath))
    ? [...basePlugins, "@capacitor-firebase/authentication"]
    : basePlugins;

const config: CapacitorConfig = {
  appId: "org.example.oculo.student",
  appName: "Oculo",
  webDir: "dist",
  backgroundColor: "#070708",
  // Firebase's native plugin configures itself at startup. Excluding it when the
  // native config is absent keeps the documented local-only build launchable.
  // The iOS 17 minimum lives in project.pbxproj. Capacitor derives the generated
  // Swift package platform from it on sync; the bundled SOG needs WebKit 17.
  ios: { includePlugins: pluginsFor("ios/App/App/GoogleService-Info.plist") },
  android: { includePlugins: pluginsFor("android/app/google-services.json") },
  plugins: {
    FirebaseAuthentication: {
      // Native sign-in credentials are bridged into the Firebase JS SDK so one
      // auth state serves auth + Firestore. Apple sign-in skips native auth at
      // the call site because its credential is single-use.
      skipNativeAuth: false,
      providers: ["apple.com", "google.com"],
    },
  },
  experimental: {
    ios: {
      spm: {
        // The Firebase plugin and its native dependencies expose colliding
        // SwiftPM identities unless Capacitor resolves this plugin by symlink.
        packageOptions: {
          "@capacitor-firebase/authentication": {
            symlink: true,
          },
        },
      },
    },
  },
};

export default config;
