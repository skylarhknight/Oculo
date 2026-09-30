import { describe, expect, it } from "vitest";

import { fitOutputFrame } from "../src/framing.js";

describe("fitOutputFrame", () => {
  it("fits a wide output inside a portrait viewport with centered letterboxing", () => {
    expect(fitOutputFrame(390, 600, 16 / 9)).toEqual({
      x: 0,
      y: 190.3125,
      width: 390,
      height: 219.375,
    });
  });

  it("fits a portrait output inside a wide viewport with centered pillarboxing", () => {
    expect(fitOutputFrame(800, 450, 9 / 16)).toEqual({
      x: 273.4375,
      y: 0,
      width: 253.125,
      height: 450,
    });
  });

  it("keeps square and matching output bounds exact", () => {
    expect(fitOutputFrame(600, 400, 1)).toEqual({ x: 100, y: 0, width: 400, height: 400 });
    expect(fitOutputFrame(640, 360, 16 / 9)).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });

  it("supports collapsed viewports without dividing by zero", () => {
    expect(fitOutputFrame(0, 400, 16 / 9)).toEqual({ x: 0, y: 200, width: 0, height: 0 });
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid output aspect %s", (aspect) => {
    expect(() => fitOutputFrame(800, 450, aspect)).toThrow(RangeError);
  });

  it.each([-1, NaN, Infinity])("rejects invalid viewport size %s", (dimension) => {
    expect(() => fitOutputFrame(dimension, 450, 16 / 9)).toThrow(RangeError);
    expect(() => fitOutputFrame(800, dimension, 16 / 9)).toThrow(RangeError);
  });
});
