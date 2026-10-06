import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { constants } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { parseArgusConfig, type ArgusConfig } from "../src/config.js";
import { generateGo2RtcYaml } from "../src/go2rtc.js";
import {
  createGo2RtcSupervisor,
  writeGo2RtcConfigFile,
  type Go2RtcChildProcess,
  type Go2RtcSpawn,
} from "../src/go2rtc-supervisor.js";
import { SnapshotCache } from "../src/snapshot-cache.js";

const CAMERA_PASSWORD = "fixture-camera-secret";
const GO2RTC_BIN = process.env.GO2RTC_BIN ?? "/tmp/argus-go2rtc/go2rtc";

function createConfig(apiPort: number): ArgusConfig {
  return parseArgusConfig({
    cameras: [
      {
        name: "Front Door",
        host: "192.0.2.1",
        channel: 0,
        username: "fixture-user",
        password: CAMERA_PASSWORD,
        transport: "rtsp",
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
      binary: GO2RTC_BIN,
      api_port: apiPort,
    },
    server: {
      port: 8080,
    },
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function listenHost(port: number, tcpTable: string): string | undefined {
  const hexPort = port.toString(16).padStart(4, "0").toUpperCase();
  for (const line of tcpTable.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const local = parts[1];
    const state = parts[3];
    if (!local || state !== "0A") {
      continue;
    }
    const [ipHex, portHex] = local.split(":");
    if (!ipHex || portHex?.toUpperCase() !== hexPort) {
      continue;
    }
    const value = Number.parseInt(ipHex, 16);
    return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff].join(".");
  }
  return undefined;
}

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "argus-go2rtc-api-"));
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

describe("go2rtc API credentials", () => {
  it("does not return a camera password to an unauthenticated caller, and listens on loopback", async () => {
    await access(GO2RTC_BIN, constants.X_OK);
    const port = await freePort();
    const directory = await tempDirectory();
    const configPath = path.join(directory, "go2rtc.yaml");
    const yaml = generateGo2RtcYaml(createConfig(port));
    await writeFile(configPath, yaml.endsWith("\n") ? yaml : `${yaml}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(configPath, 0o600);

    const child: ChildProcess = spawn(GO2RTC_BIN, ["-config", configPath], { stdio: "ignore" });
    try {
      const started = Date.now();
      let host: string | undefined;
      while (Date.now() - started < 5_000) {
        if (child.exitCode !== null) {
          throw new Error(`go2rtc exited before listening (code ${child.exitCode}).`);
        }
        host = listenHost(port, await readFile("/proc/net/tcp", "utf8"));
        if (host) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }

      expect(host).toBe("127.0.0.1");

      const response = await fetch(`http://127.0.0.1:${port}/api/streams`);
      const body = await response.text();
      expect(response.status).toBe(401);
      expect(body.includes(CAMERA_PASSWORD)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 15_000);

  it("writes the generated go2rtc config so other users cannot read source URLs", async () => {
    const directory = await tempDirectory();
    const configPath = path.join(directory, "go2rtc.generated.yaml");
    await writeGo2RtcConfigFile(createConfig(1984), configPath);
    const info = await stat(configPath);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("sends the generated API credentials on the health check", async () => {
    const child = new FakeChildProcess();
    const spawnMock = vi.fn(() => child) satisfies Go2RtcSpawn;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ "front-door": {} }), { status: 200 }));
    const directory = await tempDirectory();
    const configPath = path.join(directory, "go2rtc.generated.yaml");
    const supervisor = createGo2RtcSupervisor(createConfig(1984), {
      configPath,
      spawn: spawnMock,
      fetch: fetchMock as unknown as typeof fetch,
      startupTimeoutMs: 100,
      healthIntervalMs: 1,
    });

    await supervisor.start();

    const parsed: unknown = parseYaml(await readFile(configPath, "utf8"));
    const api =
      parsed && typeof parsed === "object" && "api" in parsed
        ? (parsed as { api?: { username?: unknown; password?: unknown; local_auth?: unknown } }).api
        : undefined;
    expect(typeof api?.username).toBe("string");
    expect(typeof api?.password).toBe("string");
    expect(api?.local_auth).toBe(true);

    const username = api?.username;
    const password = api?.password;
    const expected = `Basic ${Buffer.from(`${String(username)}:${String(password)}`).toString("base64")}`;
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("authorization")).toBe(expected);
  });

  it("sends API credentials when Argus fetches a snapshot", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const fetchMock = vi.fn(async () => new Response(jpeg));
    const cache = new SnapshotCache(createConfig(1984), {
      fetch: fetchMock as unknown as typeof fetch,
      apiCredentials: { username: "argus", password: "fixture-api-secret" },
    });

    await cache.refresh("Front Door", "sub");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const expected = `Basic ${Buffer.from("argus:fixture-api-secret").toString("base64")}`;
    expect(new Headers(init?.headers).get("authorization")).toBe(expected);
  });
});
