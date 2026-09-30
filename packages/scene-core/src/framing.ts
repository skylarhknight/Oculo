export interface OutputFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Fits a centered output frame inside the available CSS-pixel rectangle. */
export function fitOutputFrame(width: number, height: number, aspectRatio: number): OutputFrame {
  if (!Number.isFinite(width) || width < 0 || !Number.isFinite(height) || height < 0) {
    throw new RangeError("Frame dimensions must be finite and non-negative");
  }
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw new RangeError("Output aspect ratio must be finite and positive");
  }
  const frameWidth = Math.min(width, height * aspectRatio);
  const frameHeight = frameWidth / aspectRatio;
  return {
    x: (width - frameWidth) / 2,
    y: (height - frameHeight) / 2,
    width: frameWidth,
    height: frameHeight,
  };
}
