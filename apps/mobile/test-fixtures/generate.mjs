import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
const points = [];
for (let y = 0; y < 12; y++)
  for (let x = 0; x < 16; x++)
    points.push({
      p: [(x - 7.5) * 0.14, (y - 5.5) * 0.14, -0.1 * Math.sin(x)],
      rgb: [x / 15, y / 11, 1 - x / 30],
    });
const n = points.length,
  b = Buffer.alloc(16 + n * 19);
b.writeUInt32LE(0x5053474e, 0);
b.writeUInt32LE(2, 4);
b.writeUInt32LE(n, 8);
b[13] = 12;
for (let i = 0; i < n; i++) {
  for (let j = 0; j < 3; j++)
    b.writeIntLE(Math.round(points[i].p[j] * 4096), 16 + i * 9 + j * 3, 3);
  b[16 + n * 9 + i] = 245;
  for (let j = 0; j < 3; j++) {
    b[16 + n * 10 + i * 3 + j] = Math.round(128 + (points[i].rgb[j] - 0.5) * 2 * 127);
    b[16 + n * 13 + i * 3 + j] = Math.round((Math.log(0.08) + 10) * 16);
    b[16 + n * 16 + i * 3 + j] = 128;
  }
}
mkdirSync("apps/mobile/test-fixtures", { recursive: true });
writeFileSync("apps/mobile/test-fixtures/colored-wall.spz", gzipSync(b, { mtime: 0 }));
