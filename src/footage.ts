import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import { type CameraConfig, loadArgusConfig } from "./config.js";
import { ReolinkClient, ReolinkError, type ReolinkClock } from "./reolink.js";

export type FootageRequest = {
  cmd: string;
  host: string;
  param: unknown;
};

export type FootageIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export type FootageRun = {
  exitCode: number;
  requests: FootageRequest[];
};

type ScheduleMode = "continuous" | "motion" | "off" | "mixed";

type StorageReport = { kind: "free"; megabytes: number } | { kind: "none" };

type FilePresence = { kind: "files"; count: number } | { kind: "none" };

type FootageLine = {
  camera: string;
  device: string;
  channel: number;
  schedule: ScheduleMode;
  storage: StorageReport;
  files: FilePresence;
};

type CameraWindow = {
  start: ReolinkClock;
  end: ReolinkClock;
};

type HostSession = {
  client: ReolinkClient;
  storage: () => Promise<StorageReport>;
};

type FootageQuery =
  | { kind: "shared-host"; host: string; channel: number }
  | { kind: "own-host"; host: string; channel: 0 };

const defaultIo: FootageIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

const clockPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

const hddSchema = z.object({
  HddInfo: z.array(
    z.object({
      capacity: z.number(),
      size: z.number(),
      format: z.number(),
      mount: z.number(),
    }),
  ),
});

const scheduleCellSchema = z.union([z.string(), z.array(z.number())]);

const recSchema = z.object({
  Rec: z.object({
    enable: z.number().optional(),
    scheduleEnable: z.number().optional(),
    schedule: z
      .object({
        enable: z.number().optional(),
        table: z.record(z.string(), scheduleCellSchema).optional(),
      })
      .optional(),
  }),
});

const searchSchema = z.object({
  SearchResult: z
    .object({
      File: z.array(z.unknown()).optional(),
    })
    .optional(),
});

const deviceSchema = z.object({
  Login: z.array(z.unknown()),
  GetHddInfo: z.array(z.unknown()),
  GetRec: z.record(z.string(), z.array(z.unknown())),
  Search: z.record(z.string(), z.array(z.unknown())),
});

type DeviceFixture = z.infer<typeof deviceSchema>;

function usage(): string {
  return [
    "Usage: argus-footage --config <path> --from <YYYY-MM-DDTHH:mm:ss> --to <YYYY-MM-DDTHH:mm:ss> [--fixture <dir>]",
    "",
    "Print each camera's record schedule, disk free space, and whether the window has files.",
    "A camera with no disk prints free: no storage.",
    "Exits non-zero when a camera cannot be queried.",
    "",
    "Options:",
    "  -c, --config <path>   Argus YAML config (default: ./argus.yaml)",
    "  --from <timestamp>    Window start, camera local time",
    "  --to <timestamp>      Window end, camera local time",
    "  --fixture <dir>       Read API responses from <host>.json files instead of the network",
    "  -h, --help            Show this help message",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runFootage(argv: string[], io: FootageIo = defaultIo): Promise<FootageRun> {
  const requests: FootageRequest[] = [];
  try {
    const args = parseArgs(argv);
    if (args.kind === "help") {
      io.stdout(`${usage()}\n`);
      return { exitCode: 0, requests };
    }

    const window = parseWindow(args.from, args.to);
    const config = await loadArgusConfig(args.configPath);
    const fetchFn = observeFetch(args.fixtureDir === null ? fetch : createFixtureFetch(args.fixtureDir), requests);
    const { lines, failures } = await collectFootage(config.cameras, window, fetchFn);

    if (lines.length > 0) io.stdout(`${lines.join("\n\n")}\n`);
    for (const failure of failures) io.stderr(`${failure}\n`);
    return { exitCode: failures.length === 0 ? 0 : 1, requests };
  } catch (error) {
    io.stderr(`${errorText(error)}\n`);
    return { exitCode: 1, requests };
  }
}

type ParsedArgs =
  | { kind: "help" }
  | { kind: "run"; configPath: string; fixtureDir: string | null; from: string; to: string };

function parseArgs(argv: string[]): ParsedArgs {
  let configPath = "argus.yaml";
  let fixtureDir: string | null = null;
  let from: string | null = null;
  let to: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "-c" || arg === "--config") {
      configPath = requireValue(argv, index, "--config");
      index += 1;
      continue;
    }
    if (arg === "--fixture") {
      fixtureDir = requireValue(argv, index, "--fixture");
      index += 1;
      continue;
    }
    if (arg === "--from") {
      from = requireValue(argv, index, "--from");
      index += 1;
      continue;
    }
    if (arg === "--to") {
      to = requireValue(argv, index, "--to");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg ?? ""}`);
  }

  if (from === null) throw new Error("Missing value for --from.");
  if (to === null) throw new Error("Missing value for --to.");
  return { kind: "run", configPath, fixtureDir, from, to };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) throw new Error(`Missing value for ${flag}.`);
  return value;
}

function parseWindow(from: string, to: string): CameraWindow {
  const start = parseClock(from, "--from");
  const end = parseClock(to, "--to");
  if (clockUtc(start) >= clockUtc(end)) throw new Error("--from must be earlier than --to.");
  return { start, end };
}

function parseClock(value: string, flag: string): ReolinkClock {
  const match = clockPattern.exec(value);
  if (!match) throw new Error(`${flag} must be YYYY-MM-DDTHH:mm:ss.`);
  const year = numberGroup(match, 1);
  const mon = numberGroup(match, 2);
  const day = numberGroup(match, 3);
  const hour = numberGroup(match, 4);
  const min = numberGroup(match, 5);
  const sec = numberGroup(match, 6);
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
    throw new Error(`${flag} must be YYYY-MM-DDTHH:mm:ss.`);
  }
  return { year, mon, day, hour, min, sec };
}

function numberGroup(match: RegExpExecArray, index: number): number {
  const text = match[index];
  if (text === undefined) throw new Error("Incomplete timestamp.");
  return Number(text);
}

function clockUtc(clock: ReolinkClock): number {
  return Date.UTC(clock.year, clock.mon - 1, clock.day, clock.hour, clock.min, clock.sec);
}

function footageQuery(camera: CameraConfig, cameras: readonly CameraConfig[]): FootageQuery {
  const ownHost = cameras.filter((other) => other.host === camera.host).length === 1;
  if (ownHost) return { kind: "own-host", host: camera.host, channel: 0 };
  return { kind: "shared-host", host: camera.host, channel: camera.channel };
}

async function collectFootage(
  cameras: readonly CameraConfig[],
  window: CameraWindow,
  fetchFn: typeof fetch,
): Promise<{ lines: string[]; failures: string[] }> {
  const sessions = new Map<string, HostSession>();
  const lines: string[] = [];
  const failures: string[] = [];

  for (const camera of cameras) {
    try {
      const query = footageQuery(camera, cameras);
      const session = sessionFor(camera, sessions, fetchFn);
      const storage = await session.storage();
      const schedule = scheduleMode(await session.client.getRec(query.channel));
      const files = await filesFor(session.client, query.channel, window, storage);
      lines.push(
        formatLine({
          camera: camera.name,
          device: query.host,
          channel: query.channel,
          schedule,
          storage,
          files,
        }),
      );
    } catch (error) {
      failures.push(`${camera.name}: ${errorText(error)}`);
    }
  }

  return { lines, failures };
}

function sessionFor(camera: CameraConfig, sessions: Map<string, HostSession>, fetchFn: typeof fetch): HostSession {
  const key = `${camera.host}\n${camera.username}\n${camera.password}`;
  const existing = sessions.get(key);
  if (existing) return existing;

  const client = new ReolinkClient({
    host: camera.host,
    username: camera.username,
    password: camera.password,
    fetch: fetchFn,
  });
  let storageTask: Promise<StorageReport> | null = null;
  const session: HostSession = {
    client,
    storage: () => {
      storageTask ??= readStorage(client);
      return storageTask;
    },
  };
  sessions.set(key, session);
  return session;
}

async function readStorage(client: ReolinkClient): Promise<StorageReport> {
  const parsed = hddSchema.safeParse(await client.getHddInfo());
  if (!parsed.success) throw new ReolinkError("GetHddInfo returned an unexpected payload");
  const usable = parsed.data.HddInfo.filter((disk) => disk.mount === 1 && disk.format === 1 && disk.capacity > 0);
  if (usable.length === 0) return { kind: "none" };
  const megabytes = usable.reduce((sum, disk) => sum + disk.size, 0);
  return { kind: "free", megabytes };
}

function scheduleMode(value: unknown): ScheduleMode {
  const parsed = recSchema.safeParse(value);
  if (!parsed.success) throw new ReolinkError("GetRec returned an unexpected payload");
  const rec = parsed.data.Rec;
  if (rec.schedule?.enable === 0 || rec.scheduleEnable === 0 || rec.enable === 0) return "off";

  const table = rec.schedule?.table;
  if (table === undefined) throw new ReolinkError("GetRec returned no schedule");

  const active = new Set<"continuous" | "motion" | "other">();
  for (const cell of cellsOf(table)) {
    if (cell === 0) continue;
    if (cell === 1) active.add("continuous");
    else if (cell === 2) active.add("motion");
    else active.add("other");
  }
  if (active.size === 0) return "off";
  if (active.size === 1 && active.has("continuous")) return "continuous";
  if (active.size === 1 && active.has("motion")) return "motion";
  return "mixed";
}

function cellsOf(table: Record<string, string | number[]>): number[] {
  const cells: number[] = [];
  for (const value of Object.values(table)) {
    if (typeof value === "string") {
      for (const char of value) {
        if (char >= "0" && char <= "9") cells.push(Number(char));
      }
      continue;
    }
    cells.push(...value);
  }
  return cells;
}

async function filesFor(
  client: ReolinkClient,
  channel: number,
  window: CameraWindow,
  storage: StorageReport,
): Promise<FilePresence> {
  try {
    return filesFromSearch(await client.searchRecordings(channel, window.start, window.end));
  } catch (error) {
    if (storage.kind === "none") return { kind: "none" };
    throw error;
  }
}

function filesFromSearch(value: unknown): FilePresence {
  const parsed = searchSchema.safeParse(value);
  if (!parsed.success) throw new ReolinkError("Search returned an unexpected payload");
  const files = parsed.data.SearchResult?.File;
  if (files === undefined || files.length === 0) return { kind: "none" };
  return { kind: "files", count: files.length };
}

function formatLine(line: FootageLine): string {
  const free = line.storage.kind === "none" ? "no storage" : `${line.storage.megabytes}MB`;
  const files = line.files.kind === "none" ? "no files" : String(line.files.count);
  return [
    `camera: ${line.camera}`,
    `device: ${line.device}`,
    `channel: ${line.channel}`,
    `schedule: ${line.schedule}`,
    `free: ${free}`,
    `files: ${files}`,
  ].join("\n");
}

function observeFetch(inner: typeof fetch, requests: FootageRequest[]): typeof fetch {
  return async (input, init) => {
    requests.push(readRequest(input, init));
    return inner(input, init);
  };
}

function createFixtureFetch(devicesDir: string): typeof fetch {
  return async (input, init) => {
    const request = readRequest(input, init);
    const raw: unknown = JSON.parse(await readFile(fixtureFile(devicesDir, request.host), "utf8"));
    const device = deviceSchema.parse(raw);
    const payload = payloadFor(device, request.cmd, request.param);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function fixtureFile(devicesDir: string, host: string): string {
  const root = path.resolve(devicesDir);
  const filePath = path.resolve(root, `${host}.json`);
  if (filePath !== path.join(root, `${host}.json`)) throw new Error(`Fixture host is not a file name: ${host}`);
  return filePath;
}

function payloadFor(device: DeviceFixture, cmd: string, param: unknown): unknown {
  if (cmd === "Login") return device.Login;
  if (cmd === "GetHddInfo") return device.GetHddInfo;
  if (cmd === "GetRec" || cmd === "Search") {
    const channel = commandChannel(cmd, param);
    const table = cmd === "GetRec" ? device.GetRec : device.Search;
    if (channel === null) return [{ cmd, code: 1, error: { detail: "missing channel" } }];
    const body = table[channel];
    if (body === undefined) return [{ cmd, code: 1, error: { detail: `no fixture for channel ${channel}` } }];
    return body;
  }
  return [{ cmd, code: 1, error: { detail: "unsupported command" } }];
}

function commandChannel(cmd: string, param: unknown): string | null {
  if (!isRecord(param)) return null;
  if (cmd === "GetRec" && typeof param.channel === "number") return String(param.channel);
  if (cmd === "Search" && isRecord(param.Search) && typeof param.Search.channel === "number") {
    return String(param.Search.channel);
  }
  return null;
}

function readRequest(input: RequestInfo | URL, init: RequestInit | undefined): FootageRequest {
  const url = new URL(String(input));
  let cmd = url.searchParams.get("cmd") ?? "";
  let param: unknown = {};
  if (typeof init?.body === "string") {
    const parsed: unknown = JSON.parse(init.body);
    if (Array.isArray(parsed) && isRecord(parsed[0])) {
      const first = parsed[0];
      if (typeof first.cmd === "string") cmd = first.cmd;
      if ("param" in first) param = first.param;
    }
  }
  return { cmd, host: url.hostname, param };
}
