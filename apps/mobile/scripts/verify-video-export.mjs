/* global process, setTimeout, fetch, WebSocket, clearTimeout, Buffer, console */
/** Real WebGL/WebCodecs export + independent ffmpeg decoding. No network scene assets. */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = resolve(
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ??
    join(root, "artifacts/video-export"),
);
const chrome =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = Number(process.env.VIDEO_VERIFY_PORT ?? 5175);
const debugPort = Number(process.env.VIDEO_VERIFY_DEBUG_PORT ?? 9227);
const temporary = await mkdtemp(join(tmpdir(), "oculo-video-"));
const children = [];
let socket;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${executable} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
function launch(executable, args) {
  const process = spawn(executable, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  process.log = "";
  for (const stream of [process.stdout, process.stderr])
    stream.on("data", (data) => {
      process.log = (process.log + data).slice(-8000);
    });
  children.push(process);
  return process;
}
async function waitForUrl(url, child) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`Process stopped: ${child.log}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      /* Process starting. */
    }
    await delay(100);
  }
  throw new Error(`Timed out opening ${url}: ${child.log}`);
}

try {
  console.log("Checking Chrome, ffmpeg, and ffprobe…");
  await access(chrome);
  run("ffmpeg", ["-version"]);
  run("ffprobe", ["-version"]);
  await mkdir(output, { recursive: true });
  const vite = launch(process.execPath, [
    "apps/mobile/node_modules/vite/bin/vite.js",
    "apps/mobile",
    "--config",
    "apps/mobile/vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ]);
  await waitForUrl(`http://127.0.0.1:${port}/tests/video-export.html`, vite);
  const browser = launch(chrome, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${temporary}`,
    `--remote-debugging-port=${debugPort}`,
    "about:blank",
  ]);
  const targets = await (await waitForUrl(`http://127.0.0.1:${debugPort}/json`, browser)).json();
  console.log("Rendering the local SPZ fixture and encoding a 5-second MP4…");
  socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const response = JSON.parse(data);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timeout);
    if (response.error) request.reject(new Error(JSON.stringify(response.error)));
    else request.resolve(response.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, {
        resolve,
        reject,
        timeout: setTimeout(() => reject(new Error(`Timed out: ${method}`)), 300_000),
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/tests/video-export.html` });
  let result;
  for (let i = 0; i < 100; i++) {
    let response;
    try {
      response = await send("Runtime.evaluate", {
        expression: "window.videoVerification",
        awaitPromise: true,
        returnByValue: true,
      });
    } catch (error) {
      // Initial Vite dependency optimization can reload the fixture page once.
      // Wait for that known navigation to finish, without launching a new job.
      if (i < 3 && /navigated|context.*destroyed/i.test(error.message)) {
        await delay(250);
        continue;
      }
      throw error;
    }
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    result = response.result.value;
    if (result) break;
    await delay(100);
  }
  if (!result || result.error)
    throw new Error(result?.error ?? "The browser did not produce a verification result");
  if (!(result.splatCount > 0)) throw new Error("The fixture did not contain real rendered splats");
  console.log("Decoding MP4 and checking camera frames and timestamps…");
  const videoFile = join(output, "camera-move.mp4");
  await writeFile(videoFile, Buffer.from(result.video, "base64"));
  const metadata = JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_streams",
      "-show_frames",
      "-show_format",
      "-of",
      "json",
      videoFile,
    ]),
  );
  const stream = metadata.streams[0];
  const tags = metadata.format?.tags;
  if (
    tags?.comment !== result.expectedAttribution ||
    tags?.description !== result.expectedAttribution
  )
    throw new Error("MP4 lost scene credit, source, license, or modification metadata");
  if (
    stream.codec_name !== "h264" ||
    stream.width !== 1280 ||
    stream.height !== 720 ||
    Number(stream.duration) !== 5 ||
    metadata.frames.length !== 150
  )
    throw new Error("Unexpected MP4 dimensions, codec, duration, or frame count");
  const comparisons = [];
  for (const reference of result.references) {
    const referenceFile = join(output, `reference-${reference.index}.png`);
    await writeFile(referenceFile, Buffer.from(reference.png, "base64"));
    const actual = run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        videoFile,
        "-vf",
        `select=eq(n\\,${reference.index})`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { encoding: null },
    );
    const expected = run(
      "ffmpeg",
      ["-v", "error", "-i", referenceFile, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
      { encoding: null },
    );
    if (actual.length !== expected.length) throw new Error("Decoded frame size mismatch");
    let squaredError = 0;
    let sum = 0;
    let squareSum = 0;
    for (let i = 0; i < actual.length; i++) {
      squaredError += (actual[i] - expected[i]) ** 2;
      sum += actual[i];
      squareSum += actual[i] ** 2;
    }
    const psnr = 10 * Math.log10(255 ** 2 / (squaredError / actual.length));
    const standardDeviation = Math.sqrt(squareSum / actual.length - (sum / actual.length) ** 2);
    const timestamp = Number(metadata.frames[reference.index].pts_time);
    if (
      psnr < 30 ||
      standardDeviation < 5 ||
      Math.abs(timestamp - reference.timestampSeconds) > 0.000002
    )
      throw new Error(
        `Frame ${reference.index} mismatch: PSNR=${psnr}, deviation=${standardDeviation}, timestamp=${timestamp}`,
      );
    comparisons.push({
      frame: reference.index,
      timestampSeconds: timestamp,
      psnrDb: Number(psnr.toFixed(2)),
      standardDeviation: Number(standardDeviation.toFixed(2)),
    });
  }
  run("ffmpeg", ["-v", "error", "-i", videoFile, "-f", "null", "-"]);
  await writeFile(
    join(output, "verification.png"),
    Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"),
  );
  const report = {
    passed: true,
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    durationSeconds: Number(stream.duration),
    frameCount: metadata.frames.length,
    splatCount: result.splatCount,
    cancellation: result.cancellation,
    restored: result.restored,
    attribution: { verified: true, description: tags.description, comment: tags.comment },
    comparisons,
    timing:
      "30fps with exact final camera endpoint held for the last frame; total duration unchanged.",
    reference:
      "Local SPZ fixture through real SceneEngine/Spark; independent saved camera samples; decoded H.264 frames compared with PNG references.",
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // A failed rerun must not leave an earlier successful report looking current.
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      { passed: false, error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  socket?.close();
  for (const child of children.reverse()) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(temporary, { recursive: true, force: true });
}
