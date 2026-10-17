import { describe, expect, it, vi } from "vitest";

import { formatError } from "../src/cli.js";
import { parseArgusConfig } from "../src/config.js";
import { buildHttpFlvUrl, buildRtspUrl } from "../src/go2rtc.js";
import { MotionMonitor, writeMotionPollError } from "../src/motion.js";
import { ReolinkClient, ReolinkError, type ReolinkClientOptions } from "../src/reolink.js";

const NVR_HOST = "nvr.invalid";
const DIRECT_HOST = "direct.invalid";
const DIRECT_USER = "direct-user";
const DIRECT_PASSWORD = "direct-secret";

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
    username: DIRECT_USER,
    password: DIRECT_PASSWORD,
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
    expect(() => configWith("")).toThrow(/directAiHost/i);
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
      const directLogin = calls.find((call) => call.url.includes(DIRECT_HOST) && call.url.includes("cmd=Login"));
      expect(JSON.parse(directLogin?.body ?? "[]")[0].param.User).toEqual({
        userName: DIRECT_USER,
        password: DIRECT_PASSWORD,
      });
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
      const camera = configWith().cameras[0]!;
      expect(camera.channel).toBe(2);
      const aiBody = calls.find((call) => call.url.includes("cmd=GetAiState"))?.body ?? "";
      const mdBody = calls.find((call) => call.url.includes("cmd=GetMdState"))?.body ?? "";
      expect(JSON.parse(aiBody)[0].param.channel).toBe(camera.channel);
      expect(JSON.parse(mdBody)[0].param.channel).toBe(camera.channel);
    });
  });

  it("logs in again and retries once when GetAiState returns rspCode -6", async () => {
    await withNoSockets(async () => {
      let directLogins = 0;
      let aiCalls = 0;
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes(DIRECT_HOST) && url.includes("cmd=Login")) {
          directLogins += 1;
          return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: `direct-${directLogins}`, leaseTime: 3600 } } }]);
        }
        if (url.includes("cmd=Login")) {
          return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "nvr", leaseTime: 3600 } } }]);
        }
        if (url.includes("cmd=GetMdState")) {
          return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: 0 } }]);
        }
        if (url.includes("cmd=GetAiState")) {
          aiCalls += 1;
          if (aiCalls === 1) {
            return jsonResponse([{ cmd: "GetAiState", code: 1, error: { detail: "please login first", rspCode: -6 } }]);
          }
          return jsonResponse([{
            cmd: "GetAiState",
            code: 0,
            value: { people: { alarm_state: 1, support: 1 }, vehicle: { alarm_state: 0 }, dog_cat: { alarm_state: 0 } },
          }]);
        }
        return jsonResponse([{ cmd: "?", code: 1, error: { detail: "unknown", rspCode: -99 } }]);
      }) as unknown as typeof fetch;
      const events: boolean[] = [];
      const errors: string[] = [];
      const monitor = new MotionMonitor(
        configWith(DIRECT_HOST).cameras,
        (_name, detected) => events.push(detected),
        { fetch: fetchFn, onError: (_name, error) => errors.push(error.message) },
      );
      await monitor.pollOnce();
      expect(events).toEqual([true]);
      expect(errors).toEqual([]);
      expect(directLogins).toBe(2);
      expect(aiCalls).toBe(2);
    });
  });

  it("does not cache a transient rspCode as unsupported and recovers", async () => {
    await withNoSockets(async () => {
      let aiCalls = 0;
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("cmd=Login")) {
          return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }]);
        }
        if (url.includes("cmd=GetMdState")) {
          return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: 0 } }]);
        }
        if (url.includes("cmd=GetAiState")) {
          aiCalls += 1;
          if (aiCalls === 1) {
            return jsonResponse([{ cmd: "GetAiState", code: 1, error: { detail: "busy", rspCode: -5 } }]);
          }
          return jsonResponse([{
            cmd: "GetAiState",
            code: 0,
            value: { people: { alarm_state: 1, support: 1 }, vehicle: { alarm_state: 0 }, dog_cat: { alarm_state: 0 } },
          }]);
        }
        return jsonResponse([{ cmd: "?", code: 1, error: { detail: "unknown", rspCode: -99 } }]);
      }) as unknown as typeof fetch;
      const events: boolean[] = [];
      const errors: string[] = [];
      const monitor = new MotionMonitor(
        configWith(DIRECT_HOST).cameras,
        (_name, detected) => events.push(detected),
        { fetch: fetchFn, onError: (_name, error) => errors.push(error.message) },
      );
      await monitor.pollOnce();
      expect(events).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(aiCalls).toBe(1);
      await monitor.pollOnce();
      expect(events).toEqual([true]);
      expect(aiCalls).toBe(2);
    });
  });

  it("remembers rspCode -99 as unsupported without raising", async () => {
    await withNoSockets(async () => {
      let aiCalls = 0;
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("cmd=Login")) {
          return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }]);
        }
        if (url.includes("cmd=GetMdState")) {
          return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: 0 } }]);
        }
        if (url.includes("cmd=GetAiState")) {
          aiCalls += 1;
          return jsonResponse([{ cmd: "GetAiState", code: 1, error: { detail: "not support", rspCode: -99 } }]);
        }
        return jsonResponse([{ cmd: "?", code: 1, error: { detail: "unknown", rspCode: -99 } }]);
      }) as unknown as typeof fetch;
      const events: boolean[] = [];
      const errors: string[] = [];
      const monitor = new MotionMonitor(
        configWith(DIRECT_HOST).cameras,
        (_name, detected) => events.push(detected),
        { fetch: fetchFn, onError: (_name, error) => errors.push(error.message) },
      );
      await monitor.pollOnce();
      await monitor.pollOnce();
      expect(events).toEqual([]);
      expect(errors).toEqual([]);
      expect(aiCalls).toBe(1);
    });
  });

  it("does not let a timed-out direct host block the other cameras", async () => {
    await withNoSockets(async () => {
      const stallHost = "stall.invalid";
      const garageHost = "garage.invalid";
      let aborted = false;
      const calls: string[] = [];
      const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.includes(stallHost)) {
          await new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            const fail = (): void => {
              aborted = true;
              const reason = signal.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            };
            if (signal.aborted) fail();
            else signal.addEventListener("abort", fail, { once: true });
          });
          return jsonResponse([]);
        }
        if (url.includes("cmd=Login")) {
          return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }]);
        }
        if (url.includes("cmd=GetMdState")) {
          const state = url.includes(garageHost) ? 1 : 0;
          return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state } }]);
        }
        return jsonResponse([{ cmd: "?", code: 1, error: { detail: "unknown", rspCode: -99 } }]);
      }) as unknown as typeof fetch;
      const config = parseArgusConfig({
        cameras: [
          {
            name: "Front L",
            aspect: "16:9",
            host: NVR_HOST,
            channel: 2,
            mainCodec: "h265",
            username: DIRECT_USER,
            password: DIRECT_PASSWORD,
            transport: "auto",
            streams: { main: "main", sub: "sub" },
            directAiHost: stallHost,
          },
          {
            name: "Garage",
            aspect: "4:3",
            host: garageHost,
            channel: 0,
            mainCodec: "h264",
            username: DIRECT_USER,
            password: DIRECT_PASSWORD,
            transport: "auto",
            streams: { main: "main", sub: "sub" },
          },
        ],
        recording: { path: "./rec", retention: { continuous: 3, motion: 7, alerts: 30 } },
        homekit: { pin: "123-45-678" },
        go2rtc: { binary: "./go2rtc", api_port: 1984 },
        server: { port: 8080 },
      });
      const events: Array<[string, boolean]> = [];
      const monitor = new MotionMonitor(config.cameras, (name, detected) => events.push([name, detected]), {
        createClient: (options) => new ReolinkClient({ ...options, requestTimeoutMs: 40 }),
        fetch: fetchFn,
      });
      const started = Date.now();
      await monitor.pollOnce();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(events).toContainEqual(["Garage", true]);
      expect(calls.some((url) => url.includes(garageHost) && url.includes("cmd=GetMdState"))).toBe(true);
      expect(aborted).toBe(true);
    });
  }, 2_000);

  it("clears a direct-host error through the cooldown and backs off the log", async () => {
    await withNoSockets(async () => {
      let failDirect = false;
      let clock = 0;
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (failDirect && url.includes(DIRECT_HOST)) {
          throw new Error("direct host down");
        }
        if (url.includes("cmd=Login")) {
          return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }]);
        }
        if (url.includes("cmd=GetMdState")) {
          return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: 0 } }]);
        }
        if (url.includes("cmd=GetAiState")) {
          return jsonResponse([{
            cmd: "GetAiState",
            code: 0,
            value: { people: { alarm_state: 1, support: 1 }, vehicle: { alarm_state: 0 }, dog_cat: { alarm_state: 0 } },
          }]);
        }
        return jsonResponse([{ cmd: "?", code: 1, error: { detail: "unknown", rspCode: -99 } }]);
      }) as unknown as typeof fetch;
      const events: Array<[string, boolean]> = [];
      const errors: string[] = [];
      const monitor = new MotionMonitor(
        configWith(DIRECT_HOST).cameras,
        (name, detected) => events.push([name, detected]),
        {
          fetch: fetchFn,
          now: () => clock,
          cooldownMs: 30_000,
          onError: (_name, error) => errors.push(error.message),
        },
      );
      await monitor.pollOnce();
      expect(events).toEqual([["Front L", true]]);
      failDirect = true;
      clock = 1_000;
      await monitor.pollOnce();
      clock = 2_000;
      await monitor.pollOnce();
      clock = 3_000;
      await monitor.pollOnce();
      expect(events).toEqual([["Front L", true]]);
      expect(errors).toHaveLength(1);
      clock = 31_000;
      await monitor.pollOnce();
      expect(events).toEqual([["Front L", true], ["Front L", false]]);
    });
  });

  it("rejects a scheme, a path, userinfo, and whitespace in directAiHost", () => {
    const rejected = [
      "http://10.0.0.8",
      "https://cam.local:80",
      "10.0.0.8/cgi-bin",
      "cam.local/path",
      "admin:secret@10.0.0.8",
      "admin@10.0.0.8",
      " 10.0.0.8",
      "10.0.0.8 ",
      "10.0.0.8\t",
      "ho st.local",
    ];
    for (const host of rejected) {
      expect(() => configWith(host), host).toThrow(/directAiHost must be a host/i);
    }
    for (const host of ["10.0.0.8", "10.0.0.8:80", "cam.local", "cam.local:9000"]) {
      expect(configWith(host).cameras[0]?.directAiHost, host).toBe(host);
    }
  });

  it("does not write a credential-bearing host string to stderr", async () => {
    const secret = "s3cret-token";
    const badHost = `admin:${secret}@direct.invalid`;
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await withNoSockets(async () => {
        try {
          configWith(badHost);
        } catch (error) {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        }
        const camera = {
          ...configWith("10.0.0.8").cameras[0]!,
          directAiHost: badHost,
        };
        const fetchFn = vi.fn(async () => {
          throw new Error(`connect failed for ${badHost}`);
        }) as unknown as typeof fetch;
        const monitor = new MotionMonitor([camera], () => {}, {
          fetch: fetchFn,
          onError: writeMotionPollError,
        });
        await monitor.pollOnce();
      });
    } finally {
      spy.mockRestore();
    }
    const stderr = written.join("");
    expect(stderr).toContain("motion poll error");
    expect(stderr).not.toContain(badHost);
    expect(stderr).not.toContain(secret);
  });

  it("keeps the other camera on a 1s cadence and its motion edges while one host hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stallHost = "stall.invalid";
    const garageHost = "garage.invalid";
    const garagePolls: number[] = [];
    const events: Array<[string, boolean]> = [];
    let garageReads = 0;
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes(stallHost)) {
        return await new Promise<Response>(() => {});
      }
      if (url.includes("cmd=Login")) {
        return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }]);
      }
      if (url.includes("cmd=GetMdState")) {
        if (!url.includes(garageHost)) {
          return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: 0 } }]);
        }
        garageReads += 1;
        garagePolls.push(Date.now());
        return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: garageReads % 2 === 1 ? 1 : 0 } }]);
      }
      if (url.includes("cmd=GetAiState")) {
        return jsonResponse([{ cmd: "GetAiState", code: 1, error: { detail: "not support", rspCode: -99 } }]);
      }
      return jsonResponse([{ cmd: "?", code: 1, error: { detail: "unknown", rspCode: -99 } }]);
    }) as unknown as typeof fetch;
    const config = parseArgusConfig({
      cameras: [
        {
          name: "Front L",
          aspect: "16:9",
          host: NVR_HOST,
          channel: 2,
          mainCodec: "h265",
          username: DIRECT_USER,
          password: DIRECT_PASSWORD,
          transport: "auto",
          streams: { main: "main", sub: "sub" },
          directAiHost: stallHost,
        },
        {
          name: "Garage",
          aspect: "4:3",
          host: garageHost,
          channel: 0,
          mainCodec: "h264",
          username: DIRECT_USER,
          password: DIRECT_PASSWORD,
          transport: "auto",
          streams: { main: "main", sub: "sub" },
        },
      ],
      recording: { path: "./rec", retention: { continuous: 3, motion: 7, alerts: 30 } },
      homekit: { pin: "123-45-678" },
      go2rtc: { binary: "./go2rtc", api_port: 1984 },
      server: { port: 8080 },
    });
    const monitor = new MotionMonitor(config.cameras, (name, detected) => events.push([name, detected]), {
      fetch: fetchFn,
      pollIntervalMs: 1_000,
      cooldownMs: 0,
    });
    try {
      await withNoSockets(async () => {
        monitor.start();
        for (let second = 1; second <= 19; second += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
          for (let step = 0; step < 30; step += 1) {
            await Promise.resolve();
          }
        }
        const garageEdges = events.filter(([name]) => name === "Garage");
        expect(garagePolls).toHaveLength(19);
        expect(garagePolls[0]).toBe(1_000);
        for (let index = 1; index < garagePolls.length; index += 1) {
          expect(garagePolls[index]! - garagePolls[index - 1]!).toBe(1_000);
        }
        expect(garageEdges).toHaveLength(19);
        expect(garageEdges[0]).toEqual(["Garage", true]);
        expect(garageEdges[1]).toEqual(["Garage", false]);
        expect(garageEdges[18]).toEqual(["Garage", true]);
        expect(calls.some((url) => url.includes(stallHost))).toBe(true);
      });
    } finally {
      monitor.stop();
      vi.useRealTimers();
    }
  });

  it("clears a default-path NVR error after the cooldown and backs off the log", async () => {
    await withNoSockets(async () => {
      let clock = 0;
      let nvrDown = false;
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (nvrDown) {
          throw new Error("nvr down");
        }
        if (url.includes("cmd=Login")) {
          return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }]);
        }
        if (url.includes("cmd=GetMdState")) {
          return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: 1 } }]);
        }
        return jsonResponse([{ cmd: "?", code: 1, error: { detail: "unknown", rspCode: -99 } }]);
      }) as unknown as typeof fetch;
      const events: Array<[string, boolean]> = [];
      const errors: string[] = [];
      let clearedAt = -1;
      const monitor = new MotionMonitor(
        configWith().cameras.map((camera) => ({ ...camera, name: "Main" })),
        (name, detected) => {
          events.push([name, detected]);
          if (!detected) clearedAt = clock;
        },
        {
          fetch: fetchFn,
          now: () => clock,
          cooldownMs: 30_000,
          onError: (_name, error) => errors.push(error.message),
        },
      );
      await monitor.pollOnce();
      expect(events).toEqual([["Main", true]]);
      nvrDown = true;
      for (let t = 1_000; t <= 600_000; t += 1_000) {
        clock = t;
        await monitor.pollOnce();
      }
      expect(clearedAt).toBe(30_000);
      expect(events).toEqual([["Main", true], ["Main", false]]);
      // The old default path logged every poll: 600 lines in 10 minutes, and stayed DETECTED.
      expect(errors).toHaveLength(13);
    });
  });

  it("uses the 5s default request timeout", async () => {
    await withNoSockets(async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      try {
        let seen: AbortSignal | undefined;
        const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          seen = init?.signal ?? undefined;
          return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }]);
        }) as unknown as typeof fetch;
        const client = new ReolinkClient({
          host: NVR_HOST,
          username: DIRECT_USER,
          password: DIRECT_PASSWORD,
          fetch: fetchFn,
        });
        await client.ensureToken();
        expect(timeout).toHaveBeenCalledWith(5_000);
        expect(seen).toBe(timeout.mock.results[0]?.value);
      } finally {
        timeout.mockRestore();
      }
    });
  });

  it("backs off re-login while Login keeps failing", async () => {
    await withNoSockets(async () => {
      let clock = 0;
      let logins = 0;
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("cmd=Login")) {
          logins += 1;
          throw new Error("login refused");
        }
        throw new Error(`unexpected ${url}`);
      }) as unknown as typeof fetch;
      const monitor = new MotionMonitor(configWith().cameras, () => {}, {
        fetch: fetchFn,
        now: () => clock,
      });
      await monitor.pollOnce();
      expect(logins).toBe(1);
      clock = 1_000;
      await monitor.pollOnce();
      expect(logins).toBe(1);
      clock = 4_999;
      await monitor.pollOnce();
      expect(logins).toBe(1);
      clock = 5_000;
      await monitor.pollOnce();
      expect(logins).toBe(2);
      clock = 14_999;
      await monitor.pollOnce();
      expect(logins).toBe(2);
      clock = 15_000;
      await monitor.pollOnce();
      expect(logins).toBe(3);
    });
  });

  it("rejects an IPv6 directAiHost", () => {
    for (const host of ["::1", "[::1]", "[::1]:80", "fe80::1", "[fe80::1]:80"]) {
      expect(() => configWith(host), host).toThrow(/IPv6 is unsupported/i);
    }
  });

  it("redacts URL userinfo in ReolinkError and keeps an email", async () => {
    await withNoSockets(async () => {
      const sample = credentialSample();
      const fetchFn = vi.fn(async () => {
        throw new Error(sample);
      }) as unknown as typeof fetch;
      const client = new ReolinkClient({
        host: NVR_HOST,
        username: DIRECT_USER,
        password: DIRECT_PASSWORD,
        fetch: fetchFn,
      });
      let caught: unknown;
      try {
        await client.ensureToken();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ReolinkError);
      expectUserinfoRedacted(caught instanceof Error ? caught.message : String(caught));
    });
  });

  it("redacts URL userinfo in writeMotionPollError and keeps an email", () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      writeMotionPollError("Front L", new Error(credentialSample()));
    } finally {
      spy.mockRestore();
    }
    const stderr = written.join("");
    expect(stderr).toContain("motion poll error");
    expectUserinfoRedacted(stderr);
  });

  it("redacts URL userinfo in formatError and keeps an email", () => {
    expectUserinfoRedacted(formatError(new Error(credentialSample())));
    expectUserinfoRedacted(formatError(credentialSample()));
  });
});

const REDACTION_SECRET = "s3cret-token";
const REDACTION_EMAIL = "owner@example.com";

function credentialSample(): string {
  return `connect failed for http://admin:${REDACTION_SECRET}@direct.invalid/cgi-bin/api.cgi admin:${REDACTION_SECRET}@direct.invalid ${REDACTION_EMAIL} x@y`;
}

function expectUserinfoRedacted(text: string): void {
  expect(text).not.toContain(REDACTION_SECRET);
  expect(text).not.toContain(`admin:${REDACTION_SECRET}@`);
  expect(text).toContain("http://direct.invalid/cgi-bin/api.cgi");
  expect(text).toContain(REDACTION_EMAIL);
  expect(text).toContain("x@y");
}
