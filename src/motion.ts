import type { CameraConfig } from "./config.js";
import { ReolinkClient } from "./reolink.js";

// Polls each camera's Reolink motion state and reports edges (on/off) with a
// cooldown, so a brief gap in detection doesn't flap the HomeKit motion sensor.
// Apple's Home Hub does the actual person/vehicle/animal classification on the
// HKSV recording this triggers — Reolink's (noisy) AI is intentionally bypassed.

export interface MotionMonitorOptions {
  /** Poll interval per camera, ms. Default 1000. */
  pollIntervalMs?: number;
  /** Keep "motion" asserted this long after the last positive reading. Default 30000. */
  cooldownMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  onError?: (cameraName: string, error: Error) => void;
}

interface CameraState {
  camera: CameraConfig;
  client: ReolinkClient;
  detected: boolean;
  lastMotionAt: number;
}

export class MotionMonitor {
  private readonly states: CameraState[];
  private readonly pollIntervalMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onError: ((cameraName: string, error: Error) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  public constructor(
    cameras: readonly CameraConfig[],
    private readonly onMotion: (cameraName: string, detected: boolean) => void,
    options: MotionMonitorOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
    this.onError = options.onError;
    this.states = cameras.map((camera) => ({
      camera,
      client: new ReolinkClient({
        host: camera.host,
        username: camera.username,
        password: camera.password,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
      detected: false,
      lastMotionAt: 0,
    }));
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One poll cycle across all cameras. Exposed for tests; re-entrancy guarded. */
  public async pollOnce(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      await Promise.all(this.states.map((state) => this.pollCamera(state)));
    } finally {
      this.polling = false;
    }
  }

  private async pollCamera(state: CameraState): Promise<void> {
    let active: boolean;
    try {
      active = await state.client.getMotionState(state.camera.channel);
    } catch (error) {
      this.onError?.(state.camera.name, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const now = this.now();
    if (active) {
      state.lastMotionAt = now;
      if (!state.detected) {
        state.detected = true;
        this.onMotion(state.camera.name, true);
      }
    } else if (state.detected && now - state.lastMotionAt >= this.cooldownMs) {
      state.detected = false;
      this.onMotion(state.camera.name, false);
    }
  }
}
