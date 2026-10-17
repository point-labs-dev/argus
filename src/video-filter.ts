import type { CameraAspect } from "./config.js";

export type AspectFit = "crop" | "pad";

export interface AspectScaleFilterInput {
  width: number;
  height: number;
  aspect: CameraAspect;
  /** "crop" is live 4:3. "pad" keeps the whole frame. Recording always passes "pad". */
  fit: AspectFit;
  /**
   * Recording sets this. A box with the same aspect as the camera is exactly
   * `scale=W:H`. Live view leaves it off, so a 16:9 session keeps today's pad
   * string even when Home's box is already 16:9.
   */
  bareScaleWhenMatched?: boolean;
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
 * Live view and HKSV recording both call this so the crop and pad strings
 * cannot drift. A bare `scale=W:H` stretches a mismatched frame.
 */
export function buildAspectScaleFilter(input: AspectScaleFilterInput): string {
  const { width, height, aspect, fit } = input;
  if (input.bareScaleWhenMatched && boxMatchesCameraAspect(width, height, aspect)) {
    return `scale=${width}:${height}`;
  }
  if (fit === "crop") {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height},setsar=1`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
}
