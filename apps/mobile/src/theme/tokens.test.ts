import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = join(__dirname, "..");

function stylesheets(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

/** Raw values that must come from tokens.css instead. */
const RAW_VALUE = [
  { name: "hex color", pattern: /#[0-9a-f]{3,8}\b/i },
  { name: "rgb/hsl color", pattern: /\b(?:rgba?|hsla?)\(/i },
  // Pixel lengths other than hairlines and zero belong on the spacing/radius scales.
  { name: "pixel length", pattern: /(?<![\w-])(?!0px|1px)\d+(?:\.\d+)?px\b/ },
  { name: "raw duration", pattern: /(?<![\w-])\d+(?:\.\d+)?m?s\b(?![\w-])/ },
];

describe("design tokens", () => {
  const files = stylesheets(SOURCE)
    .map((path) => relative(SOURCE, path).split("\\").join("/"))
    .filter((path) => path !== "theme/tokens.css");

  it("finds the token-only stylesheets", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "ui/ui.css",
        "navigation/navigation.css",
        "screens/screens.css",
        "screens/scene/workspace.css",
        "components/components.css",
        "shotSheet.css",
        "speedCurve.css",
      ]),
    );
  });

  it.each(files)("%s uses tokens for colors, lengths, and timing", (path) => {
    const css = readFileSync(join(SOURCE, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const violations = css
      .split("\n")
      .flatMap((line, index) =>
        RAW_VALUE.filter(({ pattern }) => pattern.test(line)).map(
          ({ name }) => `${path}:${index + 1} ${name}: ${line.trim()}`,
        ),
      );
    expect(violations).toEqual([]);
  });

  it("defines every token the stylesheets reference", () => {
    const defined = new Set(
      [...readFileSync(join(SOURCE, "theme/tokens.css"), "utf8").matchAll(/(--[\w-]+)\s*:/g)].map(
        (match) => match[1],
      ),
    );
    // Properties set at runtime by components rather than tokens.css.
    const runtime = new Set([
      "--i",
      "--swipe-x",
      "--swipe-progress",
      "--sheet-drag",
      "--range-value",
      "--seg-index",
      "--seg-count",
      "--letterbox",
      "--playhead",
      "--fan-x",
      "--fan-y",
      "--progress",
      "--k",
      "--reveal-i",
      "--callout-ms",
    ]);
    const missing = files.flatMap((path) => {
      const css = readFileSync(join(SOURCE, path), "utf8");
      // Component-scoped properties (declared and read in the same stylesheet).
      const local = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
      return [...css.matchAll(/var\((--[\w-]+)/g)]
        .map((match) => match[1]!)
        .filter((name) => !defined.has(name) && !runtime.has(name) && !local.has(name))
        .map((name) => `${path}: ${name}`);
    });
    expect(missing).toEqual([]);
  });

  it("gives every appearance-dependent primitive a light value", () => {
    const css = readFileSync(join(SOURCE, "theme/tokens.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const block = (start: string) => {
      const from = css.indexOf(start);
      let depth = 0;
      for (let index = css.indexOf("{", from); index < css.length; index += 1) {
        if (css[index] === "{") depth += 1;
        if (css[index] === "}") depth -= 1;
        if (depth === 0) return css.slice(from, index);
      }
      return css.slice(from);
    };
    const names = (text: string) =>
      new Set([...text.matchAll(/(--palette-[\w-]+)\s*:/g)].map((match) => match[1]));
    const dark = names(block(":root,\n[data-appearance"));
    const light = names(block(':root[data-theme="light"]'));
    expect(dark.size).toBeGreaterThan(20);
    expect([...dark].filter((name) => !light.has(name))).toEqual([]);
  });
});
