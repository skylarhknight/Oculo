import { SHOT_SHEET_LIMITS, ShotSheetError, type SheetDocument } from "./model";

export type SheetElement =
  | {
      readonly kind: "text";
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly size: number;
      readonly bold: boolean;
      readonly color: string;
      readonly role: "header" | "name" | "notes" | "meta" | "footer";
      readonly direction?: "ltr" | "rtl";
      readonly shotId?: string;
    }
  | {
      readonly kind: "image";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly shotId: string;
    }
  | { readonly kind: "line"; readonly x: number; readonly y: number; readonly width: number };
export interface SheetPageLayout {
  readonly number: number;
  readonly elements: readonly SheetElement[];
}
export type MeasureSheetText = (text: string, size: number, bold: boolean) => number;

export function sheetTextDirection(text: string): "ltr" | "rtl" {
  const firstLetter = /\p{Letter}/u.exec(text)?.[0] ?? "";
  return /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u.test(firstLetter) ? "rtl" : "ltr";
}

/** Wraps at word boundaries where possible, then grapheme boundaries. No text is discarded. */
export function wrapSheetText(
  text: string,
  width: number,
  measure: (text: string) => number,
): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    const graphemes = [...segmenter.segment(paragraph)].map((part) => part.segment);
    if (!graphemes.length) {
      lines.push("");
      continue;
    }
    let start = 0;
    while (start < graphemes.length) {
      let end = start;
      let breakAt = -1;
      let line = "";
      while (end < graphemes.length) {
        const next = line + graphemes[end]!;
        if (measure(next) > width && end > start) break;
        line = next;
        end += 1;
        if (/\s/u.test(graphemes[end - 1]!)) breakAt = end;
      }
      if (end < graphemes.length && breakAt > start) end = breakAt;
      lines.push(graphemes.slice(start, end).join(""));
      start = end;
    }
  }
  return lines;
}

export function layoutShotSheet(
  document: SheetDocument,
  measure: MeasureSheetText,
): SheetPageLayout[] {
  const margin = 80;
  const width = SHOT_SHEET_LIMITS.width - margin * 2;
  const bottom = SHOT_SHEET_LIMITS.height - 100;
  const pages: { number: number; elements: SheetElement[] }[] = [];
  let page: { number: number; elements: SheetElement[] };
  let y = 0;
  const text = (
    value: string,
    size: number,
    bold: boolean,
    role: Extract<SheetElement, { kind: "text" }>["role"],
    shotId?: string,
    color = "#202823",
    direction = sheetTextDirection(value),
  ) => {
    page.elements.push({
      kind: "text",
      x: direction === "rtl" ? margin + width : margin,
      y,
      text: value,
      size,
      bold,
      color,
      role,
      direction,
      ...(shotId === undefined ? {} : { shotId }),
    });
    y += Math.ceil(size * 1.4);
  };
  const newPage = () => {
    if (pages.length >= SHOT_SHEET_LIMITS.pages)
      throw new ShotSheetError(
        "limits",
        "This sheet needs more than 40 pages. Select fewer shots or shorten notes.",
      );
    page = { number: pages.length + 1, elements: [] };
    pages.push(page);
    y = 60;
    text("OCULO / SHOT SHEET", 20, true, "header", undefined, "#46682d");
    for (const line of wrapSheetText(document.title, width, (value) => measure(value, 38, true)))
      text(line, 38, true, "header");
    for (const line of wrapSheetText(`Location: ${document.location}`, width, (value) =>
      measure(value, 23, false),
    ))
      text(line, 23, false, "header");
    text(
      `Generated ${document.generatedAt.slice(0, 10)} (UTC) · ${document.shots.length} ${document.shots.length === 1 ? "shot" : "shots"}`,
      20,
      false,
      "header",
    );
    if (document.attribution) {
      for (const line of wrapSheetText(document.attribution, width, (value) =>
        measure(value, 18, false),
      ))
        text(line, 18, false, "header", undefined, "#637065");
    }
    y += 18;
    page.elements.push({ kind: "line", x: margin, y, width });
    y += 28;
    if (y > bottom - 620)
      throw new ShotSheetError(
        "limits",
        "Project or location names are too long for a readable page header. Shorten these names.",
      );
  };
  newPage();
  for (const shot of document.shots) {
    if (y > bottom - 600) newPage();
    const continuation = () => {
      newPage();
      text(
        `SHOT ${String(shot.number).padStart(2, "0")} / CONTINUED`,
        21,
        true,
        "meta",
        shot.id,
        "#46682d",
      );
    };
    const lines = (value: string, size: number, bold: boolean, role: "name" | "notes" | "meta") => {
      for (const paragraph of value.replace(/\r\n?/g, "\n").split("\n")) {
        const direction = sheetTextDirection(paragraph);
        for (const line of wrapSheetText(paragraph, width, (part) => measure(part, size, bold))) {
          if (y + Math.ceil(size * 1.4) > bottom) continuation();
          text(line, size, bold, role, shot.id, "#202823", direction);
        }
      }
    };
    text(`SHOT ${String(shot.number).padStart(2, "0")}`, 21, true, "meta", shot.id, "#46682d");
    lines(shot.name, 32, true, "name");
    lines(shot.metadata, 22, false, "meta");
    y += 12;
    if (y + 370 > bottom) continuation();
    page!.elements.push({ kind: "image", x: margin, y, width, height: 350, shotId: shot.id });
    y += 374;
    if (shot.notes.length) lines(shot.notes, 25, false, "notes");
    y += 26;
    if (y < bottom) page!.elements.push({ kind: "line", x: margin, y, width });
    y += 26;
  }
  for (const current of pages) {
    current.elements.push({
      kind: "text",
      x: margin,
      y: SHOT_SHEET_LIMITS.height - 60,
      text: `Digital reference images · Oculo                                      Page ${current.number} / ${pages.length}`,
      size: 19,
      bold: false,
      color: "#637065",
      role: "footer",
    });
  }
  return pages;
}
