import { Buffer } from "node:buffer";

import type { ArgusConfig } from "./config.js";
import { buildGo2RtcStreamNames, type CameraProfile } from "./go2rtc.js";

export type SnapshotProfile = CameraProfile;

export interface CachedSnapshot {
  cameraName: string;
  profile: SnapshotProfile;
  streamName: string;
  url: string;
  capturedAt: Date;
  buffer: Buffer;
  bytes: number;
}

export interface SnapshotCacheOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  defaultProfile?: SnapshotProfile;
  pollIntervalMs?: number;
}

export class SnapshotCacheError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SnapshotCacheError";
  }
}

/**
 * Width/height from a JPEG buffer (the SOFn frame header). Used at startup to
 * probe a camera's live-stream resolution from its snapshot, so the HomeKit
 * accessory can advertise the native size that copy-mode live view delivers.
 */
export function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    // Standalone markers with no length payload (SOI, RSTn, TEM).
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) {
      return undefined; // start-of-scan before any SOF — give up rather than misparse
    }
    // SOFn carry the frame size: [length(2)][precision(1)][height(2)][width(2)].
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return undefined;
}

interface CameraStreams {
  cameraName: string;
  streams: Record<SnapshotProfile, string>;
}

export class SnapshotCache {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly defaultProfile: SnapshotProfile;
  private readonly pollIntervalMs: number;
  private readonly camerasByName = new Map<string, CameraStreams>();
  private readonly snapshots = new Map<string, CachedSnapshot>();
  private pollingAbortController: AbortController | undefined;
  private pollingPromise: Promise<void> | undefined;

  public constructor(private readonly config: ArgusConfig, options: SnapshotCacheOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.defaultProfile = options.defaultProfile ?? "sub";
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;

    for (const streamNames of buildGo2RtcStreamNames(config.cameras)) {
      if (this.camerasByName.has(streamNames.cameraName)) {
        throw new SnapshotCacheError(`Duplicate camera name "${streamNames.cameraName}" cannot be used in SnapshotCache.`);
      }

      this.camerasByName.set(streamNames.cameraName, {
        cameraName: streamNames.cameraName,
        streams: {
          main: streamNames.main,
          sub: streamNames.sub,
        },
      });
    }
  }

  public get(cameraName: string, profile: SnapshotProfile = this.defaultProfile): CachedSnapshot | undefined {
    this.resolveStreamName(cameraName, profile);
    return this.snapshots.get(this.cacheKey(cameraName, profile));
  }

  public async getOrRefresh(
    cameraName: string,
    profile: SnapshotProfile = this.defaultProfile,
    signal?: AbortSignal,
  ): Promise<CachedSnapshot> {
    return this.get(cameraName, profile) ?? this.refresh(cameraName, profile, signal);
  }

  public async refresh(
    cameraName: string,
    profile: SnapshotProfile = this.defaultProfile,
    signal?: AbortSignal,
  ): Promise<CachedSnapshot> {
    const streamName = this.resolveStreamName(cameraName, profile);
    const url = this.buildSnapshotUrl(streamName);
    const requestInit: RequestInit | undefined = signal ? { signal } : undefined;
    const response = await this.fetchFn(url, requestInit);

    if (!response.ok) {
      throw new SnapshotCacheError(`Snapshot request failed for "${cameraName}" (${profile}): HTTP ${response.status}.`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    this.assertJpeg(buffer, cameraName, profile);

    const snapshot: CachedSnapshot = {
      cameraName,
      profile,
      streamName,
      url,
      capturedAt: this.now(),
      buffer,
      bytes: buffer.length,
    };

    this.snapshots.set(this.cacheKey(cameraName, profile), snapshot);
    return snapshot;
  }

  public startPolling(intervalMs = this.pollIntervalMs, profiles: readonly SnapshotProfile[] = [this.defaultProfile]): void {
    if (this.pollingPromise) {
      return;
    }

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new SnapshotCacheError("Snapshot polling interval must be greater than zero milliseconds.");
    }

    const abortController = new AbortController();
    this.pollingAbortController = abortController;
    this.pollingPromise = this.poll(intervalMs, profiles, abortController.signal).finally(() => {
      if (this.pollingAbortController === abortController) {
        this.pollingAbortController = undefined;
        this.pollingPromise = undefined;
      }
    });
  }

  public async stopPolling(): Promise<void> {
    this.pollingAbortController?.abort();
    await this.pollingPromise;
  }

  private async poll(intervalMs: number, profiles: readonly SnapshotProfile[], signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      for (const camera of this.camerasByName.values()) {
        for (const profile of profiles) {
          if (signal.aborted) {
            return;
          }

          try {
            await this.refresh(camera.cameraName, profile, signal);
          } catch (error) {
            if (signal.aborted) {
              return;
            }
          }
        }
      }

      await delay(intervalMs, signal);
    }
  }

  private buildSnapshotUrl(streamName: string): string {
    const url = new URL(`http://127.0.0.1:${this.config.go2rtc.api_port}/api/frame.jpeg`);
    url.searchParams.set("src", streamName);
    return url.toString();
  }

  private resolveStreamName(cameraName: string, profile: SnapshotProfile): string {
    const camera = this.camerasByName.get(cameraName);

    if (!camera) {
      throw new SnapshotCacheError(`Unknown camera "${cameraName}".`);
    }

    return camera.streams[profile];
  }

  private cacheKey(cameraName: string, profile: SnapshotProfile): string {
    return `${cameraName}\u0000${profile}`;
  }

  private assertJpeg(buffer: Buffer, cameraName: string, profile: SnapshotProfile): void {
    if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
      throw new SnapshotCacheError(`Invalid JPEG snapshot for "${cameraName}" (${profile}).`);
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timeout: NodeJS.Timeout;

    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    const onAbort = (): void => {
      finish();
    };

    timeout = setTimeout(finish, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
