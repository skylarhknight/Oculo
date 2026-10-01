#!/usr/bin/env node
// Builds the Oculo scene gallery from tools/scenes/catalog.json.
//
// For each scene it confirms the creator still offers it under CC BY 4.0, fetches the
// published SOG (or the nearest level of a streamed SOG), thins it to the mobile splat
// budget, re-encodes it as a bundled SOG with one spherical-harmonic band, and records
// its hash, size, splat count, and the creator's published start camera.
//
//   pnpm scenes:build            build every scene (skips outputs that already exist)
//   pnpm scenes:build moon iss   build only these ids
//   pnpm scenes:build --force    rebuild even if outputs exist
//
// Bundled scenes land in apps/mobile/public/scenes/<id>/. Download scenes land in
// dist-scenes/ (git-ignored); `pnpm scenes:upload` publishes them to Hugging Face.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(readFileSync(join(root, "tools/scenes/catalog.json"), "utf8"));
const publicScenes = join(root, "apps/mobile/public/scenes");
const distScenes = join(root, "dist-scenes");
const workDir = join(root, "tools/scenes/.cache");
const generatedPath = join(root, "apps/mobile/src/config/sceneCatalog.generated.json");
const splatTransform = join(root, "node_modules/.bin/splat-transform");

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = new Set(args.filter((arg) => !arg.startsWith("--")));

const previous = existsSync(generatedPath)
  ? Object.fromEntries(JSON.parse(readFileSync(generatedPath, "utf8")).map((s) => [s.id, s]))
  : {};

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Refuses a scene whose page no longer offers it for download under the catalog license. */
async function confirmLicense(scene) {
  const page = await fetchText(`https://superspl.at/scene/${scene.superSplatId}`);
  const license = /<link rel="license" href="([^"]+)"/.exec(page)?.[1];
  if (license !== catalog.license.url) {
    throw new Error(
      `${scene.id}: page license is ${license ?? "missing"}, not ${catalog.license.name}`,
    );
  }
  if (!page.includes("Download</button>")) throw new Error(`${scene.id}: download is disabled`);
}

/** The creator's published start camera, as saved by the SuperSplat viewer. */
async function publishedCamera(scene) {
  const settings = JSON.parse(
    await fetchText(`${catalog.sourceBase}/${scene.superSplatId}/v1/settings.json`),
  );
  const initial = settings.cameras?.[0]?.initial;
  if (initial) return { position: initial.position, target: initial.target, fov: initial.fov };
  return boundsCamera(scene);
}

/**
 * Without a published camera, look at the middle of the scene from a raised
 * three-quarter view. SOG bounds are in file space; the viewer turns scenes 180° about
 * Z, so x and y flip into world space.
 */
async function boundsCamera(scene) {
  const meta = JSON.parse(
    await fetchText(`${catalog.sourceBase}/${scene.superSplatId}/v1/meta.json`),
  );
  const { mins, maxs } = meta.means;
  const world = (v) => [-v[0], -v[1], v[2]];
  const a = world(mins);
  const b = world(maxs);
  const low = a.map((value, index) => Math.min(value, b[index]));
  const high = a.map((value, index) => Math.max(value, b[index]));
  const center = low.map((value, index) => (value + high[index]) / 2);
  const size = high.map((value, index) => value - low[index]);
  const reach = Math.max(size[0], size[2]) * 0.45;
  const target = [center[0], low[1] + size[1] * 0.35, center[2]];
  const position = [center[0] + reach * 0.6, target[1] + size[1] * 0.25, center[2] + reach];
  console.log(`  no published camera; using a view from the scene bounds`);
  return { position, target, fov: 60 };
}

/** SOG inputs: the single meta.json, or the smallest streamed LOD level at or above budget. */
async function sourceInputs(scene) {
  const base = `${catalog.sourceBase}/${scene.superSplatId}/v1`;
  const meta = await fetch(`${base}/meta.json`);
  if (meta.ok) {
    const { count } = await meta.json();
    return { inputs: [`${base}/meta.json`], count, streamedLevel: null };
  }
  const lod = JSON.parse(await fetchText(`${base}/lod-meta.json`));
  let level = 0;
  for (let index = 0; index < lod.counts.length; index += 1) {
    if (lod.counts[index] >= scene.splatBudget) level = index;
  }
  const inputs = lod.filenames
    .filter((name) => name.startsWith(`${level}_`))
    .map((name) => `${base}/${name}`);
  return { inputs, count: lod.counts[level], streamedLevel: level };
}

function run(argv) {
  execFileSync(splatTransform, ["-w", ...argv], { stdio: "inherit" });
}

function splatCount(file) {
  const out = execFileSync(splatTransform, ["-g", "cpu", file, "--info", "json", "null"], {
    encoding: "utf8",
  });
  const match = /"numGaussians"\s*:\s*(\d+)/.exec(out);
  if (!match) throw new Error(`Could not read the splat count of ${file}`);
  return Number(match[1]);
}

/** Y-up camera quaternion looking from position at target (Three.js Matrix4.lookAt). */
function lookAtQuaternion(position, target) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (v) => {
    const l = Math.hypot(...v) || 1;
    return v.map((c) => c / l);
  };
  const z = norm(sub(position, target));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = [
    x[0],
    y[0],
    z[0],
    x[1],
    y[1],
    z[1],
    x[2],
    y[2],
    z[2],
  ];
  const trace = m11 + m22 + m33;
  let q;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
  return q;
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const retrieved = new Date().toISOString().slice(0, 10);

function attributionText(scene, entry, source) {
  const changes = scene.prebuilt
    ? "Packaged the published SOG components into a SOG ZIP archive without changes."
    : `Reduced from ${source.count.toLocaleString("en-US")} to ${entry.splatCount.toLocaleString("en-US")} Gaussian splats${
        source.streamedLevel === null
          ? ""
          : ` (starting from streamed LOD level ${source.streamedLevel})`
      }, spherical harmonics reduced to degree 1, NaN splats removed, and re-encoded as SOG for mobile.`;
  return `${scene.title}
Creator: ${scene.author}
Creator profile: https://superspl.at/user/${scene.author}
Source: https://superspl.at/scene/${scene.superSplatId}
License: Creative Commons Attribution 4.0 International (CC BY 4.0)
License URL: ${catalog.license.url}

Credit: ${scene.title} — ${scene.author} · CC BY 4.0

The creator's scene page offered this asset for download under CC BY 4.0 when
retrieved on ${retrieved}. This attribution applies to the scene asset; Oculo's
application code is licensed separately. Retain this credit, the source and license
links, and this indication of changes when redistributing the scene or images
derived from it.

File: ${entry.fileName}
Size: ${entry.byteSize.toLocaleString("en-US")} bytes
SHA-256: ${entry.sha256}
Format: SOG; ${entry.splatCount.toLocaleString("en-US")} Gaussian splats

Changes: ${changes}

Start camera: the creator's published SuperSplat viewer camera
(position ${JSON.stringify(entry.camera.position)}, target ${JSON.stringify(entry.camera.target)}).
`;
}

async function buildScene(scene) {
  const sceneDir = join(publicScenes, scene.id);
  mkdirSync(sceneDir, { recursive: true });
  const fileName = `${scene.id}.sog`;
  const output = scene.bundled ? join(sceneDir, fileName) : join(distScenes, fileName);
  mkdirSync(dirname(output), { recursive: true });

  console.log(`\n▸ ${scene.id} (${scene.superSplatId})`);
  await confirmLicense(scene);
  const camera = await publishedCamera(scene);

  const thumb = join(sceneDir, "thumb.webp");
  if (force || !existsSync(thumb)) {
    writeFileSync(
      thumb,
      await fetchBytes(`${catalog.thumbnailBase}/${scene.superSplatId}/v1/m.webp`),
    );
  }

  let source = { count: 0, streamedLevel: null };
  if (!scene.prebuilt && (force || !existsSync(output))) {
    const inputs = await sourceInputs(scene);
    source = { count: inputs.count, streamedLevel: inputs.streamedLevel };
    mkdirSync(workDir, { recursive: true });
    const thinned = join(workDir, `${scene.id}.ply`);
    const steps = source.count > scene.splatBudget ? ["-d", String(scene.splatBudget)] : [];
    run([...inputs.inputs, "-N", thinned, ...steps]);
    run([thinned, "-H", "1", output]);
    rmSync(thinned, { force: true });
  } else if (!scene.prebuilt) {
    // Output already built: recover the source numbers for the credit without converting.
    source = previous[scene.id]?.source ?? (await sourceInputs(scene));
    source = { count: source.count, streamedLevel: source.streamedLevel };
  }

  const bytes = readFileSync(output);
  const entry = {
    id: scene.id,
    superSplatId: scene.superSplatId,
    title: scene.title,
    author: scene.author,
    bundled: scene.bundled,
    fileName,
    byteSize: statSync(output).size,
    sha256: sha256(bytes),
    splatCount:
      previous[scene.id]?.sha256 === sha256(bytes)
        ? previous[scene.id].splatCount
        : splatCount(output),
    camera: { ...camera, quaternion: lookAtQuaternion(camera.position, camera.target) },
    source: scene.prebuilt ? null : source,
    retrieved:
      previous[scene.id]?.sha256 === sha256(bytes) ? previous[scene.id].retrieved : retrieved,
    ...(scene.mapEyeHeight ? { mapEyeHeight: scene.mapEyeHeight } : {}),
  };
  if (!scene.prebuilt)
    writeFileSync(join(sceneDir, "ATTRIBUTION.txt"), attributionText(scene, entry, source));
  console.log(
    `  ${(entry.byteSize / 1e6).toFixed(1)} MB · ${entry.splatCount.toLocaleString("en-US")} splats`,
  );
  return entry;
}

const entries = [];
for (const scene of catalog.scenes) {
  if (only.size && !only.has(scene.id)) {
    if (previous[scene.id]) entries.push(previous[scene.id]);
    continue;
  }
  entries.push(await buildScene(scene));
}
writeFileSync(generatedPath, `${JSON.stringify(entries, null, 2)}\n`);
console.log(`\nWrote ${entries.length} scenes to ${generatedPath}`);
