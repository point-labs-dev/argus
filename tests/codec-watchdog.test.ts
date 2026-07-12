import { describe, expect, it } from "vitest";

import { detectedVideoCodec, mislockedStreams, nvrHevcMainStreams, verifyNvrCodecLocks } from "../src/codec-watchdog.js";
import type { ArgusConfig } from "../src/config.js";

const cam = (name: string, channel: number, mainCodec: "h264" | "h265") =>
  ({ name, host: channel > 0 ? "10.0.0.13" : "10.0.0.5", channel, username: "u", password: "p", mainCodec }) as never;

const configWith = (cameras: unknown[]): ArgusConfig => ({ cameras }) as never;

const streamsResponse = (codecName: string | undefined) =>
  ({
    ok: true,
    json: async () => ({
      producers: [
        {
          receivers:
            codecName === undefined
              ? []
              : [
                  { codec: { codec_name: "aac", codec_type: "audio" } },
                  { codec: { codec_name: codecName, codec_type: "video" } },
                ],
        },
      ],
    }),
  }) as never;

describe("nvrHevcMainStreams", () => {
  it("selects only NVR-fronted h265 mains (standalone h265 SDPs are honest)", () => {
    const config = configWith([
      cam("Backyard Left", 0, "h265"), // standalone: honest SDP, excluded
      cam("Garage Door", 0, "h264"),
      cam("Front L", 2, "h265"),
      cam("Front R", 3, "h265"),
      cam("Backyard Right", 6, "h264"), // NVR but true h264, excluded
    ]);
    const expectations = nvrHevcMainStreams(config);
    expect(expectations.map((e) => e.cameraName)).toEqual(["Front L", "Front R"]);
    for (const e of expectations) expect(e.streamName).not.toContain("-sub");
  });
});

describe("detectedVideoCodec", () => {
  it("returns the receiver video codec, skipping audio", async () => {
    const codec = await detectedVideoCodec("http://x", "front-l", (async () => streamsResponse("hevc")) as never);
    expect(codec).toBe("hevc");
  });

  it("returns undefined when no receivers materialized", async () => {
    const codec = await detectedVideoCodec("http://x", "front-l", (async () => streamsResponse(undefined)) as never);
    expect(codec).toBeUndefined();
  });
});

describe("verifyNvrCodecLocks", () => {
  const FAST = { settleMs: 1, checkTimeoutMs: 30, checkIntervalMs: 5 };
  const expectations = [
    { cameraName: "Front L", streamName: "front-l" },
    { cameraName: "Front R", streamName: "front-r" },
  ];

  it("is a no-op when everything already detects hevc", async () => {
    let restarts = 0;
    const result = await verifyNvrCodecLocks(expectations, {
      ...FAST,
      apiBaseUrl: "http://x",
      restart: async () => void restarts++,
      fetch: (async () => streamsResponse("hevc")) as never,
      log: () => {},
    });
    expect(result.healthy).toBe(true);
    expect(result.restarts).toBe(0);
    expect(restarts).toBe(0);
  });

  it("restarts go2rtc until a mislocked stream detects hevc", async () => {
    let rolls = 0;
    const result = await verifyNvrCodecLocks(expectations, {
      ...FAST,
      apiBaseUrl: "http://x",
      restart: async () => void rolls++,
      // First round: front-l mislocked; after one restart both healthy.
      fetch: (async (url: string) =>
        streamsResponse(rolls === 0 && String(url).includes("front-l") ? "h264" : "hevc")) as never,
      log: () => {},
    });
    expect(result.healthy).toBe(true);
    expect(result.restarts).toBe(1);
    expect(rolls).toBe(1);
  });

  it("gives up loudly after the restart budget", async () => {
    const lines: string[] = [];
    let rolls = 0;
    const result = await verifyNvrCodecLocks(expectations, {
      ...FAST,
      maxRestarts: 2,
      apiBaseUrl: "http://x",
      restart: async () => void rolls++,
      fetch: (async () => streamsResponse("h264")) as never,
      log: (line) => lines.push(line),
    });
    expect(result.healthy).toBe(false);
    expect(result.restarts).toBe(2);
    expect(rolls).toBe(2);
    expect(lines.some((l) => l.includes("falls back HKSV to the sub stream"))).toBe(true);
  });

  it("does not restart on unknown codec info alone (NVR offline must not loop boot)", async () => {
    let rolls = 0;
    const result = await verifyNvrCodecLocks(expectations, {
      ...FAST,
      apiBaseUrl: "http://x",
      restart: async () => void rolls++,
      fetch: (async () => streamsResponse(undefined)) as never,
      log: () => {},
    });
    expect(result.healthy).toBe(true);
    expect(rolls).toBe(0);
    expect(result.detected.get("front-l")).toBeUndefined();
  });

  it("mislockedStreams exposes only positive h264 locks (not unknowns), empty when watchdog disabled", async () => {
    const result = await verifyNvrCodecLocks(expectations, {
      ...FAST,
      maxRestarts: 0,
      apiBaseUrl: "http://x",
      restart: async () => {},
      fetch: (async (url: string) =>
        streamsResponse(String(url).includes("front-l") ? "h264" : undefined)) as never,
      log: () => {},
    });
    expect([...mislockedStreams(result)]).toEqual(["front-l"]);
    expect(mislockedStreams(undefined).size).toBe(0);
  });

  it("treats API failures as unknown, not as mislock", async () => {
    let rolls = 0;
    const result = await verifyNvrCodecLocks(expectations, {
      ...FAST,
      apiBaseUrl: "http://x",
      restart: async () => void rolls++,
      fetch: (async () => {
        throw new Error("connection refused");
      }) as never,
      log: () => {},
    });
    expect(result.healthy).toBe(true);
    expect(rolls).toBe(0);
  });
});
