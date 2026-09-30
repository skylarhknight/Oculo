import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import console from "node:console";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mobile = join(root, "apps/mobile");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const output = resolve(root, "artifacts/release-candidate", runId);
const cache = resolve(root, "artifacts/release-candidate/cache");
const steps = [];
const artifacts = [];
const externalRequirements = [
  "Final publisher identity, application identifier, developer accounts, signing identities, and provisioning.",
  "Published and verified HTTPS privacy, terms, and support destinations; publisher-approved store disclosures and copy.",
  "Real product catalog and purchase/restore/expiry verification against store sandboxes if purchases ship.",
  "Configured and deployed account providers, database rules, deletion service, and account-deletion verification if accounts ship.",
  "Physical-device motion tracking, thermal/performance, received-file sharing, and persistence certification.",
  "Store submission and review approval; this command never publishes or submits a build.",
];
let activeChild;
let interrupted = false;
const ownedSimulators = [];
const ownedEmulators = [];
const report = {
  version: 1,
  startedAt: new Date().toISOString(),
  output,
  steps,
  artifacts,
  externalRequirements,
  validationScope:
    "Automated checks, builds, video codec verification, simulator/emulator launch and capture. Screenshots require visual inspection; launching alone does not certify workflows.",
};
await mkdir(join(output, "logs"), { recursive: true });
await mkdir(cache, { recursive: true });

function available(command) {
  if (command.includes("/")) return existsSync(command);
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
  });
  return probe.status === 0;
}
function skipped(name, reason, external = false) {
  const step = { name, status: "unavailable", reason, external };
  steps.push(step);
  if (external) externalRequirements.push(reason);
  console.log(`[unavailable] ${name}: ${reason}`);
  return step;
}
function stopChild(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Process groups may already have exited between a timeout and cleanup.
    child.kill(signal);
  }
}
function run(name, command, args = [], options = {}) {
  if (interrupted && !name.startsWith("cleanup-") && !name.startsWith("delete-simulator-")) {
    return Promise.resolve({ ...skipped(name, "Pipeline interrupted"), stdout: "", tail: "" });
  }
  const logPath = join(output, "logs", `${String(steps.length + 1).padStart(2, "0")}-${name}.log`);
  const step = {
    name,
    command: [command, ...args],
    cwd: options.cwd ?? root,
    log: logPath,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  steps.push(step);
  console.log(`[running] ${name}`);
  return new Promise((resolveStep) => {
    const log = createWriteStream(logPath);
    let stdout = "";
    let tail = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: step.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    activeChild = child;
    const append = (chunk, capture) => {
      log.write(chunk);
      const text = chunk.toString();
      tail = (tail + text).slice(-8000);
      if (capture) stdout = (stdout + text).slice(-2_000_000);
    };
    child.stdout.on("data", (chunk) => append(chunk, true));
    child.stderr.on("data", (chunk) => append(chunk, false));
    const heartbeat = setInterval(
      () =>
        console.log(
          `[running] ${name} (${Math.round((Date.now() - Date.parse(step.startedAt)) / 1000)}s)`,
        ),
      20000,
    );
    const timeout = setTimeout(
      () => {
        timedOut = true;
        stopChild(child);
        const forceStop = setTimeout(() => stopChild(child, "SIGKILL"), 5000);
        forceStop.unref();
      },
      options.timeoutMs ?? 15 * 60_000,
    );
    child.once("error", (error) => {
      tail += error.message;
    });
    child.once("close", (code, signal) => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      log.end();
      if (activeChild === child) activeChild = undefined;
      Object.assign(step, {
        status: code === 0 && !timedOut ? "passed" : "failed",
        finishedAt: new Date().toISOString(),
        exitCode: code,
        signal,
        ...(timedOut ? { timedOut: true } : {}),
      });
      console.log(`[${step.status}] ${name}${code === 0 ? "" : ` — ${logPath}`}`);
      resolveStep({ ...step, stdout, tail });
    });
  });
}
async function sourceDigest() {
  const listing = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  if (listing.status !== 0) throw new Error("Cannot record source provenance");
  const hash = createHash("sha256");
  for (const path of [...new Set(listing.stdout.split("\0").filter(Boolean))].sort()) {
    hash.update(path);
    hash.update("\0");
    try {
      hash.update(await readFile(join(root, path)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("<deleted>");
    }
  }
  return hash.digest("hex");
}
async function registerArtifact(path, kind) {
  if (!existsSync(path)) throw new Error(`Expected ${kind} artifact is missing: ${path}`);
  artifacts.push({ path, kind });
}
async function iosManifestInventory(app) {
  const manifests = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === "PrivacyInfo.xcprivacy" || path === join(app, "Info.plist")) {
        const parsed = spawnSync("plutil", ["-convert", "json", "-o", "-", path], {
          encoding: "utf8",
          timeout: 30_000,
        });
        if (parsed.status !== 0)
          throw new Error(`Could not parse packaged privacy/application manifest: ${path}`);
        manifests.push({ path: path.slice(app.length + 1), data: JSON.parse(parsed.stdout) });
      }
    }
  };
  await visit(app);
  const path = join(output, "ios/packaged-manifests.json");
  await writeFile(path, JSON.stringify(manifests, null, 2) + "\n");
  await registerArtifact(path, "ios-packaged-permissions-and-privacy-manifests");
  const signature = spawnSync("codesign", ["-dv", app], { encoding: "utf8", timeout: 30_000 });
  steps.push({
    name: "ios-unsigned-verification",
    status: signature.status !== 0 && signature.stderr.includes("not signed") ? "passed" : "failed",
    reason: "The candidate application must have no distribution signature",
  });
}
async function waitForIosContent(kind, phase, udid, recognizer) {
  const started = Date.now();
  const attempts = [];
  let ready = false;
  while (Date.now() - started < 60_000 && !interrupted) {
    const attempt = attempts.length + 1;
    const screenshot = join(output, `ios/${kind}-${phase}-attempt-${attempt}.png`);
    const remaining = () => Math.max(1, 60_000 - (Date.now() - started));
    const captured = await run(
      `ios-${kind}-${phase}-capture-${attempt}`,
      "xcrun",
      ["simctl", "io", udid, "screenshot", screenshot],
      { timeoutMs: Math.min(15_000, remaining()) },
    );
    if (captured.status !== "passed") break;
    const checked = await run(
      `ios-${kind}-${phase}-recognize-${attempt}`,
      recognizer,
      [screenshot],
      { timeoutMs: Math.min(15_000, remaining()) },
    );
    if (checked.status !== "passed") break;
    const content = JSON.parse(checked.stdout);
    attempts.push({ elapsedMs: Date.now() - started, screenshot, ...content });
    if (content.ready) {
      ready = true;
      const verified = join(output, `ios/${kind}-${phase}.png`);
      await cp(screenshot, verified);
      await registerArtifact(verified, `${kind}-${phase}-verified-screenshot`);
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(1000, remaining())));
  }
  const path = join(output, `ios/${kind}-${phase}-readiness.json`);
  await writeFile(
    path,
    JSON.stringify(
      {
        ready,
        elapsedMs: Date.now() - started,
        requiredText: ["Oculo", "Start exploring"],
        attempts,
      },
      null,
      2,
    ) + "\n",
  );
  await registerArtifact(path, `${kind}-${phase}-content-readiness`);
  steps.push({
    name: `ios-${kind}-${phase}-content-ready`,
    status: ready ? "passed" : "failed",
    reason: ready
      ? `Expected home content recognized after ${Date.now() - started}ms`
      : "Expected home content was not visible within 60 seconds",
    evidence: path,
  });
  console.log(`[${ready ? "passed" : "failed"}] ios-${kind}-${phase}-content-ready`);
  return ready;
}
async function collectIosFailureDiagnostics(kind, phase, udid, recognizer) {
  // Preserve evidence while the failed disposable device still exists. A
  // launch timeout is not proof of an app crash or of successfully drawn UI.
  const prefix = `ios-${kind}-${phase}-diagnostic`;
  const screenshot = join(output, `ios/${kind}-${phase}-diagnostic.png`);
  const captured = await run(
    `${prefix}-capture`,
    "xcrun",
    ["simctl", "io", udid, "screenshot", screenshot],
    { timeoutMs: 15_000 },
  );
  if (captured.status === "passed") {
    await registerArtifact(screenshot, `${kind}-${phase}-failure-screenshot`);
    await run(`${prefix}-recognize`, recognizer, [screenshot], { timeoutMs: 15_000 });
  }
  const deviceLog = await run(
    `${prefix}-device-log`,
    "xcrun",
    [
      "simctl",
      "spawn",
      udid,
      "log",
      "show",
      "--last",
      "5m",
      "--style",
      "compact",
      "--predicate",
      'process == "App" OR process == "SpringBoard" OR process == "runningboardd" OR process == "launchd_sim"',
    ],
    { timeoutMs: 30_000 },
  );
  if (deviceLog.log) await registerArtifact(deviceLog.log, `${kind}-${phase}-failure-device-log`);
  const state = await run(
    `${prefix}-process-state`,
    "xcrun",
    ["simctl", "spawn", udid, "launchctl", "print", "system"],
    { timeoutMs: 15_000 },
  );
  if (state.log) await registerArtifact(state.log, `${kind}-${phase}-failure-process-state`);
}
async function ios() {
  if (process.platform !== "darwin" || !available("xcodebuild") || !available("xcrun")) {
    skipped(
      "ios-build",
      "Install Xcode and an iOS simulator runtime on macOS to build and smoke-test iOS.",
      true,
    );
    return;
  }
  await run("xcode-version", "xcodebuild", ["-version"]);
  const common = [
    "-project",
    join(mobile, "ios/App/App.xcodeproj"),
    "-scheme",
    "App",
    "-configuration",
    "Release",
    "-clonedSourcePackagesDirPath",
    join(cache, "swift-packages"),
    "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO",
  ];
  const archive = join(output, "ios/Oculo.xcarchive");
  const device = await run(
    "ios-unsigned-archive",
    "xcodebuild",
    [
      ...common,
      "-destination",
      "generic/platform=iOS",
      "-derivedDataPath",
      join(cache, "ios-device"),
      "-archivePath",
      archive,
      "archive",
    ],
    { timeoutMs: 30 * 60_000 },
  );
  if (device.status === "passed") {
    await registerArtifact(archive, "unsigned-ios-archive");
    await iosManifestInventory(join(archive, "Products/Applications/App.app"));
  }
  const simulator = await run(
    "ios-simulator-build",
    "xcodebuild",
    [
      ...common,
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      join(cache, "ios-simulator"),
      "build",
    ],
    { timeoutMs: 30 * 60_000 },
  );
  if (simulator.status !== "passed") return;
  const app = join(output, "ios/Oculo-simulator.app");
  await cp(join(cache, "ios-simulator/Build/Products/Release-iphonesimulator/App.app"), app, {
    recursive: true,
  });
  await registerArtifact(app, "unsigned-ios-simulator-app");
  const recognizer = join(cache, "verify-native-frame");
  if (
    (
      await run(
        "ios-readiness-helper",
        "xcrun",
        [
          "swiftc",
          join(root, "scripts/verify-native-frame.swift"),
          "-module-cache-path",
          join(cache, "swift-ocr-modules"),
          "-o",
          recognizer,
        ],
        { timeoutMs: 120_000 },
      )
    ).status !== "passed"
  )
    return;
  const inventory = await run(
    "ios-simulator-inventory",
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    { timeoutMs: 30_000 },
  );
  if (inventory.status !== "passed") {
    externalRequirements.push(
      "Grant access to CoreSimulator and install an available iOS runtime to complete native smoke tests.",
    );
    return;
  }
  const devices = Object.entries(JSON.parse(inventory.stdout).devices).flatMap(
    ([runtime, entries]) => entries.map((entry) => ({ ...entry, runtime })),
  );
  const preferred = (kind) =>
    devices
      .filter(
        (d) => d.isAvailable && d.deviceTypeIdentifier?.includes(kind) && d.runtime.includes("iOS"),
      )
      .sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }))[0];
  for (const kind of ["iPhone"]) {
    const template = preferred(kind);
    if (!template) {
      skipped(`ios-${kind}-smoke`, `No available ${kind} simulator runtime.`, true);
      continue;
    }
    const created = await run(
      `ios-${kind}-create`,
      "xcrun",
      [
        "simctl",
        "create",
        `Oculo RC ${kind} ${runId}`,
        template.deviceTypeIdentifier,
        template.runtime,
      ],
      { timeoutMs: 60_000 },
    );
    if (created.status !== "passed") continue;
    const udid = created.stdout.trim();
    ownedSimulators.push(udid);
    if (
      (await run(`ios-${kind}-boot`, "xcrun", ["simctl", "boot", udid], { timeoutMs: 60_000 }))
        .status !== "passed"
    )
      continue;
    if (
      (
        await run(`ios-${kind}-bootstatus`, "xcrun", ["simctl", "bootstatus", udid, "-b"], {
          timeoutMs: 180_000,
        })
      ).status !== "passed"
    )
      continue;
    if (
      (
        await run(`ios-${kind}-install`, "xcrun", ["simctl", "install", udid, app], {
          timeoutMs: 60_000,
        })
      ).status !== "passed"
    )
      continue;
    const bundleId = /appId:\s*["']([^"']+)/.exec(
      readFileSync(join(mobile, "capacitor.config.ts"), "utf8"),
    )?.[1];
    if (!bundleId) throw new Error("Cannot determine app identifier for simulator smoke test");
    const launched = await run(
      `ios-${kind}-launch`,
      "xcrun",
      ["simctl", "launch", udid, bundleId],
      { timeoutMs: 60_000 },
    );
    if (launched.status !== "passed") {
      await collectIosFailureDiagnostics(kind, "launch", udid, recognizer);
      continue;
    }
    if (!(await waitForIosContent(kind, "launch", udid, recognizer))) {
      await collectIosFailureDiagnostics(kind, "launch-content", udid, recognizer);
      continue;
    }
    await run(`ios-${kind}-terminate`, "xcrun", ["simctl", "terminate", udid, bundleId], {
      timeoutMs: 30_000,
    });
    const relaunched = await run(
      `ios-${kind}-relaunch`,
      "xcrun",
      ["simctl", "launch", udid, bundleId],
      {
        timeoutMs: 30_000,
      },
    );
    if (relaunched.status !== "passed")
      await collectIosFailureDiagnostics(kind, "relaunch", udid, recognizer);
    else if (!(await waitForIosContent(kind, "relaunch", udid, recognizer)))
      await collectIosFailureDiagnostics(kind, "relaunch-content", udid, recognizer);
  }
}
async function android() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.HOME && join(process.env.HOME, "Library/Android/sdk"),
    process.env.HOME && join(process.env.HOME, "Android/Sdk"),
  ].filter(Boolean);
  const sdk = candidates.find((path) => existsSync(join(path, "platform-tools/adb")));
  if (!sdk || !available("java")) {
    skipped(
      "android-build",
      "Install Android SDK 36 (platform/build tools), platform-tools, an emulator/AVD, and JDK 21 to build and smoke-test Android.",
      true,
    );
    return;
  }
  const env = { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, GRADLE_USER_HOME: join(cache, "gradle") };
  const built = await run(
    "android-unsigned-release",
    join(mobile, "android/gradlew"),
    ["--no-daemon", "--console=plain", ":app:assembleRelease", ":app:assembleDebug"],
    { cwd: join(mobile, "android"), env, timeoutMs: 30 * 60_000 },
  );
  if (built.status !== "passed") return;
  const androidDir = join(output, "android");
  await mkdir(androidDir, { recursive: true });
  for (const [source, name, kind] of [
    ["release/app-release-unsigned.apk", "Oculo-release-unsigned.apk", "unsigned-android-apk"],
    ["debug/app-debug.apk", "Oculo-debug.apk", "debug-signed-emulator-apk"],
  ]) {
    const target = join(androidDir, name);
    await cp(join(mobile, "android/app/build/outputs/apk", source), target);
    await registerArtifact(target, kind);
  }
  const adb = join(sdk, "platform-tools/adb");
  const inventory = await run("android-device-inventory", adb, ["devices"], { timeoutMs: 30_000 });
  let serial = inventory.stdout
    .split("\n")
    .map((line) => /^(emulator-\d+)\s+device$/.exec(line)?.[1])
    .find(Boolean);
  if (!serial) {
    const emulator = join(sdk, "emulator/emulator");
    if (existsSync(emulator)) {
      const avds = await run("android-avd-inventory", emulator, ["-list-avds"], {
        timeoutMs: 30_000,
      });
      const avd = avds.stdout.trim().split("\n")[0];
      if (avd) {
        const emulatorLog = createWriteStream(join(output, "logs/android-emulator.log"));
        const child = spawn(
          emulator,
          [
            "-avd",
            avd,
            "-no-window",
            "-no-audio",
            "-no-snapshot-save",
            "-read-only",
            "-port",
            "5580",
          ],
          { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout.pipe(emulatorLog);
        child.stderr.pipe(emulatorLog);
        ownedEmulators.push(child);
        serial = "emulator-5580";
      }
    }
  }
  if (!serial) {
    skipped(
      "android-emulator-smoke",
      "Create an Android AVD or boot an emulator for install/launch/screenshot verification.",
      true,
    );
    return;
  }
  if (
    (
      await run("android-emulator-ready", adb, ["-s", serial, "wait-for-device"], {
        timeoutMs: 180_000,
      })
    ).status !== "passed"
  )
    return;
  const deadline = Date.now() + 180_000;
  let booted = false;
  while (Date.now() < deadline) {
    const status = spawnSync(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (status.stdout?.trim() === "1") {
      booted = true;
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
  }
  if (!booted) {
    steps.push({
      name: "android-boot-complete",
      status: "failed",
      reason: "Emulator did not complete boot within 180 seconds",
    });
    return;
  }
  if (
    (
      await run(
        "android-install",
        adb,
        ["-s", serial, "install", "-r", join(androidDir, "Oculo-debug.apk")],
        { timeoutMs: 60_000 },
      )
    ).status !== "passed"
  )
    return;
  const id = /applicationId\s+["']([^"']+)/.exec(
    readFileSync(join(mobile, "android/app/build.gradle"), "utf8"),
  )?.[1];
  if (!id) throw new Error("Cannot determine Android application identifier");
  if (
    (
      await run(
        "android-launch",
        adb,
        ["-s", serial, "shell", "am", "start", "-W", "-n", `${id}/.MainActivity`],
        { timeoutMs: 30_000 },
      )
    ).status !== "passed"
  )
    return;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 8000));
  const png = join(androidDir, "emulator-launch.png");
  const capture = spawnSync(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
    maxBuffer: 30 * 1024 * 1024,
    timeout: 30_000,
  });
  if (capture.status === 0 && capture.stdout?.subarray(1, 4).toString() === "PNG") {
    await writeFile(png, capture.stdout);
    await registerArtifact(png, "android-launch-screenshot");
    steps.push({ name: "android-screenshot", status: "passed" });
  } else steps.push({ name: "android-screenshot", status: "failed" });
  await run("android-terminate", adb, ["-s", serial, "shell", "am", "force-stop", id], {
    timeoutMs: 30_000,
  });
  await run(
    "android-relaunch",
    adb,
    ["-s", serial, "shell", "am", "start", "-W", "-n", `${id}/.MainActivity`],
    { timeoutMs: 30_000 },
  );
}

process.on("SIGINT", () => {
  interrupted = true;
  stopChild(activeChild);
});
process.on("SIGTERM", () => {
  interrupted = true;
  stopChild(activeChild);
});
try {
  report.commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout?.trim();
  report.worktree = spawnSync("git", ["status", "--short"], {
    cwd: root,
    encoding: "utf8",
  }).stdout?.trim();
  report.nodeVersion = process.version;
  const install = await run("dependencies", "corepack", ["pnpm", "install", "--frozen-lockfile"], {
    env: { CI: "true" },
    timeoutMs: 10 * 60_000,
  });
  if (install.status !== "passed")
    throw new Error(
      "Dependency installation failed. See the dependency log; no candidate was built.",
    );
  const checks = [
    ["lint", ["pnpm", "run", "lint"]],
    ["typecheck", ["pnpm", "run", "typecheck"]],
    ["tests", ["pnpm", "exec", "vitest", "run", "--maxWorkers=4"]],
    ["build", ["pnpm", "run", "build"]],
  ];
  let buildPassed = false;
  report.sourceDigestBeforeChecks = await sourceDigest();
  for (const [name, args] of checks) {
    if (interrupted) throw new Error("Interrupted");
    if (name === "build") report.sourceDigestBeforeBuild = await sourceDigest();
    const result = await run(name, "corepack", args);
    if (name === "build") buildPassed = result.status === "passed";
  }
  if (buildPassed) {
    steps.push({
      name: "checked-source-stability",
      status: report.sourceDigestBeforeChecks === (await sourceDigest()) ? "passed" : "failed",
      reason: "The tested source must match the built source",
    });
    steps.push({
      name: "web-source-stability",
      status: report.sourceDigestBeforeBuild === (await sourceDigest()) ? "passed" : "failed",
      reason: "Source must remain unchanged while building the web bundle",
    });
    const web = join(output, "web");
    await cp(join(mobile, "dist"), web, { recursive: true });
    await registerArtifact(web, "web-production-bundle");
    const sync = await run("capacitor-sync", "corepack", [
      "pnpm",
      "--filter",
      "@oculo/mobile",
      "exec",
      "cap",
      "sync",
    ]);
    report.sourceDigestAtBuild = await sourceDigest();
    const chrome =
      process.env.CHROME_BIN ??
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(join(mobile, "scripts/verify-editor.mjs")) && available(chrome)) {
      const editor = await run(
        "editor-browser-verification",
        process.execPath,
        [join(mobile, "scripts/verify-editor.mjs"), join(output, "editor")],
        { timeoutMs: 5 * 60_000, env: { CHROME_PATH: chrome, CHROME_BIN: chrome } },
      );
      if (editor.status === "passed")
        await registerArtifact(join(output, "editor"), "editor-browser-verification");
    } else
      skipped(
        "editor-browser-verification",
        "Chrome and apps/mobile/scripts/verify-editor.mjs are required for browser workflow/screenshots verification.",
        true,
      );
    if (existsSync(join(mobile, "scripts/verify-video-export.mjs"))) {
      if (available(chrome) && available("ffmpeg") && available("ffprobe")) {
        const video = await run(
          "video-export-verification",
          process.execPath,
          [
            join(mobile, "scripts/verify-video-export.mjs"),
            `--output=${join(output, "video-export")}`,
          ],
          { timeoutMs: 5 * 60_000, env: { CHROME_PATH: chrome, CHROME_BIN: chrome } },
        );
        if (video.status === "passed")
          await registerArtifact(
            join(output, "video-export/report.json"),
            "video-export-verification",
          );
      } else
        skipped(
          "video-export-verification",
          "Install Chrome, ffmpeg, and ffprobe (or configure CHROME_BIN) for real MP4 encoding/decoding verification.",
          true,
        );
    } else
      steps.push({
        name: "video-export-verification",
        status: "failed",
        reason: "Verification script is missing",
      });
    if (sync.status === "passed") {
      await ios();
      if (!interrupted && process.argv.includes("--android")) await android();
    }
    report.sourceDigestAtEnd = await sourceDigest();
    steps.push({
      name: "source-stability",
      status: report.sourceDigestAtBuild === report.sourceDigestAtEnd ? "passed" : "failed",
      reason:
        "Source must remain unchanged after the bundle and synchronized native inputs are recorded",
    });
  }
  const preflight = await run(
    "release-inputs",
    process.execPath,
    [
      join(mobile, "scripts/check-release.mjs"),
      ...(process.argv.includes("--android") ? ["--android"] : []),
    ],
    { timeoutMs: 60_000 },
  );
  if (preflight.status !== "passed") {
    const issues = preflight.stdout
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
    externalRequirements.push(...issues);
    // A completed preflight can identify publisher configuration without
    // turning successfully built/tested code into a technical failure. A crash
    // or an unrecognized nonzero result remains failed and visible in its log.
    if (issues.length > 0 && /^\d+ configuration issues remain\./m.test(preflight.stdout)) {
      const step = steps.find((entry) => entry.name === "release-inputs");
      step.status = "needs-configuration";
      step.external = true;
    }
  }
} catch (error) {
  steps.push({
    name: "pipeline",
    status: "failed",
    reason: error instanceof Error ? error.message : String(error),
  });
} finally {
  for (const udid of ownedSimulators) {
    await run(`cleanup-simulator-${udid}`, "xcrun", ["simctl", "shutdown", udid], {
      timeoutMs: 30_000,
    });
    await run(`delete-simulator-${udid}`, "xcrun", ["simctl", "delete", udid], {
      timeoutMs: 30_000,
    });
  }
  for (const emulator of ownedEmulators) emulator.kill("SIGTERM");
  report.finishedAt = new Date().toISOString();
  report.interrupted = interrupted;
  report.technicalStatus =
    interrupted || steps.some((step) => step.status === "failed") ? "failed" : "passed";
  report.coverageStatus = steps.some((step) => step.status === "unavailable")
    ? "partial"
    : "complete";
  report.status =
    report.technicalStatus === "failed"
      ? "failed"
      : report.coverageStatus === "partial"
        ? "incomplete"
        : steps.some((step) => step.status === "needs-configuration")
          ? "needs-configuration"
          : "passed";
  report.storeReady = false;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const markdown = [
    `# Oculo release candidate`,
    ``,
    `Result: **${report.status}**. Store readiness is a separate external milestone.`,
    `Technical checks: **${report.technicalStatus}**. Platform/tool coverage: **${report.coverageStatus}**.`,
    ``,
    `Commit: ${report.commit ?? "unknown"}; Node ${process.version}.`,
    ``,
    `| Step | Result | Evidence |`,
    `| --- | --- | --- |`,
    ...steps.map(
      (step) =>
        `| ${step.name} | ${step.status} | ${step.log ? `[log](${step.log})` : (step.reason ?? "").replaceAll("|", "\\|")} |`,
    ),
    ``,
    `## Artifacts`,
    ``,
    ...artifacts.map((artifact) => `- ${artifact.kind}: [${artifact.path}](${artifact.path})`),
    ``,
    `## External requirements`,
    ``,
    ...[...new Set(externalRequirements)].map((requirement) => `- ${requirement}`),
    ``,
    report.validationScope,
    ``,
  ].join("\n");
  await writeFile(join(output, "report.md"), markdown);
  await writeFile(
    resolve(root, "artifacts/release-candidate/latest.json"),
    JSON.stringify(
      { output, report: join(output, "report.json"), status: report.status },
      null,
      2,
    ) + "\n",
  );
  console.log(`Release candidate ${report.status}: ${join(output, "report.md")}`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
