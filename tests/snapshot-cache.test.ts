import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import { parseJpegDimensions, SnapshotCache } from "../src/snapshot-cache.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const invalidJpeg = Buffer.from([0x6e, 0x6f, 0x70, 0x65]);

function createConfig() {
  return parseArgusConfig({
    cameras: [
      {
        name: "Front Door",
        host: "192.168.1.100",
        channel: 0,
        username: "user",
        password: "password",
        transport: "auto",
        streams: {
          main: "main",
          sub: "sub",
        },
      },
      {
        name: "Backyard Right",
        host: "192.168.1.101",
        channel: 1,
        username: "user",
        password: "password",
        transport: "auto",
        streams: {
          main: "main",
          sub: "sub",
        },
      },
    ],
    recording: {
      path: "./recordings",
      retention: {
        continuous: 3,
        motion: 7,
        alerts: 30,
      },
    },
    homekit: {
      pin: "123-45-678",
    },
    go2rtc: {
      binary: "./go2rtc",
      api_port: 1984,
    },
    server: {
      port: 8080,
    },
  });
}

function okResponse(buffer = jpeg): Response {
  return new Response(buffer);
}

describe("parseJpegDimensions", () => {
  it("reads width/height from the SOF0 frame header", () => {
    // Minimal JPEG: SOI, APP0 (JFIF stub), SOF0 declaring 896x512, EOI.
    const sof0 = Buffer.from([
      0xff, 0xc0, 0x00, 0x11, 0x08,
      0x02, 0x00, // height 512
      0x03, 0x80, // width 896
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    const jpegBuffer = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), // APP0, length 4
      sof0,
      Buffer.from([0xff, 0xd9]),
    ]);

    expect(parseJpegDimensions(jpegBuffer)).toEqual({ width: 896, height: 512 });
  });

  it("returns undefined for non-JPEG data and truncated buffers", () => {
    expect(parseJpegDimensions(Buffer.from("not a jpeg"))).toBeUndefined();
    expect(parseJpegDimensions(Buffer.from([0xff, 0xd8, 0xff]))).toBeUndefined();
  });
});

describe("SnapshotCache", () => {
  it("fetches and stores a valid JPEG snapshot with metadata", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    const cache = new SnapshotCache(createConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date("2026-04-25T21:00:00.000Z"),
    });

    const snapshot = await cache.refresh("Front Door");

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:1984/api/frame.jpeg?src=front-door-sub", undefined);
    expect(snapshot).toMatchObject({
      cameraName: "Front Door",
      profile: "sub",
      streamName: "front-door-sub",
      url: "http://127.0.0.1:1984/api/frame.jpeg?src=front-door-sub",
      capturedAt: new Date("2026-04-25T21:00:00.000Z"),
      bytes: jpeg.length,
    });
    expect(snapshot.buffer.equals(jpeg)).toBe(true);
    expect(cache.get("Front Door")).toBe(snapshot);
  });

  it("rejects non-JPEG responses and does not cache them", async () => {
    const fetchMock = vi.fn(async () => okResponse(invalidJpeg));
    const cache = new SnapshotCache(createConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(cache.refresh("Front Door")).rejects.toThrow("Invalid JPEG snapshot");
    expect(cache.get("Front Door")).toBeUndefined();
  });

  it("keeps the last good snapshot when a refresh fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(jpeg))
      .mockRejectedValueOnce(new Error("go2rtc unavailable"));
    const cache = new SnapshotCache(createConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    const firstSnapshot = await cache.refresh("Front Door");
    await expect(cache.refresh("Front Door")).rejects.toThrow("go2rtc unavailable");

    expect(cache.get("Front Door")).toBe(firstSnapshot);
  });

  it("uses sub streams by default and main streams when requested", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    const cache = new SnapshotCache(createConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    await cache.refresh("Backyard Right");
    await cache.refresh("Backyard Right", "main");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:1984/api/frame.jpeg?src=backyard-right-sub");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:1984/api/frame.jpeg?src=backyard-right");
  });

  it("can stop polling without scheduling more refreshes", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    const cache = new SnapshotCache(createConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1_000,
    });

    cache.startPolling();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await cache.stopPolling();
    const callsAfterStop = fetchMock.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchMock).toHaveBeenCalledTimes(callsAfterStop);
  });

  it("warmStream succeeds on first attempt when snapshot fetch succeeds", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    const cache = new SnapshotCache(createConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await cache.warmStream("Front Door", "sub", 3, 100);

    expect(result).toEqual({ success: true, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.get("Front Door", "sub")).toBeDefined();
  });

  it("warmStream retries on HTTP 500 and succeeds on second attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))
      .mockResolvedValueOnce(okResponse());
    const cache = new SnapshotCache(createConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    const startTime = Date.now();
    const result = await cache.warmStream("Front Door", "sub", 3, 50);
    const elapsed = Date.now() - startTime;

    expect(result).toEqual({ success: true, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Exponential backoff: first retry after 50ms * 2^0 = 50ms
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(200);
  });

  it("warmStream retries on network error and succeeds on third attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network timeout"))
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockResolvedValueOnce(okResponse());
    const cache = new SnapshotCache(createConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    const startTime = Date.now();
    const result = await cache.warmStream("Front Door", "sub", 3, 50);
    const elapsed = Date.now() - startTime;

    expect(result).toEqual({ success: true, attempts: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Exponential backoff: 50ms + 100ms = 150ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(300);
  });

  it("warmStream fails after max attempts and returns error", async () => {
    const testError = new Error("Snapshot request failed for \"Front Door\" (sub): HTTP 500.");
    const fetchMock = vi.fn(async () => new Response("Internal Server Error", { status: 500 }));
    const cache = new SnapshotCache(createConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await cache.warmStream("Front Door", "sub", 3, 50);

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error?.message).toContain("HTTP 500");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cache.get("Front Door", "sub")).toBeUndefined();
  });

  it("warmStream uses exponential backoff between retry attempts", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockRejectedValueOnce(new Error("fail 3"));
    const cache = new SnapshotCache(createConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    const startTime = Date.now();
    await cache.warmStream("Front Door", "sub", 3, 100);
    const elapsed = Date.now() - startTime;

    // Backoff: 100ms * 2^0 + 100ms * 2^1 = 100ms + 200ms = 300ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(300);
    // Add 200ms buffer for execution time
    expect(elapsed).toBeLessThan(600);
  });
});
