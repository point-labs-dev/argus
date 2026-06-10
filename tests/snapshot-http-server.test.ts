import { Buffer } from "node:buffer";
import type { Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import { createSnapshotHttpServer } from "../src/snapshot-http-server.js";
import { SnapshotCache } from "../src/snapshot-cache.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const openServers: Server[] = [];

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

function createCache(): SnapshotCache {
  return new SnapshotCache(createConfig(), {
    fetch: vi.fn(async () => okResponse()) as unknown as typeof fetch,
    now: () => new Date("2026-04-26T20:00:00.000Z"),
  });
}

async function serve(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  openServers.push(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Snapshot HTTP server did not bind to a TCP port.");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => closeServer(server)));
});

describe("createSnapshotHttpServer", () => {
  it("serves a cached JPEG snapshot", async () => {
    const cache = createCache();
    await cache.refresh("Front Door");
    const baseUrl = await serve(createSnapshotHttpServer(cache));

    const response = await fetch(`${baseUrl}/cameras/Front%20Door/snapshot.jpg`);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe(String(jpeg.length));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-argus-captured-at")).toBe("2026-04-26T20:00:00.000Z");
    expect(body.equals(jpeg)).toBe(true);
  });

  it("URL-decodes camera names", async () => {
    const cache = createCache();
    await cache.refresh("Backyard Right");
    const baseUrl = await serve(createSnapshotHttpServer(cache));

    const response = await fetch(`${baseUrl}/cameras/${encodeURIComponent("Backyard Right")}/snapshot.jpg`);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(jpeg)).toBe(true);
  });

  it("returns 404 when no snapshot exists for the camera", async () => {
    const cache = createCache();
    const baseUrl = await serve(createSnapshotHttpServer(cache));

    const response = await fetch(`${baseUrl}/cameras/Missing/snapshot.jpg`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Snapshot not found.\n");
  });

  it("rejects unsupported methods and paths", async () => {
    const cache = createCache();
    await cache.refresh("Front Door");
    const baseUrl = await serve(createSnapshotHttpServer(cache));

    const methodResponse = await fetch(`${baseUrl}/cameras/Front%20Door/snapshot.jpg`, { method: "POST" });
    const pathResponse = await fetch(`${baseUrl}/cameras/Front%20Door/not-snapshot.jpg`);

    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET");
    expect(await methodResponse.text()).toBe("Method not allowed.\n");
    expect(pathResponse.status).toBe(404);
    expect(await pathResponse.text()).toBe("Not found.\n");
  });
});
