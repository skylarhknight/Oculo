import { log } from "node:console";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { loadEnv } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...loadEnv("production", root, "VITE_"), ...process.env };
const issues = [];
const includeAndroid = process.argv.includes("--android");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const requireValue = (key) => {
  if (!env[key]?.trim()) issues.push(`${key} is missing.`);
  return env[key]?.trim();
};
const nativeConfig = read("capacitor.config.ts");
const iosProject = read("ios/App/App.xcodeproj/project.pbxproj");
const id = /appId:\s*['"]([^'"]+)['"]/.exec(nativeConfig)?.[1];
if (!id) issues.push("Set the app identifier and verify it against App Store Connect.");
const android = /applicationId\s+["']([^"']+)/.exec(read("android/app/build.gradle"))?.[1];
const iosIds = [...iosProject.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g)].map((match) =>
  match[1].trim().replaceAll('"', ""),
);
if ((includeAndroid && android !== id) || !iosIds.length || iosIds.some((value) => value !== id))
  issues.push("The Capacitor, Android, and iOS app identifiers must match.");

for (const key of ["VITE_PRIVACY_POLICY_URL", "VITE_TERMS_URL", "VITE_SUPPORT_URL"]) {
  const value = requireValue(key);
  if (value) {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        /(^|\.)(example\.(com|org|net)|localhost)$/.test(url.hostname)
      )
        throw new Error();
    } catch {
      issues.push(`${key} must be a real, public HTTPS destination.`);
    }
  }
}
for (const key of [
  "VITE_REVENUECAT_OFFERING_ID",
  "VITE_REVENUECAT_PRO_PACKAGE_ID",
  "VITE_REVENUECAT_IOS_PRO_PRODUCT_ID",
  ...(includeAndroid ? ["VITE_REVENUECAT_ANDROID_PRO_PRODUCT_ID"] : []),
])
  requireValue(key);
for (const [platform, prefix] of [
  ["IOS", "appl_"],
  ...(includeAndroid ? [["ANDROID", "goog_"]] : []),
]) {
  const value = requireValue(`VITE_REVENUECAT_${platform}_API_KEY`);
  if (value && !value.startsWith(prefix))
    issues.push(`RevenueCat ${platform} must use its production public SDK key.`);
}
if (env.VITE_REVENUECAT_MOCK === "true")
  issues.push("Disable VITE_REVENUECAT_MOCK in release configuration.");

const firebaseKeys = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
];
const iosPackages = read("ios/App/CapApp-SPM/Package.swift");
const androidPlugins = read("android/capacitor.settings.gradle");
const registration = (path) => {
  try {
    return JSON.parse(read(path));
  } catch {
    issues.push(`Run Capacitor sync: ${path} is missing or invalid.`);
    return null;
  }
};
const iosRegistration = registration("ios/App/App/capacitor.config.json");
const androidRegistration = includeAndroid
  ? registration("android/app/src/main/assets/capacitor.plugins.json")
  : null;
const iosFirebaseResource = [
  ...iosProject.matchAll(/isa\s*=\s*PBXResourcesBuildPhase;[^}]*?\bfiles\s*=\s*\(([^)]*)\);/g),
].some((match) => match[1].includes("GoogleService-Info.plist in Resources"));
const firebasePlatforms = [
  {
    name: "iOS",
    path: "ios/App/App/GoogleService-Info.plist",
    included: [
      iosPackages.includes("CapacitorFirebaseAuthentication"),
      Array.isArray(iosRegistration?.packageClassList) &&
        iosRegistration.packageClassList.includes("FirebaseAuthenticationPlugin"),
    ],
  },
  {
    name: "Android",
    path: "android/app/google-services.json",
    included: [
      androidPlugins.includes("capacitor-firebase-authentication"),
      read("android/app/capacitor.build.gradle").includes("capacitor-firebase-authentication"),
      Array.isArray(androidRegistration) &&
        androidRegistration.some((plugin) => plugin?.pkg === "@capacitor-firebase/authentication"),
    ],
  },
]
  .filter((platform) => includeAndroid || platform.name === "iOS")
  .map((platform) => ({ ...platform, hasConfig: existsSync(resolve(root, platform.path)) }));

// Native plugin startup depends on these files even when no VITE_FIREBASE_*
// values are supplied. Inspect both sides so partial setup cannot bypass this gate.
const hasAccountConfiguration =
  firebaseKeys.some((key) => Boolean(env[key]?.trim())) ||
  iosFirebaseResource ||
  firebasePlatforms.some((platform) => platform.hasConfig || platform.included.some(Boolean));
if (hasAccountConfiguration) {
  firebaseKeys.forEach(requireValue);
  for (const platform of firebasePlatforms) {
    if (!platform.hasConfig)
      issues.push(`Incomplete accounts configuration: ${platform.path} is missing.`);
    if (platform.included.some((included) => included !== platform.hasConfig))
      issues.push(
        `Run Capacitor sync: ${platform.name} Firebase plugin inclusion must match its native config file.`,
      );
  }
  if (firebasePlatforms[0].hasConfig && !iosFirebaseResource)
    issues.push("Include GoogleService-Info.plist in the iOS app target resources.");
  if (!firebasePlatforms[0].hasConfig && iosFirebaseResource)
    issues.push(
      "The iOS app target references GoogleService-Info.plist in Resources, but the file is missing.",
    );
}

for (const name of ["Filesystem", "Share"]) {
  if (
    !iosPackages.includes(`Capacitor${name}`) ||
    (includeAndroid && !androidPlugins.includes(`capacitor-${name.toLowerCase()}`))
  )
    issues.push(`Run Capacitor sync: ${name} must be included on the selected release platforms.`);
}
if (!existsSync(resolve(root, "public/scenes/small-garden/small-garden.sog")))
  issues.push("The licensed offline starter scene is missing.");

log("Release input preflight (does not certify runtime behavior or store approval)");
for (const issue of issues) log(`- ${issue}`);
log(
  "Manual gates: physical iPhone received-file and persistence checks, provider and purchase sandbox checks, deployed Firebase Auth/RevenueCat account cleanup with failure monitoring if accounts ship, final signing, working published links, store privacy answers, and archive validation.",
);
if (issues.length) {
  log(`${issues.length} configuration issues remain. No secret values were printed.`);
  process.exitCode = 1;
} else log("Static release inputs pass. Complete the manual gates before submission.");
