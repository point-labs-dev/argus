import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import {
  createGo2RtcSupervisor,
  Go2RtcSupervisorError,
  writeGo2RtcConfigFile,
} from "../src/go2rtc-supervisor.js";
import type { Go2RtcChildProcess, Go2RtcSpawn } from "../src/go2rtc-supervisor.js";

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

class FakeChildProcess extends EventEmitter implements Go2RtcChildProcess {
  public pid = 12345;
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly kill = vi.fn((signal: NodeJS.Signals | number = "SIGTERM") => {
    this.killed = true;
    this.signalCode = typeof signal === "number" ? null : signal;
    queueMicrotask(() => this.emit("exit", this.exitCode, this.signalCode));
    return true;
  });
}

function okStreamsResponse(streams: Record<string, unknown> = { "front-door": {} }): Response {
  return new Response(JSON.stringify(streams), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function tempPath(filename: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "argus-go2rtc-supervisor-"));
  return path.join(directory, filename);
}

describe("go2rtc supervisor", () => {
  it("writes generated go2rtc config safely", async () => {
    const configPath = await tempPath("go2rtc.generated.yaml");

    const result = await writeGo2RtcConfigFile(createConfig(), configPath);
    const contents = await readFile(result.path, "utf8");

    expect(result.path).toBe(path.resolve(configPath));
    expect(result.bytes).toBe(Buffer.byteLength(contents, "utf8"));
    expect(contents).toContain("listen: 127.0.0.1:1984");
    expect(contents).toContain("front-door:");
    expect(contents.endsWith("\n")).toBe(true);
  });

  it("refuses accidental overwrite unless forced", async () => {
    const configPath = await tempPath("go2rtc.generated.yaml");
    await writeFile(configPath, "existing: true\n", "utf8");

    await expect(writeGo2RtcConfigFile(createConfig(), configPath)).rejects.toMatchObject({
      code: "CONFIG_EXISTS",
    });

    await writeGo2RtcConfigFile(createConfig(), configPath, { force: true });
    const contents = await readFile(configPath, "utf8");

    expect(contents).toContain("streams:");
    expect(contents).not.toBe("existing: true\n");
  });

  it("starts go2rtc and waits for API health", async () => {
    const child = new FakeChildProcess();
    const spawnMock = vi.fn(() => child) satisfies Go2RtcSpawn;
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("not listening yet"))
      .mockResolvedValueOnce(okStreamsResponse({ "front-door": {}, "front-door-sub": {} }));
    const configPath = await tempPath("go2rtc.generated.yaml");
    const supervisor = createGo2RtcSupervisor(createConfig(), {
      configPath,
      spawn: spawnMock,
      fetch: fetchMock as unknown as typeof fetch,
      startupTimeoutMs: 100,
      healthIntervalMs: 1,
    });

    const result = await supervisor.start();

    expect(spawnMock).toHaveBeenCalledWith("./go2rtc", ["-config", path.resolve(configPath)], {
      cwd: undefined,
      stdio: "pipe",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:1984/api/streams", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.health).toMatchObject({
      ok: true,
      streamCount: 2,
    });
    expect(result.child).toBe(child);
  });

  it("stops and cleans up the child when health times out", async () => {
    const child = new FakeChildProcess();
    const spawnMock = vi.fn(() => child) satisfies Go2RtcSpawn;
    const fetchMock = vi.fn(async () => new Response("not ready", { status: 503 }));
    const supervisor = createGo2RtcSupervisor(createConfig(), {
      configPath: await tempPath("go2rtc.generated.yaml"),
      spawn: spawnMock,
      fetch: fetchMock as unknown as typeof fetch,
      startupTimeoutMs: 5,
      healthIntervalMs: 1,
      healthRequestTimeoutMs: 1,
      shutdownTimeoutMs: 5,
    });

    await expect(supervisor.start()).rejects.toBeInstanceOf(Go2RtcSupervisorError);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.killed).toBe(true);
    expect(supervisor.process).toBeUndefined();
  });

  it("terminates the managed go2rtc child on stop", async () => {
    const child = new FakeChildProcess();
    const spawnMock = vi.fn(() => child) satisfies Go2RtcSpawn;
    const fetchMock = vi.fn(async () => okStreamsResponse());
    const supervisor = createGo2RtcSupervisor(createConfig(), {
      configPath: await tempPath("go2rtc.generated.yaml"),
      spawn: spawnMock,
      fetch: fetchMock as unknown as typeof fetch,
      shutdownTimeoutMs: 10,
    });

    await supervisor.start();
    const result = await supervisor.stop();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result).toMatchObject({
      stopped: true,
      alreadyExited: false,
      timedOut: false,
      signalCode: "SIGTERM",
    });
    expect(supervisor.process).toBeUndefined();
  });
});
