/* global process, console, setTimeout, clearTimeout, fetch, WebSocket, Buffer */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(app, "../../artifacts/editor-smoke"));
const chromePath =
  process.env.CHROME_PATH ??
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "oculo-editor-"));
const log = [];
const checks = [];
let server, chrome, socket, command, evaluate;
const check = (message) => {
  checks.push(message);
  console.log(`PASS ${message}`);
};
async function until(action, message, timeout = 60000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}
function launch(binary, args, options = {}) {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  child.stdout.on("data", (data) => log.push(data.toString()));
  child.stderr.on("data", (data) => log.push(data.toString()));
  child.on("error", (error) => log.push(error.stack));
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "Process did not exit",
    10000,
  ).catch(() => child.kill("SIGKILL"));
}
async function connect() {
  chrome = launch(chromePath, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--remote-debugging-port=9225",
    `--user-data-dir=${profile}`,
    "about:blank",
  ]);
  const page = await until(async () => {
    const targets = await (await fetch("http://127.0.0.1:9225/json")).json();
    return targets.find((target) => target.type === "page");
  }, "Chrome test page did not start");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  };
  command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command("Network.enable");
  await command("Network.setBlockedURLs", { urls: ["https://*"] });
  await viewport(1280, 900, false);
  await command("Page.navigate", { url: "http://127.0.0.1:5174/" });
  await until(() => evaluate('!!document.querySelector(".hero")'), "Home did not load");
}
async function viewport(width, height, touch) {
  await command("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: touch,
  });
  await command("Emulation.setTouchEmulationEnabled", { enabled: touch });
  await delay(150);
}
const visible = `!element.closest('[inert], [aria-hidden="true"]') && element.getBoundingClientRect().width > 0`;
async function click(name) {
  const result = await until(
    () =>
      evaluate(`(() => {
    const element = [...document.querySelectorAll('button')].find(element => ${visible} && (element.getAttribute('aria-label') === ${JSON.stringify(name)} || element.textContent.trim() === ${JSON.stringify(name)}));
    if (!element) throw new Error('Button missing: ' + ${JSON.stringify(name)});
    if (element.disabled) throw new Error('Button disabled: ' + ${JSON.stringify(name)});
    element.scrollIntoView({ block: 'center' }); element.focus(); element.click(); return true;
  })()`),
    `Button unavailable: ${name}`,
    20000,
  );
  await delay(70);
  return result;
}
async function field(selector, value) {
  await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Field missing: ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set;
    setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await delay(70);
}
async function geometry(selector) {
  return evaluate(
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({ block: 'center' }); const r = element.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, width: r.width, height: r.height }; })()`,
  );
}
async function drag(selector, dx, dy, touch = false) {
  const start = await geometry(selector);
  if (touch)
    await command("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y, id: 1 }],
    });
  else
    await command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: start.x,
      y: start.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
  for (let i = 1; i <= 12; i++) {
    const point = { x: start.x + (dx * i) / 12, y: start.y + (dy * i) / 12 };
    if (touch)
      await command("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...point, id: 1 }],
      });
    else
      await command("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
        button: "left",
        buttons: 1,
      });
    await delay(25);
  }
  if (touch) await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  else
    await command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: start.x + dx,
      y: start.y + dy,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  await delay(100);
}
async function key(key, code, virtualKeyCode, modifiers = 0) {
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    modifiers,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    modifiers,
  });
  await delay(80);
}
async function screenshot(name) {
  const { data } = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(join(output, name), Buffer.from(data, "base64"));
}
async function database(store, method = "getAll") {
  return evaluate(
    `new Promise((resolve, reject) => { const open = indexedDB.open('oculo'); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result; const tx = db.transaction(${JSON.stringify(store)}); const req = tx.objectStore(${JSON.stringify(store)})[${JSON.stringify(method)}](); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); tx.oncomplete = () => db.close(); }; })`,
  );
}
async function save() {
  await click("Save project");
  await until(
    () =>
      evaluate(`document.querySelector('.project-title small')?.textContent === 'Saved on device'`),
    "Project did not save",
  );
  return (await database("projects"))[0];
}
async function ready() {
  await until(
    () =>
      evaluate(
        `!!document.querySelector('.editor-shell') && !document.querySelector('.scene-status')`,
      ),
    "Scene did not become ready",
  );
}

const capturedPixelCount = () =>
  evaluate(`new Promise((resolve, reject) => {
    const image = new Image(); image.onerror = reject;
    image.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let colored = 0;
      for (let i = 0; i < pixels.length; i += 4) if (Math.max(pixels[i],pixels[i+1],pixels[i+2]) > 40 && Math.max(pixels[i],pixels[i+1],pixels[i+2]) - Math.min(pixels[i],pixels[i+1],pixels[i+2]) > 30) colored++;
      resolve(colored);
    }; image.src = document.querySelector('.shot-preview img').src;
  })`);

try {
  server = launch(
    process.execPath,
    [
      join(app, "node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "5174",
      "--strictPort",
    ],
    { cwd: app, env: { ...process.env, VITE_FIREBASE_API_KEY: "", VITE_REVENUECAT_MOCK: "true" } },
  );
  await until(
    async () => (await fetch("http://127.0.0.1:5174/")).ok,
    "Editor test server did not start",
  );
  await connect();
  await click("Import a location");
  await viewport(390, 844, true);
  await screenshot("phone-import.png");
  await viewport(820, 1180, true);
  await screenshot("tablet-import.png");
  await viewport(1280, 900, false);
  const { root } = await command("DOM.getDocument");
  const { nodeId } = await command("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: 'input[type="file"]',
  });
  await command("DOM.setFileInputFiles", {
    nodeId,
    files: [join(app, "test-fixtures/colored-wall.spz")],
  });
  await click("Import location");
  await ready();
  assert.equal(await database("sceneAssets", "count"), 1);
  check("Real SPZ file imports through the form and renders with Spark");
  await click("Save shot");
  const firstFramePixels = await capturedPixelCount();
  assert.ok(
    firstFramePixels > 200,
    `First ready-frame capture must contain rendered splats; found ${firstFramePixels} colored pixels`,
  );
  check("The first capture after scene readiness contains rendered fixture pixels");
  await drag(".scene-canvas", 120, 30);
  await click("Save shot");
  let project = await save();
  assert.equal(project.shots.length, 2);
  assert.notDeepEqual(project.shots[0].camera.pose, project.shots[1].camera.pose);
  await click("Path");
  await field(".move-from-shots label:first-of-type select", project.shots[0].id);
  await field(".move-from-shots label:nth-of-type(2) select", project.shots[1].id);
  await click("Create move from shots");
  await click("Expand graph");
  const speed = () =>
    evaluate(
      `document.querySelector('.expanded-graph [aria-label="Speed point 1"]').getAttribute('aria-valuenow')`,
    );
  const before = await speed();
  await drag('.expanded-graph [aria-label="Speed point 1"]', 0, -60);
  const afterMouse = await speed();
  assert.notEqual(afterMouse, before);
  await click("Undo camera edit");
  assert.equal(await speed(), before);
  await click("Redo camera edit");
  assert.equal(await speed(), afterMouse);
  check("A real mouse curve drag is one undo/redo action");
  await viewport(390, 844, true);
  await drag('.expanded-graph [aria-label="Speed point 1"]', 0, 40, true);
  const afterTouch = await speed();
  assert.notEqual(afterTouch, afterMouse);
  await click("Undo camera edit");
  assert.equal(await speed(), afterMouse);
  await click("Redo camera edit");
  assert.equal(await speed(), afterTouch);
  check("A real touch curve drag is one undo/redo action");
  await evaluate(`document.querySelector('.expanded-graph [aria-label="Speed point 1"]').focus()`);
  await key("ArrowUp", "ArrowUp", 38);
  const afterKey = await speed();
  assert.notEqual(afterKey, afterTouch);
  await key("z", "KeyZ", 90, 2);
  assert.equal(await speed(), afterTouch);
  await key("Z", "KeyZ", 90, 10);
  assert.equal(await speed(), afterKey);
  check("Keyboard curve edits and Ctrl+Z / Ctrl+Shift+Z work in the expanded graph");
  await screenshot("phone-expanded-graph.png");
  await viewport(820, 1180, true);
  await screenshot("tablet-expanded-graph.png");
  await click("Close expanded graph");
  await viewport(390, 844, true);
  await screenshot("phone-editor.png");
  await viewport(820, 1180, true);
  await screenshot("tablet-editor.png");
  await field('[aria-label="Move duration in seconds"]', "1");
  await click("Play camera move");
  await until(
    () => evaluate(`!!document.querySelector('[aria-label="Play camera move"]')`),
    "Playback did not finish",
  );
  project = await save();
  assert.deepEqual(project.camera, project.path.keyframes.at(-1).camera);
  check("Real playback reaches the exact saved camera endpoint");
  await command("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await click("Back to home");
  await click("Duplicate colored-wall");
  await until(
    () => evaluate(`!!document.querySelector('.paywall')`),
    "Second project did not offer Pro",
  );
  assert.equal((await database("projects")).length, 1);
  check("Free capacity prevents a second project without changing saved work");
  await click("Get Oculo Pro");
  await until(
    () => evaluate(`document.body.textContent.includes('Oculo Pro is active.')`),
    "Development Pro did not activate",
  );
  await click("Close Oculo Pro");
  await click("Duplicate colored-wall");
  assert.equal((await database("projects")).length, 2);
  assert.equal(await database("sceneAssets", "count"), 1);
  await click("Delete project colored-wall");
  await click("Delete project");
  assert.equal((await database("projects")).length, 1);
  assert.equal(await database("sceneAssets", "count"), 1);
  await click("Open scene for colored-wall (copy)");
  await ready();
  check("Offline duplication/deletion preserves the shared scene and the surviving project opens");
  await click("Back to home");
  socket.close();
  await stop(chrome);
  chrome = undefined;
  await connect();
  await until(
    () => evaluate(`!!document.querySelector('[aria-label="Open scene for colored-wall (copy)"]')`),
    "Saved project did not restore after browser restart",
  );
  await click("Open scene for colored-wall (copy)");
  await ready();
  const reopened = await save();
  assert.deepEqual(reopened.path, project.path);
  assert.deepEqual(reopened.camera, project.camera);
  assert.equal(await database("sceneAssets", "count"), 1);
  check(
    "A full browser restart retains imported bytes, camera endpoints, and edited speed curves with external networking blocked",
  );
  await screenshot("reopened-project.png");
  // The loader now fetches bytes before handing them to Spark. Verify the
  // existing bundled SOG starter as well as the newly supported SPZ import.
  await click("Back to home");
  await click("Upgrade");
  await click("Get Oculo Pro");
  await until(
    () => evaluate(`document.body.textContent.includes('Oculo Pro is active.')`),
    "Development Pro did not activate after restart",
  );
  await click("Close Oculo Pro");
  await click("Start exploring");
  await ready();
  await click("Save shot");
  assert.ok(
    (await capturedPixelCount()) > 200,
    "Bundled SOG starter must render in the first ready capture",
  );
  await save();
  await screenshot("bundled-starter.png");
  check("Bundled Small Garden SOG still loads and captures through the abortable byte loader");

  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        checks,
        screenshots: [
          "phone-import.png",
          "tablet-import.png",
          "phone-expanded-graph.png",
          "tablet-expanded-graph.png",
          "phone-editor.png",
          "tablet-editor.png",
          "reopened-project.png",
          "bundled-starter.png",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  await screenshot("failure.png").catch(() => undefined);
  let body = "";
  try {
    body = await evaluate("document.body.innerText");
  } catch {
    /* report original failure */
  }
  await writeFile(
    join(output, "report.json"),
    JSON.stringify({ status: "failed", checks, error: error.stack, body }, null, 2),
  );
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  socket?.close();
  await stop(chrome);
  await stop(server);
  await writeFile(join(output, "process.log"), log.join(""));
  await rm(profile, { recursive: true, force: true });
}
