#!/usr/bin/env node
// Publishes the Oculo scene gallery to a public Hugging Face dataset, which is a git
// repository (a backup of every scene) and a free CORS-enabled download host.
//
//   HF_SCENES_REPO=<user>/oculo-scenes pnpm scenes:upload --dry-run   list what would go
//   HF_TOKEN=hf_… HF_SCENES_REPO=<user>/oculo-scenes pnpm scenes:upload
//
// The token comes from the environment only and is never written anywhere. After a
// successful upload the script pins the app to that exact commit in
// apps/mobile/src/config/sceneHosting.json, so the bytes behind each pinned SHA-256
// can never change under the app.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scenes = JSON.parse(
  readFileSync(join(root, "apps/mobile/src/config/sceneCatalog.generated.json"), "utf8"),
);
const catalog = JSON.parse(readFileSync(join(root, "tools/scenes/catalog.json"), "utf8"));
const hostingPath = join(root, "apps/mobile/src/config/sceneHosting.json");
const publicScenes = join(root, "apps/mobile/public/scenes");
const distScenes = join(root, "dist-scenes");

const dryRun = process.argv.includes("--dry-run");
const repoName = process.env.HF_SCENES_REPO?.trim();
if (!repoName || !/^[\w.-]+\/[\w.-]+$/.test(repoName)) {
  console.error("Set HF_SCENES_REPO to <user or org>/<dataset>, e.g. me/oculo-scenes.");
  process.exit(1);
}
const repo = { type: "dataset", name: repoName };

/** Every file to publish: path in the dataset → local path. */
function manifest() {
  const files = [];
  for (const scene of scenes) {
    const sog = scene.bundled
      ? join(publicScenes, scene.id, scene.fileName)
      : join(distScenes, scene.fileName);
    if (!existsSync(sog)) throw new Error(`Missing ${sog}. Run pnpm scenes:build first.`);
    if (statSync(sog).size !== scene.byteSize)
      throw new Error(`${sog} does not match the catalog's size. Rebuild it.`);
    files.push({ path: scene.fileName, local: sog });
    for (const [name, target] of [
      ["thumb.webp", `thumbnails/${scene.id}.webp`],
      ["ATTRIBUTION.txt", `attribution/${scene.id}.txt`],
    ]) {
      const local = join(publicScenes, scene.id, name);
      if (existsSync(local)) files.push({ path: target, local });
    }
  }
  return files;
}

/** The dataset card: what the files are and whose they are. */
function datasetCard() {
  const rows = scenes.map((scene) => {
    const source = catalog.scenes.find((entry) => entry.id === scene.id);
    const url = `https://superspl.at/scene/${scene.superSplatId}`;
    return `| \`${scene.fileName}\` | [${scene.title}](${url}) | [${scene.author}](https://superspl.at/user/${scene.author}) | ${(scene.splatCount / 1e6).toFixed(1)}M | ${(scene.byteSize / 1e6).toFixed(1)} MB | ${source?.bundled ? "bundled in the app" : "downloaded on tap"} |`;
  });
  return `---
license: cc-by-4.0
pretty_name: Oculo scene gallery
tags:
  - gaussian-splatting
  - 3dgs
---

# Oculo scene gallery

Gaussian-splat scenes offered in the Oculo iPhone app's scene gallery. Each is a
creator's scene from [SuperSplat](https://superspl.at), published there under
[CC BY 4.0](${catalog.license.url}).

**Changes:** each scene was reduced to at most 1M splats and re-encoded as a single SOG file
with one spherical-harmonic band, so it fits on a phone. See \`attribution/<id>.txt\` for
each scene's exact credit and changes.

| File | Scene | Creator | Splats | Size | In the app |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

Files are addressed by commit, so a given URL always serves the same bytes; the app checks
each download against a pinned SHA-256.
`;
}

const files = manifest();
const total = files.reduce((sum, file) => sum + statSync(file.local).size, 0);
console.log(`${repoName}: ${files.length} files, ${(total / 1e6).toFixed(1)} MB`);
for (const file of files) console.log(`  ${file.path}`);
console.log("  README.md");
if (dryRun) process.exit(0);

const accessToken = process.env.HF_TOKEN?.trim();
if (!accessToken) {
  console.error("Set HF_TOKEN to a Hugging Face token with write access (it is not stored).");
  process.exit(1);
}

const { createRepo, repoExists, uploadFiles } = await import("@huggingface/hub");
if (!(await repoExists({ repo, accessToken }))) {
  console.log(`Creating public dataset ${repoName}…`);
  await createRepo({ repo, accessToken, visibility: "public", license: "cc-by-4.0" });
}
const output = await uploadFiles({
  repo,
  accessToken,
  commitTitle: "Publish Oculo scene gallery",
  files: [
    ...files.map((file) => ({
      path: file.path,
      content: new Blob([readFileSync(file.local)]),
    })),
    { path: "README.md", content: new Blob([datasetCard()]) },
  ],
});
const oid = output?.commit.oid;
if (!oid) {
  console.log("Nothing changed on the Hub; sceneHosting.json is unchanged.");
  process.exit(0);
}
const baseUrl = `https://huggingface.co/datasets/${repoName}/resolve/${oid}`;
writeFileSync(
  hostingPath,
  `${JSON.stringify({ provider: "huggingface", repo: repoName, commit: oid, baseUrl }, null, 2)}\n`,
);
console.log(`Published ${oid}. The app now downloads from:\n  ${baseUrl}`);
