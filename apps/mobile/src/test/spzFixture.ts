import { gzipSync } from "node:zlib";

export function spzFixture(
  options: {
    version?: number;
    count?: number;
    degree?: number;
    flags?: number;
    fractionalBits?: number;
    trailing?: number;
    truncate?: number;
    magic?: number;
    positions?: [number, number, number][];
    scaleByte?: number;
  } = {},
): File {
  const version = options.version ?? 2;
  const count = options.positions?.length ?? options.count ?? 2;
  const degree = options.degree ?? 0;
  const bytesPerPoint = 16 + (version === 3 ? 4 : 3) + ((degree + 1) ** 2 - 1) * 3;
  const bytes = Buffer.alloc(16 + count * bytesPerPoint + (options.trailing ?? 0));
  bytes.writeUInt32LE(options.magic ?? 0x5053474e, 0);
  bytes.writeUInt32LE(version, 4);
  bytes.writeUInt32LE(count, 8);
  bytes[12] = degree;
  bytes[13] = options.fractionalBits ?? 12;
  bytes[14] = options.flags ?? 0;
  for (let index = 0; index < count; index += 1) {
    const position = options.positions?.[index];
    if (position) {
      for (let axis = 0; axis < 3; axis += 1)
        bytes.writeIntLE(
          Math.round(position[axis]! * 2 ** (options.fractionalBits ?? 12)),
          16 + index * 9 + axis * 3,
          3,
        );
    } else bytes.writeIntLE(index === 0 ? -4096 : 4096, 16 + index * 9, 3);
    bytes[16 + count * 9 + index] = 255;
    bytes.fill(128, 16 + count * 10 + index * 3, 16 + count * 10 + index * 3 + 3);
    bytes.fill(
      options.scaleByte ?? 120,
      16 + count * 13 + index * 3,
      16 + count * 13 + index * 3 + 3,
    );
    bytes.fill(
      128,
      16 + count * 16 + index * (version === 3 ? 4 : 3),
      16 + count * 16 + index * (version === 3 ? 4 : 3) + (version === 3 ? 4 : 3),
    );
  }
  const compressed = gzipSync(bytes.subarray(0, bytes.length - (options.truncate ?? 0)));
  return new File([compressed], "fixture.spz");
}
