import type { CameraConfig } from "./config.js";
import { ReolinkClient, redactCredentialHosts, type ReolinkClientOptions } from "./reolink.js";
import { emitTelemetry } from "./telemetry.js";
import { emitTiming } from "./timing.js";

/** Standalone cameras report AI on channel 0. The NVR channel stays on GetMdState. */
const DIRECT_AI_CHANNEL = 0;
/** First repeat of a poll error waits this long. Then the delay doubles. */
const ERROR_LOG_BACKOFF_START_MS = 5_000;
const ERROR_LOG_BACKOFF_MAX_MS = 60_000;

/** stderr line for a motion poll failure. Userinfo in the message is removed. */
export function writeMotionPollError(cameraName: string, error: Error): void {
  process.stderr.write(`[argus ${cameraName}] motion poll error: ${redactCredentialHosts(error.message)}\n`);
}

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
  /** Test seam. Production uses `new ReolinkClient`. */
  createClient?: (options: ReolinkClientOptions) => ReolinkClient;
}

interface CameraState {
  camera: CameraConfig;
  client: ReolinkClient;
  /** Present only when cameras[].directAiHost is set. GetAiState only. */
  directAi: ReolinkClient | undefined;
  detected: boolean;
  lastMotionAt: number;
  /** Delay before another poll error for this camera may be logged. */
  errorBackoffMs: number;
  /** Earliest `now()` at which the next poll error may be logged. 0 logs immediately. */
  nextErrorLogAt: number;
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
    const createClient = options.createClient ?? ((clientOptions: ReolinkClientOptions) => new ReolinkClient(clientOptions));
    this.states = cameras.map((camera) => {
      const shared = {
        username: camera.username,
        password: camera.password,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      };
      const directAiHost = camera.directAiHost;
      return {
        camera,
        client: createClient({ host: camera.host, ...shared }),
        directAi: directAiHost === undefined ? undefined : createClient({ host: directAiHost, ...shared }),
        detected: false,
        lastMotionAt: 0,
        errorBackoffMs: 0,
        nextErrorLogAt: 0,
      };
    });
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

  private async readActive(state: CameraState): Promise<boolean> {
    if (!state.directAi) {
      return state.client.getMotionState(state.camera.channel);
    }
    if (await state.client.getMdState(state.camera.channel)) {
      return true;
    }
    return state.directAi.getAiState(DIRECT_AI_CHANNEL);
  }

  private reportPollError(state: CameraState, error: Error): void {
    const now = this.now();
    if (state.nextErrorLogAt !== 0 && now < state.nextErrorLogAt) {
      return;
    }
    this.onError?.(state.camera.name, error);
    const delay = state.errorBackoffMs === 0
      ? ERROR_LOG_BACKOFF_START_MS
      : Math.min(state.errorBackoffMs * 2, ERROR_LOG_BACKOFF_MAX_MS);
    state.errorBackoffMs = delay;
    state.nextErrorLogAt = now + delay;
  }

  private async pollCamera(state: CameraState): Promise<void> {
    let active = false;
    try {
      active = await this.readActive(state);
      state.errorBackoffMs = 0;
      state.nextErrorLogAt = 0;
    } catch (error) {
      this.reportPollError(state, error instanceof Error ? error : new Error(String(error)));
    }

    const now = this.now();
    if (active) {
      state.lastMotionAt = now;
      if (!state.detected) {
        state.detected = true;
        emitTelemetry(state.camera.name, "motion_detected");
        emitTiming({ stage: "motion_detected", camera: state.camera.name });
        this.onMotion(state.camera.name, true);
      }
    } else if (state.detected && now - state.lastMotionAt >= this.cooldownMs) {
      state.detected = false;
      emitTelemetry(state.camera.name, "motion_cleared");
      this.onMotion(state.camera.name, false);
    }
  }
}
