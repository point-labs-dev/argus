import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { ArgusConfig } from "./config.js";
import { generateGo2RtcYaml } from "./go2rtc.js";

export type Go2RtcSupervisorErrorCode =
  | "CONFIG_EXISTS"
  | "CONFIG_PROTECTED"
  | "HEALTH_TIMEOUT"
  | "PROCESS_EXITED"
  | "PROCESS_ERROR"
  | "ALREADY_RUNNING";

export class Go2RtcSupervisorError extends Error {
  public readonly code: Go2RtcSupervisorErrorCode;

  public constructor(code: Go2RtcSupervisorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "Go2RtcSupervisorError";
    this.code = code;
  }
}

export interface WriteGo2RtcConfigFileOptions {
  /** Overwrite an existing generated config file intentionally. Defaults to false. */
  force?: boolean;
  /** Paths that should never be overwritten, even with force (for example argus.yaml). */
  protectPaths?: readonly string[];
}

export interface WriteGo2RtcConfigFileResult {
  path: string;
  bytes: number;
}

export interface Go2RtcHealthStatus {
  ok: boolean;
  apiBaseUrl: string;
  statusCode?: number;
  streamCount?: number;
  streams?: Record<string, unknown>;
}

export interface Go2RtcHealthOptions {
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface WaitForGo2RtcHealthOptions extends Go2RtcHealthOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface Go2RtcChildProcess {
  pid?: number | undefined;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

export type Go2RtcSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; stdio?: "ignore" | "inherit" | "pipe" },
) => Go2RtcChildProcess;

export interface Go2RtcSupervisorOptions {
  configPath: string;
  forceConfigOverwrite?: boolean;
  protectConfigPaths?: readonly string[];
  binaryPath?: string;
  cwd?: string;
  apiBaseUrl?: string;
  startupTimeoutMs?: number;
  healthIntervalMs?: number;
  healthRequestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  stdio?: "ignore" | "inherit" | "pipe";
  spawn?: Go2RtcSpawn;
  fetch?: typeof fetch;
}

export interface Go2RtcStartResult {
  child: Go2RtcChildProcess;
  configPath: string;
  apiBaseUrl: string;
  health: Go2RtcHealthStatus;
}

export interface Go2RtcStopResult {
  stopped: boolean;
  alreadyExited: boolean;
  timedOut: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

function defaultApiBaseUrl(config: ArgusConfig): string {
  return `http://127.0.0.1:${config.go2rtc.api_port}`;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessExited(child: Go2RtcChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeGo2RtcConfigFile(
  config: ArgusConfig,
  configPath: string,
  options: WriteGo2RtcConfigFileOptions = {},
): Promise<WriteGo2RtcConfigFileResult> {
  const resolvedConfigPath = path.resolve(configPath);
  const protectedPaths = options.protectPaths?.map((protectedPath) => path.resolve(protectedPath)) ?? [];

  if (protectedPaths.includes(resolvedConfigPath)) {
    throw new Go2RtcSupervisorError(
      "CONFIG_PROTECTED",
      `Refusing to write go2rtc config over protected path: ${resolvedConfigPath}`,
    );
  }

  await mkdir(path.dirname(resolvedConfigPath), { recursive: true });

  const contents = ensureTrailingNewline(generateGo2RtcYaml(config));

  try {
    await writeFile(resolvedConfigPath, contents, {
      encoding: "utf8",
      flag: options.force === true ? "w" : "wx",
    });
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) {
      throw new Go2RtcSupervisorError(
        "CONFIG_EXISTS",
        `go2rtc config already exists: ${resolvedConfigPath}. Pass forceConfigOverwrite to replace it.`,
        { cause: error },
      );
    }

    throw error;
  }

  return {
    path: resolvedConfigPath,
    bytes: Buffer.byteLength(contents, "utf8"),
  };
}

export async function getGo2RtcHealth(options: Go2RtcHealthOptions): Promise<Go2RtcHealthStatus> {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? "http://127.0.0.1:1984");
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 1_000);

  try {
    const response = await fetchImpl(`${apiBaseUrl}/api/streams`, { signal: controller.signal });

    if (!response.ok) {
      return {
        ok: false,
        apiBaseUrl,
        statusCode: response.status,
      };
    }

    let streams: Record<string, unknown> | undefined;

    try {
      const body: unknown = await response.json();
      if (isRecord(body)) {
        streams = body;
      }
    } catch {
      // Health only needs a reachable go2rtc API. Some test doubles or future
      // endpoints may not return JSON, so keep a 2xx response healthy.
    }

    const status: Go2RtcHealthStatus = {
      ok: true,
      apiBaseUrl,
      statusCode: response.status,
    };

    if (streams) {
      status.streams = streams;
      status.streamCount = Object.keys(streams).length;
    }

    return status;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForGo2RtcHealth(options: WaitForGo2RtcHealthOptions): Promise<Go2RtcHealthStatus> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastError: unknown;
  let lastStatus: Go2RtcHealthStatus | undefined;

  while (Date.now() <= deadline) {
    try {
      const requestTimeoutMs = Math.max(1, Math.min(options.requestTimeoutMs ?? 1_000, deadline - Date.now()));
      const healthOptions: Go2RtcHealthOptions = { requestTimeoutMs };
      if (options.apiBaseUrl !== undefined) {
        healthOptions.apiBaseUrl = options.apiBaseUrl;
      }
      if (options.fetch !== undefined) {
        healthOptions.fetch = options.fetch;
      }

      const status = await getGo2RtcHealth(healthOptions);

      if (status.ok) {
        return status;
      }

      lastStatus = status;
    } catch (error) {
      lastError = error;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(intervalMs, remainingMs));
  }

  const detail = lastStatus ? ` Last status code: ${lastStatus.statusCode ?? "unknown"}.` : "";
  throw new Go2RtcSupervisorError(
    "HEALTH_TIMEOUT",
    `Timed out waiting ${timeoutMs}ms for go2rtc API health.${detail}`,
    { cause: lastError },
  );
}

async function terminateProcess(
  child: Go2RtcChildProcess,
  shutdownTimeoutMs: number,
): Promise<Go2RtcStopResult> {
  if (isProcessExited(child)) {
    return {
      stopped: true,
      alreadyExited: true,
      timedOut: false,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceTimeout: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceTimeout) {
        clearTimeout(forceTimeout);
      }
      child.off("exit", onExit);
      child.off("error", onError);
    };

    const finish = (result: Go2RtcStopResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(result);
    };

    const onExit = (exitCode: number | null, signalCode: NodeJS.Signals | null): void => {
      finish({
        stopped: true,
        alreadyExited: false,
        timedOut: false,
        exitCode,
        signalCode,
      });
    };

    const onError = (): void => {
      finish({
        stopped: isProcessExited(child),
        alreadyExited: false,
        timedOut: false,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      });
    };

    child.once("exit", onExit);
    child.once("error", onError);
    child.kill("SIGTERM");

    timeout = setTimeout(() => {
      if (isProcessExited(child)) {
        finish({
          stopped: true,
          alreadyExited: false,
          timedOut: false,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        });
        return;
      }

      child.kill("SIGKILL");

      forceTimeout = setTimeout(() => {
        finish({
          stopped: isProcessExited(child),
          alreadyExited: false,
          timedOut: !isProcessExited(child),
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        });
      }, Math.max(25, Math.min(1_000, shutdownTimeoutMs)));
    }, shutdownTimeoutMs);
  });
}

export class Go2RtcSupervisor {
  private child: Go2RtcChildProcess | undefined;
  private readonly apiBaseUrl: string;

  public constructor(
    private readonly config: ArgusConfig,
    private readonly options: Go2RtcSupervisorOptions,
  ) {
    this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? defaultApiBaseUrl(config));
  }

  public get process(): Go2RtcChildProcess | undefined {
    return this.child;
  }

  public async start(): Promise<Go2RtcStartResult> {
    if (this.child && !isProcessExited(this.child)) {
      throw new Go2RtcSupervisorError("ALREADY_RUNNING", "go2rtc supervisor already has a running child process.");
    }

    const writeOptions: WriteGo2RtcConfigFileOptions = {};
    if (this.options.forceConfigOverwrite !== undefined) {
      writeOptions.force = this.options.forceConfigOverwrite;
    }
    if (this.options.protectConfigPaths !== undefined) {
      writeOptions.protectPaths = this.options.protectConfigPaths;
    }

    const writeResult = await writeGo2RtcConfigFile(this.config, this.options.configPath, writeOptions);

    const spawnImpl = this.options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions));
    const spawnOptions: { cwd?: string; stdio?: "ignore" | "inherit" | "pipe" } = {
      stdio: this.options.stdio ?? "pipe",
    };
    if (this.options.cwd !== undefined) {
      spawnOptions.cwd = this.options.cwd;
    }

    const child = spawnImpl(this.options.binaryPath ?? this.config.go2rtc.binary, ["-config", writeResult.path], spawnOptions);
    this.child = child;

    let removeEarlyExitListeners: (() => void) | undefined;
    const earlyExit = new Promise<never>((_resolve, reject) => {
      const onExit = (exitCode: number | null, signalCode: NodeJS.Signals | null): void => {
        reject(
          new Go2RtcSupervisorError(
            "PROCESS_EXITED",
            `go2rtc exited before becoming healthy (exitCode=${exitCode ?? "null"}, signal=${signalCode ?? "null"}).`,
          ),
        );
      };
      const onError = (error: Error): void => {
        reject(new Go2RtcSupervisorError("PROCESS_ERROR", `go2rtc process error: ${error.message}`, { cause: error }));
      };

      child.once("exit", onExit);
      child.once("error", onError);
      removeEarlyExitListeners = () => {
        child.off("exit", onExit);
        child.off("error", onError);
      };
    });

    try {
      const waitOptions: WaitForGo2RtcHealthOptions = { apiBaseUrl: this.apiBaseUrl };
      if (this.options.fetch !== undefined) {
        waitOptions.fetch = this.options.fetch;
      }
      if (this.options.startupTimeoutMs !== undefined) {
        waitOptions.timeoutMs = this.options.startupTimeoutMs;
      }
      if (this.options.healthIntervalMs !== undefined) {
        waitOptions.intervalMs = this.options.healthIntervalMs;
      }
      if (this.options.healthRequestTimeoutMs !== undefined) {
        waitOptions.requestTimeoutMs = this.options.healthRequestTimeoutMs;
      }

      const health = await Promise.race([waitForGo2RtcHealth(waitOptions), earlyExit]);

      removeEarlyExitListeners?.();

      return {
        child,
        configPath: writeResult.path,
        apiBaseUrl: this.apiBaseUrl,
        health,
      };
    } catch (error) {
      removeEarlyExitListeners?.();
      if (!isProcessExited(child)) {
        await terminateProcess(child, this.options.shutdownTimeoutMs ?? 5_000);
      }
      this.child = undefined;
      throw error;
    }
  }

  public async health(): Promise<Go2RtcHealthStatus> {
    const options: Go2RtcHealthOptions = { apiBaseUrl: this.apiBaseUrl };
    if (this.options.fetch !== undefined) {
      options.fetch = this.options.fetch;
    }
    if (this.options.healthRequestTimeoutMs !== undefined) {
      options.requestTimeoutMs = this.options.healthRequestTimeoutMs;
    }

    return getGo2RtcHealth(options);
  }

  public async stop(): Promise<Go2RtcStopResult> {
    const child = this.child;

    if (!child) {
      return {
        stopped: false,
        alreadyExited: true,
        timedOut: false,
        exitCode: null,
        signalCode: null,
      };
    }

    const result = await terminateProcess(child, this.options.shutdownTimeoutMs ?? 5_000);
    this.child = undefined;
    return result;
  }
}

export function createGo2RtcSupervisor(config: ArgusConfig, options: Go2RtcSupervisorOptions): Go2RtcSupervisor {
  return new Go2RtcSupervisor(config, options);
}

export async function startGo2Rtc(
  config: ArgusConfig,
  options: Go2RtcSupervisorOptions,
): Promise<Go2RtcSupervisor> {
  const supervisor = createGo2RtcSupervisor(config, options);
  await supervisor.start();
  return supervisor;
}
