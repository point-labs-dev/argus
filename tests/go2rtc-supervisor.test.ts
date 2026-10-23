import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { parseArgusConfig } from "../src/config.js";
import {
  createGo2RtcSupervisor,
  getGo2RtcHealth,
  Go2RtcSupervisorError,
  writeGo2RtcConfigFile,
} from "../src/go2rtc-supervisor.js";
import type { Go2RtcChildProcess, Go2RtcSpawn, Go2RtcSupervisor } from "../src/go2rtc-supervisor.js";
import { redactCredentialHosts, redactKnownSecrets } from "../src/reolink.js";

function createConfig(password = "password") {
  return parseArgusConfig({
    cameras: [
      {
        name: "Front Door",
        aspect: "16:9",
        host: "192.168.1.100",
        channel: 0,
        username: "user",
        password,
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

class LogChild extends EventEmitter implements Go2RtcChildProcess {
  public pid = 4242;
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly kill = vi.fn((signal: NodeJS.Signals | number = "SIGTERM") => {
    this.killed = true;
    this.signalCode = typeof signal === "number" ? null : signal;
    queueMicrotask(() => this.emit("exit", this.exitCode, this.signalCode));
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readApiPassword(configPath: string): string {
  const parsed: unknown = parseYaml(readFileSync(configPath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.api) || typeof parsed.api.password !== "string") {
    throw new Error("go2rtc config has no api password");
  }
  return parsed.api.password;
}

function go2rtcLines(logged: readonly string[]): string[] {
  return logged.filter((line) => line.startsWith("[argus] go2rtc:"));
}

async function waitForLogged(logged: readonly string[], fragment: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!logged.some((line) => line.includes(fragment))) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${fragment}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function okStreamsResponse(
  streams: Record<string, unknown> = { "front-door": {}, "front-door-sub": {} },
): Response {
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

const GO2RTC_LOG_ACCEPTANCE = [
  "serve.ts starts go2rtc with stdio pipe and does not use ignore.",
  "stdout and stderr are read line by line so an unread pipe cannot fill and block go2rtc.",
  "each line passes through redactKnownSecrets and redactCredentialHosts before the Argus error log writes [argus] go2rtc:.",
  "the camera password list is captured before the go2rtc child is spawned.",
  "health() with no expected stream count stays ok when /api/streams returns {}.",
  "startup with the generated stream count still fails on {} with HEALTH_TIMEOUT and stops the child.",
  "firmware revision stays 1.3.16 and the census verdict stays unchanged.",
].join("\n");

const GO2RTC_LOG_HOME_MANAGER_CHECK = `set -u
LABEL="dev.point-labs.argus"
AGENT="$HOME/Library/LaunchAgents/\${LABEL}.plist"
DAEMON="/Library/LaunchDaemons/\${LABEL}.plist"
PLIST=""
if [[ -f "$AGENT" ]]; then
  PLIST="$AGENT"
elif [[ -f "$DAEMON" ]]; then
  PLIST="$DAEMON"
fi
ERR=""
WD=""
if [[ -n "$PLIST" ]]; then
  ERR="$(plutil -extract StandardErrorPath raw -o - "$PLIST" 2>/dev/null || true)"
  WD="$(plutil -extract WorkingDirectory raw -o - "$PLIST" 2>/dev/null || true)"
fi
if [[ -z "$ERR" && -n "$WD" ]]; then
  ERR="\${WD}/logs/serve.err.log"
fi
if [[ -z "$ERR" || ! -f "$ERR" ]]; then
  printf '%s\\n' 'go2rtc_log_lines=missing' 'go2rtc_userinfo_lines=missing'
  exit 0
fi
lines="$(grep -c '\\[argus\\] go2rtc: ' "$ERR" || true)"
userinfo="$(grep '\\[argus\\] go2rtc: ' "$ERR" | grep -cE '://[^[:space:]]+:[^[:space:]@]+@' || true)"
printf '%s\\n' "go2rtc_log_lines=\${lines}" "go2rtc_userinfo_lines=\${userinfo}"
`;

describe("go2rtc supervisor", () => {
  it("records the go2rtc log acceptance criteria", () => {
    expect(GO2RTC_LOG_ACCEPTANCE).toContain("stdio pipe");
    expect(GO2RTC_LOG_ACCEPTANCE).toContain("redactKnownSecrets");
    expect(GO2RTC_LOG_ACCEPTANCE).toContain("redactCredentialHosts");
    expect(GO2RTC_LOG_ACCEPTANCE).toContain("health() with no expected stream count stays ok");
    expect(GO2RTC_LOG_ACCEPTANCE).toContain("HEALTH_TIMEOUT");
    expect(GO2RTC_LOG_ACCEPTANCE).toContain("1.3.16");
    expect(GO2RTC_LOG_HOME_MANAGER_CHECK).toContain("go2rtc_log_lines=");
    expect(GO2RTC_LOG_HOME_MANAGER_CHECK).toContain("go2rtc_userinfo_lines=");
    expect(GO2RTC_LOG_HOME_MANAGER_CHECK).not.toMatch(/\blaunchctl\s+(?:load|unload|kickstart|bootstrap|bootout)\b/);
    expect(GO2RTC_LOG_HOME_MANAGER_CHECK).not.toMatch(/\b(?:kickstart|bootstrap|bootout|reboot|kill)\b/);
    expect(GO2RTC_LOG_HOME_MANAGER_CHECK).not.toMatch(/\b(?:cat|tail|echo)\b/);
  });

  it("writes generated go2rtc config safely", async () => {
    const configPath = await tempPath("go2rtc.generated.yaml");

    const result = await writeGo2RtcConfigFile(createConfig(), configPath);
    const contents = await readFile(result.path, "utf8");

    expect(result.path).toBe(path.resolve(configPath));
    expect(result.bytes).toBe(Buffer.byteLength(contents, "utf8"));
    expect(contents).toContain("listen: 127.0.0.1:1984");
    expect(contents).toContain("front-door:");
    expect(contents).toContain("front-door-sub:");
    expect(result.streamCount).toBe(2);
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

  it("treats a 2xx response with no JSON stream list as unhealthy", async () => {
    const health = await getGo2RtcHealth({
      fetch: vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch,
    });

    expect(health).toEqual({
      ok: false,
      apiBaseUrl: "http://127.0.0.1:1984",
      statusCode: 200,
    });
  });

  it("treats a 2xx JSON value that is not a stream object as unhealthy", async () => {
    const health = await getGo2RtcHealth({
      fetch: vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });

    expect(health).toEqual({
      ok: false,
      apiBaseUrl: "http://127.0.0.1:1984",
      statusCode: 200,
    });
  });

  it("rejects a stream list shorter than the generated config", async () => {
    const health = await getGo2RtcHealth({
      fetch: vi.fn(async () => okStreamsResponse({})) as unknown as typeof fetch,
      expectedStreamCount: 2,
    });

    expect(health).toEqual({
      ok: false,
      apiBaseUrl: "http://127.0.0.1:1984",
      statusCode: 200,
      streamCount: 0,
      streams: {},
    });
  });

  it("accepts a stream list whose count matches the generated config", async () => {
    const streams = { "front-door": {}, "front-door-sub": {} };
    const health = await getGo2RtcHealth({
      fetch: vi.fn(async () => okStreamsResponse(streams)) as unknown as typeof fetch,
      expectedStreamCount: 2,
    });

    expect(health).toEqual({
      ok: true,
      apiBaseUrl: "http://127.0.0.1:1984",
      statusCode: 200,
      streamCount: 2,
      streams,
    });
  });

  it("fails startup when go2rtc returns 2xx without a JSON stream list", async () => {
    const child = new FakeChildProcess();
    const supervisor = createGo2RtcSupervisor(createConfig(), {
      configPath: await tempPath("go2rtc.generated.yaml"),
      spawn: vi.fn(() => child) satisfies Go2RtcSpawn,
      fetch: vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch,
      startupTimeoutMs: 20,
      healthIntervalMs: 1,
      healthRequestTimeoutMs: 20,
      shutdownTimeoutMs: 20,
    });

    await expect(supervisor.start()).rejects.toMatchObject({
      code: "HEALTH_TIMEOUT",
      message: expect.stringContaining("No stream list."),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.process).toBeUndefined();
  });

  it("fails startup when go2rtc lists fewer streams than the generated config", async () => {
    const child = new FakeChildProcess();
    const supervisor = createGo2RtcSupervisor(createConfig(), {
      configPath: await tempPath("go2rtc.generated.yaml"),
      spawn: vi.fn(() => child) satisfies Go2RtcSpawn,
      fetch: vi.fn(async () => okStreamsResponse({})) as unknown as typeof fetch,
      startupTimeoutMs: 20,
      healthIntervalMs: 1,
      healthRequestTimeoutMs: 20,
      shutdownTimeoutMs: 20,
    });

    await expect(supervisor.start()).rejects.toMatchObject({
      code: "HEALTH_TIMEOUT",
      message: expect.stringContaining("Stream count 0 is below expected 2."),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.process).toBeUndefined();
  });

  it("keeps health() ok on {} when no stream count is expected, and startup still fails on {}", async () => {
    const open = await getGo2RtcHealth({
      fetch: vi.fn(async () => okStreamsResponse({})) as unknown as typeof fetch,
    });

    expect(open).toEqual({
      ok: true,
      apiBaseUrl: "http://127.0.0.1:1984",
      statusCode: 200,
      streamCount: 0,
      streams: {},
    });

    let streams: Record<string, unknown> = { "front-door": {}, "front-door-sub": {} };
    const child = new FakeChildProcess();
    const supervisor = createGo2RtcSupervisor(createConfig(), {
      configPath: await tempPath("go2rtc.generated.yaml"),
      spawn: vi.fn(() => child) satisfies Go2RtcSpawn,
      fetch: vi.fn(async () => okStreamsResponse(streams)) as unknown as typeof fetch,
      startupTimeoutMs: 100,
      healthIntervalMs: 1,
    });
    try {
      await supervisor.start();
      streams = {};
      await expect(supervisor.health()).resolves.toEqual({
        ok: true,
        apiBaseUrl: "http://127.0.0.1:1984",
        statusCode: 200,
        streamCount: 0,
        streams: {},
      });
    } finally {
      await supervisor.stop();
    }

    const startupChild = new FakeChildProcess();
    const startup = createGo2RtcSupervisor(createConfig(), {
      configPath: await tempPath("go2rtc.generated.yaml"),
      spawn: vi.fn(() => startupChild) satisfies Go2RtcSpawn,
      fetch: vi.fn(async () => okStreamsResponse({})) as unknown as typeof fetch,
      startupTimeoutMs: 20,
      healthIntervalMs: 1,
      healthRequestTimeoutMs: 20,
      shutdownTimeoutMs: 20,
    });

    await expect(startup.start()).rejects.toMatchObject({
      code: "HEALTH_TIMEOUT",
      message: expect.stringContaining("Stream count 0 is below expected 2."),
    });
    expect(startupChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(startup.process).toBeUndefined();
  });

  it("reads both go2rtc pipes line by line and redacts them into the Argus log", async () => {
    const password = "fixture-camera-secret";
    const repeats = 1000;
    const stdoutRaw = `stdout-marker dial rtsp://fixture-user:${password}@192.0.2.10:554/h264Preview_01_main token ${password}`;
    const stderrRaw = `stderr-marker dial rtsp://fixture-user:${password}@192.0.2.10:554/h264Preview_01_main token ${password}`;
    const stdoutWant = `[argus] go2rtc: ${redactCredentialHosts(redactKnownSecrets(stdoutRaw, [password]))}\n`;
    const stderrWant = `[argus] go2rtc: ${redactCredentialHosts(redactKnownSecrets(stderrRaw, [password]))}\n`;
    const directory = await mkdtemp(path.join(tmpdir(), "argus-go2rtc-logs-"));
    const scriptPath = path.join(directory, "go2rtc-log.mjs");
    const script = `#!/usr/bin/env node
const stdoutLine = ${JSON.stringify(`${stdoutRaw}\n`)};
const stderrLine = ${JSON.stringify(`${stderrRaw}\n`)};
const repeats = ${repeats};
function writeLines(stream, line) {
  let left = repeats;
  const write = () => {
    let ok = true;
    while (left > 0 && ok) {
      ok = stream.write(line);
      left -= 1;
    }
    if (left > 0) stream.once("drain", write);
  };
  write();
}
writeLines(process.stdout, stdoutLine);
writeLines(process.stderr, stderrLine);
setInterval(() => {}, 1000000);
`;
    await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o755 });
    await chmod(scriptPath, 0o755);

    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    let supervisor: Go2RtcSupervisor | undefined;
    try {
      supervisor = createGo2RtcSupervisor(createConfig(password), {
        configPath: path.join(directory, "go2rtc.generated.yaml"),
        binaryPath: scriptPath,
        fetch: vi.fn(async () => okStreamsResponse()) as unknown as typeof fetch,
        startupTimeoutMs: 1_000,
        healthIntervalMs: 1,
        shutdownTimeoutMs: 500,
      });
      await supervisor.start();
      const deadline = Date.now() + 4_000;
      while (logged.length < repeats * 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(logged).toHaveLength(repeats * 2);
      expect(logged.filter((line) => line === stdoutWant)).toHaveLength(repeats);
      expect(logged.filter((line) => line === stderrWant)).toHaveLength(repeats);
      expect(logged.join("").includes(password)).toBe(false);
      expect(stdoutWant.includes(password)).toBe(false);
      expect(stderrWant.includes("rtsp://fixture-user:")).toBe(false);
      expect(stdoutWant).toBe(
        "[argus] go2rtc: stdout-marker dial rtsp://192.0.2.10:554/h264Preview_01_main token ***\n",
      );
    } finally {
      spy.mockRestore();
      await supervisor?.stop();
    }
  }, 15_000);

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

  it("redacts the go2rtc API password from the list passed to redaction", async () => {
    const cameraPassword = "fixture-camera-secret";
    const child = new LogChild();
    let apiPassword = "";
    const spawnMock = vi.fn((_command: string, args: readonly string[]) => {
      const configPath = args[args.indexOf("-config") + 1];
      if (configPath === undefined) {
        throw new Error("spawn was not given a go2rtc config path");
      }
      apiPassword = readApiPassword(configPath);
      child.stdout.write(`api-password ${apiPassword} loaded\n`);
      return child;
    }) satisfies Go2RtcSpawn;
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    let supervisor: Go2RtcSupervisor | undefined;
    try {
      supervisor = createGo2RtcSupervisor(createConfig(cameraPassword), {
        configPath: await tempPath("go2rtc.generated.yaml"),
        spawn: spawnMock,
        fetch: vi.fn(async () => okStreamsResponse()) as unknown as typeof fetch,
        startupTimeoutMs: 100,
        healthIntervalMs: 1,
      });
      await supervisor.start();
      await waitForLogged(logged, "api-password");
      expect(apiPassword).toBe(supervisor.apiCredentials.password);
      expect(apiPassword).not.toBe(cameraPassword);
      expect(apiPassword.length).toBeGreaterThanOrEqual(16);
      expect(logged).toEqual(["[argus] go2rtc: api-password *** loaded\n"]);
      expect(logged.join("")).not.toContain(apiPassword);
    } finally {
      spy.mockRestore();
      await supervisor?.stop();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  it("closes the log reader on stop and on a start failure", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    const children: LogChild[] = [];
    let releaseHealth: (() => void) | undefined;
    let failedStart: Promise<unknown> | undefined;
    try {
      const stopChild = new LogChild();
      children.push(stopChild);
      const stopSupervisor = createGo2RtcSupervisor(createConfig(), {
        configPath: await tempPath("go2rtc.generated.yaml"),
        spawn: vi.fn(() => stopChild) satisfies Go2RtcSpawn,
        fetch: vi.fn(async () => okStreamsResponse()) as unknown as typeof fetch,
        startupTimeoutMs: 100,
        healthIntervalMs: 1,
        shutdownTimeoutMs: 20,
      });
      await stopSupervisor.start();
      stopChild.stdout.write("stdout-while-open\n");
      await waitForLogged(logged, "stdout-while-open");
      stopChild.stderr.write("stderr-while-open\n");
      await waitForLogged(logged, "stderr-while-open");
      expect(go2rtcLines(logged)).toEqual([
        "[argus] go2rtc: stdout-while-open\n",
        "[argus] go2rtc: stderr-while-open\n",
      ]);
      await stopSupervisor.stop();
      stopChild.stdout.write("stdout-after-stop\n");
      stopChild.stderr.write("stderr-after-stop\n");
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(go2rtcLines(logged)).toEqual([
        "[argus] go2rtc: stdout-while-open\n",
        "[argus] go2rtc: stderr-while-open\n",
      ]);

      logged.length = 0;
      const failChild = new LogChild();
      children.push(failChild);
      const healthGate = new Promise<void>((resolve) => {
        releaseHealth = resolve;
      });
      const failSupervisor = createGo2RtcSupervisor(createConfig(), {
        configPath: await tempPath("go2rtc.generated.yaml"),
        spawn: vi.fn(() => failChild) satisfies Go2RtcSpawn,
        fetch: vi.fn(async () => {
          await healthGate;
          return new Response("not ready", { status: 503 });
        }) as unknown as typeof fetch,
        startupTimeoutMs: 100,
        healthIntervalMs: 1,
        healthRequestTimeoutMs: 50,
        shutdownTimeoutMs: 20,
      });
      failedStart = failSupervisor.start();
      failChild.stdout.write("stdout-while-starting\n");
      await waitForLogged(logged, "stdout-while-starting");
      failChild.stderr.write("stderr-while-starting\n");
      await waitForLogged(logged, "stderr-while-starting");
      expect(go2rtcLines(logged)).toEqual([
        "[argus] go2rtc: stdout-while-starting\n",
        "[argus] go2rtc: stderr-while-starting\n",
      ]);
      releaseHealth?.();
      releaseHealth = undefined;
      await expect(failedStart).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
      failedStart = undefined;
      failChild.stdout.write("stdout-after-failure\n");
      failChild.stderr.write("stderr-after-failure\n");
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(go2rtcLines(logged)).toEqual([
        "[argus] go2rtc: stdout-while-starting\n",
        "[argus] go2rtc: stderr-while-starting\n",
      ]);
    } finally {
      releaseHealth?.();
      await failedStart?.catch(() => undefined);
      spy.mockRestore();
      for (const child of children) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }
  });
});
