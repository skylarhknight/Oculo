/** Run from any directory: node apps/mobile/scripts/render-icons.mjs [--preview=/tmp/icons.png] */
import { Buffer } from "node:buffer";
import { log } from "node:console";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(appRoot, "package.json"));
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const source = await readFile(resolve(appRoot, "assets/icon.svg"), "utf8");
const license = await readFile(resolve(appRoot, "assets/icon-LICENSE.txt"), "utf8");
const background = source.match(/<rect\b(?=[^>]*\bid="icon-background")[^>]*\/>/g);
if (background?.length !== 1)
  throw new Error("Source SVG must contain exactly one icon-background rectangle.");
const image = await loadImage(Buffer.from(source));
const foreground = await loadImage(Buffer.from(source.replace(background[0], "")));
const res = resolve(appRoot, "android/app/src/main/res");
const densities = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** Canvas PNGs retain an alpha channel even when opaque; encode actual RGB for iOS. */
function opaquePng(canvas) {
  const { width, height } = canvas;
  const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const input = (y * width + x) * 4;
      if (pixels[input + 3] !== 255) throw new Error("Opaque icon contains a transparent pixel.");
      const output = y * (1 + width * 3) + 1 + x * 3;
      scanlines[output] = pixels[input];
      scanlines[output + 1] = pixels[input + 1];
      scanlines[output + 2] = pixels[input + 2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2; // Truecolor RGB, no alpha channel.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("sRGB", Buffer.from([0])),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function savePng(canvas, path, opaque = false) {
  const bytes = opaque ? opaquePng(canvas) : await canvas.encode("png");
  const attributed = Buffer.concat([
    bytes.subarray(0, -12),
    chunk("tEXt", Buffer.from(`License\0${license}`, "latin1")),
    bytes.subarray(-12),
  ]);
  const decoded = await loadImage(attributed);
  if (decoded.width !== canvas.width || decoded.height !== canvas.height)
    throw new Error("Encoded icon dimensions changed.");
  if (opaque && attributed[25] !== 2) throw new Error("Opaque icon must use PNG RGB color type.");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, attributed);
}

function iconCanvas(size, mask = "square") {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  if (mask !== "square") {
    context.beginPath();
    if (mask === "circle") context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    else context.roundRect(0, 0, size, size, size * 0.22);
    context.clip();
  }
  context.drawImage(image, 0, 0, size, size);
  return canvas;
}

function foregroundCanvas(size) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  // Android's visible mask is normally 72dp within a 108dp layer. Rendering at
  // 2/3 size matches the legacy icon's visual weight and keeps all artwork safe.
  context.drawImage(foreground, size / 6, size / 6, (size * 2) / 3, (size * 2) / 3);
  const pixels = context.getImageData(0, 0, size, size).data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (
        pixels[(y * size + x) * 4 + 3] > 0 &&
        Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > (size * 33) / 108
      ) {
        throw new Error("Android foreground extends beyond the centered 66dp safe circle.");
      }
    }
  }
  return canvas;
}

await savePng(
  iconCanvas(1024),
  resolve(appRoot, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"),
  true,
);
await savePng(iconCanvas(512), resolve(appRoot, "assets/icon-512.png"), true);
for (const [density, scale] of densities) {
  const directory = resolve(res, `mipmap-${density}`);
  await savePng(iconCanvas(48 * scale, "rounded"), resolve(directory, "ic_launcher.png"));
  await savePng(iconCanvas(48 * scale, "circle"), resolve(directory, "ic_launcher_round.png"));
  await savePng(foregroundCanvas(108 * scale), resolve(directory, "ic_launcher_foreground.png"));
}

const xmlHeader = '<?xml version="1.0" encoding="utf-8"?>\n';
for (const version of [26, 33]) {
  const directory = resolve(res, `mipmap-anydpi-v${version}`);
  await mkdir(directory, { recursive: true });
  const adaptive =
    xmlHeader +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@color/ic_launcher_background"/>\n' +
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n' +
    (version === 33
      ? '    <monochrome android:drawable="@mipmap/ic_launcher_foreground"/>\n'
      : "") +
    "</adaptive-icon>\n";
  for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"])
    await writeFile(resolve(directory, name), adaptive);
}
await writeFile(
  resolve(res, "values/ic_launcher_background.xml"),
  xmlHeader +
    '<resources>\n    <color name="ic_launcher_background">#09090a</color>\n</resources>\n',
);
await writeFile(
  resolve(res, "drawable/ic_launcher_background.xml"),
  xmlHeader +
    '<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n    <solid android:color="@color/ic_launcher_background"/>\n</shape>\n',
);
await writeFile(
  resolve(res, "drawable-v24/ic_launcher_foreground.xml"),
  xmlHeader +
    '<bitmap xmlns:android="http://schemas.android.com/apk/res/android" android:src="@mipmap/ic_launcher_foreground" android:gravity="fill"/>\n',
);
await mkdir(resolve(appRoot, "public/licenses"), { recursive: true });
await writeFile(resolve(appRoot, "public/licenses/oculo-icon.txt"), license);

const previewArgument = argv.slice(2).find((argument) => argument.startsWith("--preview="));
if (previewArgument) {
  const preview = createCanvas(960, 390);
  const context = preview.getContext("2d");
  context.fillStyle = "#252628";
  context.fillRect(0, 0, 960, 390);
  const variants = [
    ["iOS", iconCanvas(256, "rounded")],
    ["Android round", iconCanvas(256, "circle")],
    ["Adaptive safe area", foregroundCanvas(256)],
  ];
  for (const [index, [label, icon]] of variants.entries()) {
    const x = 32 + index * 320;
    context.drawImage(icon, x, 28);
    context.fillStyle = "#f2f0e9";
    context.font = "18px sans-serif";
    context.fillText(label, x, 319);
    if (index === 2) {
      context.strokeStyle = "#797c72";
      context.lineWidth = 1;
      context.setLineDash([4, 4]);
      context.beginPath();
      context.arc(x + 128, 156, (256 * 33) / 108, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([]);
    }
  }
  for (const [index, size] of [24, 32, 48].entries())
    context.drawImage(iconCanvas(size, "rounded"), 36 + index * 62, 338);
  await savePng(preview, resolve(previewArgument.slice("--preview=".length)));
}
log(
  "Rendered iOS RGB 1024px, store RGB 512px, and 15 Android PNGs; all adaptive artwork fits the 66dp safe circle.",
);
