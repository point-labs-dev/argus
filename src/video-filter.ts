import type { CameraAspect } from "./config.js";

export type AspectFit = "crop" | "pad";

export interface AspectScaleFilterInput {
  width: number;
  height: number;
  aspect: CameraAspect;
  /** "crop" is live 4:3. "pad" keeps the whole frame. */
  fit: AspectFit;
}

export function boxMatchesCameraAspect(width: number, height: number, aspect: CameraAspect): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return false;
  }
  if (aspect === "16:9") return width * 9 === height * 16;
  if (aspect === "4:3") return width * 3 === height * 4;
  return false;
}

/**
 * Shared ffmpeg `-vf` value for a camera frame inside a HomeKit box.
 * Live view calls this for every session. Recording calls it when a 4:3
 * frame does not already fill the box. A bare `scale=W:H` is not this helper.
 */
export function buildAspectScaleFilter(input: AspectScaleFilterInput): string {
  const { width, height, fit } = input;
  if (fit === "crop") {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height},setsar=1`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
}
