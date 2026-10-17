import { describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import { buildHttpFlvUrl, buildRtspUrl } from "../src/go2rtc.js";
import { MotionMonitor } from "../src/motion.js";
import { ReolinkClient, type ReolinkClientOptions } from "../src/reolink.js";

const NVR_HOST = "nvr.invalid";
const DIRECT_HOST = "direct.invalid";

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

function configWith(directAiHost?: string) {
  const camera: Record<string, unknown> = {
    name: "Front L",
    aspect: "16:9",
    host: NVR_HOST,
    channel: 2,
    mainCodec: "h265",
    username: "admin",
    password: "x",
    transport: "auto",
    streams: { main: "main", sub: "sub" },
  };
  if (directAiHost !== undefined) camera.directAiHost = directAiHost;
  return parseArgusConfig({
    cameras: [camera],
    recording: { path: "./rec", retention: { continuous: 3, motion: 7, alerts: 30 } },
    homekit: { pin: "123-45-678" },
    go2rtc: { binary: "./go2rtc", api_port: 1984 },
    server: { port: 8080 },
  });
}

function scriptedFetch(mdState: number, aiAlarm: number) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    if (url.includes("cmd=Login")) {
      return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }]);
    }
    if (url.includes("cmd=GetMdState")) {
      return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: mdState } }]);
    }
    if (url.includes("cmd=GetAiState")) {
      return jsonResponse([{
        cmd: "GetAiState",
        code: 0,
        value: { people: { alarm_state: aiAlarm, support: 1 }, vehicle: { alarm_state: 0 }, dog_cat: { alarm_state: 0 } },
      }]);
    }
    return jsonResponse([{ cmd: "?", code: 1, error: { detail: "unknown", rspCode: -99 } }]);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

async function withNoSockets<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("unexpected socket");
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function hostsOf(calls: Array<{ url: string }>, command: string): string[] {
  return calls
    .filter((call) => call.url.includes(`cmd=${command}`))
    .map((call) => {
      const match = call.url.match(/^https?:\/\/([^/]+)/);
      return match?.[1] ?? "";
    });
}

describe("direct AI poll", () => {
  it("leaves directAiHost off and keeps video on the NVR host", () => {
    const config = configWith();
    const camera = config.cameras[0]!;
    expect(camera.directAiHost).toBeUndefined();
    expect(buildRtspUrl(camera, "main")).toContain(`@${NVR_HOST}:554/`);
    expect(buildRtspUrl(camera, "main")).not.toContain(DIRECT_HOST);
    expect(buildHttpFlvUrl(camera, "sub")).toContain(`http://${NVR_HOST}/`);
    expect(buildHttpFlvUrl(camera, "sub")).not.toContain(DIRECT_HOST);
  });

  it("rejects an empty directAiHost", () => {
    expect(() => configWith("  ")).toThrow(/directAiHost/i);
  });

  it("does not construct a direct client when the field is omitted", () => {
    const hosts: string[] = [];
    const createClient = (options: ReolinkClientOptions) => {
      hosts.push(options.host);
      return new ReolinkClient({ ...options, fetch: scriptedFetch(0, 0).fetchFn });
    };
    new MotionMonitor(configWith().cameras, () => {}, { createClient });
    expect(hosts).toEqual([NVR_HOST]);
  });

  it("polls GetMdState on the NVR and GetAiState on the direct host", async () => {
    await withNoSockets(async () => {
      const { calls, fetchFn } = scriptedFetch(0, 1);
      const events: Array<[string, boolean]> = [];
      const monitor = new MotionMonitor(
        configWith(DIRECT_HOST).cameras,
        (name, detected) => events.push([name, detected]),
        { fetch: fetchFn },
      );
      await monitor.pollOnce();
      expect(events).toEqual([["Front L", true]]);
      expect(hostsOf(calls, "GetMdState")).toEqual([NVR_HOST]);
      expect(hostsOf(calls, "GetAiState")).toEqual([DIRECT_HOST]);
      const aiBody = calls.find((call) => call.url.includes("cmd=GetAiState"))?.body ?? "";
      const mdBody = calls.find((call) => call.url.includes("cmd=GetMdState"))?.body ?? "";
      expect(JSON.parse(aiBody)[0].param.channel).toBe(0);
      expect(JSON.parse(mdBody)[0].param.channel).toBe(2);
      expect(calls.some((call) => call.url.includes(DIRECT_HOST) && call.url.includes("cmd=GetMdState"))).toBe(false);
    });
  });

  it("keeps the default poll on the NVR client, including GetAiState", async () => {
    await withNoSockets(async () => {
      const { calls, fetchFn } = scriptedFetch(0, 1);
      const events: boolean[] = [];
      const monitor = new MotionMonitor(
        configWith().cameras,
        (_name, detected) => events.push(detected),
        { fetch: fetchFn },
      );
      await monitor.pollOnce();
      expect(events).toEqual([true]);
      expect(hostsOf(calls, "GetMdState")).toEqual([NVR_HOST]);
      expect(hostsOf(calls, "GetAiState")).toEqual([NVR_HOST]);
      expect(calls.some((call) => call.url.includes(DIRECT_HOST))).toBe(false);
    });
  });
});
