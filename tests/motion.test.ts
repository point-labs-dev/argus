import { describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import { MotionMonitor } from "../src/motion.js";
import { ReolinkClient } from "../src/reolink.js";

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

/** Fake Reolink endpoint: Login returns a token; GetMdState returns the state the test controls. */
function fakeReolink(getState: () => number) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("cmd=Login")) {
      return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }]);
    }
    if (url.includes("cmd=GetMdState")) {
      return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: getState() } }]);
    }
    return jsonResponse([{ cmd: "?", code: 1, error: { detail: "unknown" } }]);
  }) as unknown as typeof fetch;
}

function oneCameraConfig() {
  return parseArgusConfig({
    cameras: [{ name: "Garage Door", host: "10.0.0.7", channel: 0, mainCodec: "h264",
      username: "admin", password: "x", transport: "auto", streams: { main: "main", sub: "sub" } }],
    recording: { path: "./rec", retention: { continuous: 3, motion: 7, alerts: 30 } },
    homekit: { pin: "123-45-678" },
    go2rtc: { binary: "./go2rtc", api_port: 1984 },
    server: { port: 8080 },
  });
}

describe("ReolinkClient", () => {
  it("logs in once and reports motion state from GetMdState", async () => {
    let state = 1;
    const fetchFn = fakeReolink(() => state);
    const client = new ReolinkClient({ host: "10.0.0.7", username: "admin", password: "x", fetch: fetchFn });

    expect(await client.getMotionState(0)).toBe(true);
    state = 0;
    expect(await client.getMotionState(0)).toBe(false);

    // Login should have happened once (token reused), then two GetMdState calls.
    const calls = (fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes("cmd=Login"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("cmd=GetMdState"))).toHaveLength(2);
  });

  it("re-logs in when the token is rejected (rspCode -6)", async () => {
    let firstMd = true;
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("cmd=Login")) return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }]);
      if (url.includes("cmd=GetMdState")) {
        if (firstMd) { firstMd = false; return jsonResponse([{ cmd: "GetMdState", code: 1, error: { detail: "please login first", rspCode: -6 } }]); }
        return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: 1 } }]);
      }
      return jsonResponse([{}]);
    }) as unknown as typeof fetch;
    const client = new ReolinkClient({ host: "10.0.0.7", username: "admin", password: "x", fetch: fetchFn });

    expect(await client.getMotionState(0)).toBe(true);
    const logins = (fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls.filter((c) => String(c[0]).includes("cmd=Login"));
    expect(logins.length).toBe(2); // initial + forced re-login
  });
});

describe("MotionMonitor", () => {
  it("fires motion on the rising edge and clears only after the cooldown", async () => {
    let state = 0;
    let clock = 0;
    const events: Array<[string, boolean]> = [];
    const monitor = new MotionMonitor(
      oneCameraConfig().cameras,
      (name, detected) => events.push([name, detected]),
      { fetch: fakeReolink(() => state), now: () => clock, cooldownMs: 30_000 },
    );

    await monitor.pollOnce(); // no motion
    expect(events).toEqual([]);

    state = 1;
    await monitor.pollOnce(); // rising edge
    expect(events).toEqual([["Garage Door", true]]);

    state = 0;
    clock = 10_000; // within cooldown
    await monitor.pollOnce();
    expect(events).toHaveLength(1); // still asserted

    clock = 40_000; // past cooldown
    await monitor.pollOnce();
    expect(events).toEqual([["Garage Door", true], ["Garage Door", false]]);
  });
});
