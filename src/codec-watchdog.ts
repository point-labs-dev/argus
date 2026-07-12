/**
 * NVR codec-lock watchdog.
 *
 * The Reolink NVR labels its HEVC channels as H264 in the RTSP SDP (the
 * h264Preview_* path is the only name its namespace serves — h265Preview_*
 * 404s — and its fmtp line carries HEVC sprop-vps/sps/pps under an H264
 * rtpmap). go2rtc detects the real codec from the bitstream, but detection is
 * nondeterministic per producer start: a producer can lock in the SDP's h264
 * lie, and every consumer from then on — including the HKSV recorder —
 * depacketizes garbage. Measured 2026-07-12: such a session decodes zero
 * frames while ffmpeg emits ~1,600 stderr lines/sec (the 42 GB serve.err.log
 * incident), and the recording never reaches the Home timeline.
 *
 * This watchdog runs after go2rtc starts, before accessories publish: it reads
 * go2rtc's DETECTED codec for each NVR-fronted h265 main (the receivers' codec
 * in /api/streams — the producer medias just echo the lying SDP) and restarts
 * go2rtc until every such stream detects hevc. Bounded attempts, loud failure.
 * ARGUS_CODEC_WATCHDOG=0 disables.
 */

import type { ArgusConfig, CameraConfig } from "./config.js";
import { buildGo2RtcStreamNames } from "./go2rtc.js";

export interface CodecExpectation {
  cameraName: string;
  /** go2rtc main-stream name (the HKSV recording source). */
  streamName: string;
}

/** NVR-fronted (channel > 0) cameras whose true main codec is h265 — the only
 * streams exposed to the NVR's SDP lie. Standalone h265 cams (channel 0) use
 * honest codec-prefixed paths and never mislock. */
export function nvrHevcMainStreams(config: ArgusConfig): CodecExpectation[] {
  const names = buildGo2RtcStreamNames(config.cameras);
  return config.cameras
    .map((camera: CameraConfig, index: number) => ({ camera, main: names[index]?.main }))
    .filter(({ camera, main }) => main !== undefined && camera.channel > 0 && camera.mainCodec === "h265")
    .map(({ camera, main }) => ({ cameraName: camera.name, streamName: main! }));
}

/**
 * go2rtc's detected video codec for a stream, from the receivers it has
 * materialized ("hevc", "h264", ...) — or undefined when go2rtc has no
 * receiver info yet (producer idle and unconsumed).
 */
export async function detectedVideoCodec(
  apiBaseUrl: string,
  streamName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const res = await fetchImpl(`${apiBaseUrl}/api/streams?src=${encodeURIComponent(streamName)}`);
  if (!res.ok) return undefined;
  const body = (await res.json()) as {
    producers?: Array<{ receivers?: Array<{ codec?: { codec_name?: string; codec_type?: string } }> }>;
  };
  for (const producer of body.producers ?? []) {
    for (const receiver of producer.receivers ?? []) {
      if (receiver.codec?.codec_type === "video" && receiver.codec.codec_name) {
        return receiver.codec.codec_name;
      }
    }
  }
  return undefined;
}

export interface WatchdogOptions {
  apiBaseUrl: string;
  /** Restart go2rtc (supervisor stop + start). */
  restart: () => Promise<void>;
  /** Max go2rtc restarts before giving up loudly. Default 3. */
  maxRestarts?: number;
  /** Wait after a restart before re-checking (producers reconnect). Default 10s. */
  settleMs?: number;
  /** Per-round polling window for receiver info to materialize. Default 20s. */
  checkTimeoutMs?: number;
  /** Poll interval inside a round. Default 2s. */
  checkIntervalMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface WatchdogResult {
  healthy: boolean;
  restarts: number;
  /** Final detected codec per stream (undefined = never materialized). */
  detected: Map<string, string | undefined>;
}

/** Stream names that POSITIVELY detect the wrong codec (h264) — the set serve
 * uses to reroute HKSV to the sub stream. Unknown/absent info is not included. */
export function mislockedStreams(result: WatchdogResult | undefined): Set<string> {
  const mislocked = new Set<string>();
  if (!result) return mislocked;
  for (const [stream, codec] of result.detected) {
    if (codec === "h264") mislocked.add(stream);
  }
  return mislocked;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Verify every expected stream detects hevc; restart go2rtc and re-check until
 * they do or the restart budget is spent. Streams whose codec never
 * materializes are logged but do NOT trigger restarts (an offline NVR must not
 * put boot into a restart loop) — only a positive h264 mislock does.
 */
export async function verifyNvrCodecLocks(
  expectations: readonly CodecExpectation[],
  options: WatchdogOptions,
): Promise<WatchdogResult> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const maxRestarts = options.maxRestarts ?? 3;
  const settleMs = options.settleMs ?? 10_000;
  const checkTimeoutMs = options.checkTimeoutMs ?? 20_000;
  const checkIntervalMs = options.checkIntervalMs ?? 2_000;
  const fetchImpl = options.fetch ?? fetch;

  let restarts = 0;
  const detected = new Map<string, string | undefined>();
  if (expectations.length === 0) return { healthy: true, restarts, detected };

  for (;;) {
    detected.clear();
    const deadline = Date.now() + checkTimeoutMs;
    for (const expectation of expectations) {
      let codec: string | undefined;
      for (;;) {
        try {
          codec = await detectedVideoCodec(options.apiBaseUrl, expectation.streamName, fetchImpl);
        } catch {
          codec = undefined;
        }
        if (codec !== undefined || Date.now() >= deadline) break;
        await sleep(checkIntervalMs);
      }
      detected.set(expectation.streamName, codec);
    }

    const mislocked = expectations.filter((e) => detected.get(e.streamName) === "h264");
    const unknown = expectations.filter((e) => detected.get(e.streamName) === undefined);
    for (const e of unknown) {
      log(`[argus ${e.cameraName}] codec watchdog: no receiver info for ${e.streamName} — skipping (NVR offline?)`);
    }

    if (mislocked.length === 0) {
      const summary = expectations
        .map((e) => `${e.streamName}=${detected.get(e.streamName) ?? "unknown"}`)
        .join(" ");
      log(`[argus] codec watchdog: NVR HEVC mains healthy after ${restarts} restart(s): ${summary}`);
      return { healthy: true, restarts, detected };
    }

    if (restarts >= maxRestarts) {
      for (const e of mislocked) {
        log(
          `[argus ${e.cameraName}] codec watchdog: ${e.streamName} still detects h264 after ${restarts} go2rtc ` +
            `restarts — giving up; the main restream is undecodable for consumers until go2rtc re-detects ` +
            `(serve falls back HKSV to the sub stream)`,
        );
      }
      return { healthy: false, restarts, detected };
    }

    restarts += 1;
    log(
      `[argus] codec watchdog: ${mislocked.map((e) => e.streamName).join(", ")} mislocked as h264 — ` +
        `restarting go2rtc (attempt ${restarts}/${maxRestarts})`,
    );
    await options.restart();
    await sleep(settleMs);
  }
}
