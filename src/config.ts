import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const transportSchema = z.enum(["auto", "http-flv", "rtsp"]);

const streamProfilesSchema = z.object({
  main: z.string().trim().min(1, "cameras[].streams.main is required"),
  sub: z.string().trim().min(1, "cameras[].streams.sub is required"),
});

const cameraSchema = z.object({
  name: z.string().trim().min(1, "cameras[].name is required"),
  host: z.string().trim().min(1, "cameras[].host is required"),
  channel: z
    .number()
    .int("cameras[].channel must be an integer")
    .nonnegative("cameras[].channel must be zero or greater"),
  username: z.string().min(1, "cameras[].username is required"),
  password: z.string().min(1, "cameras[].password is required"),
  transport: transportSchema,
  streams: streamProfilesSchema,
});

const retentionSchema = z.object({
  continuous: z
    .number()
    .int("recording.retention.continuous must be an integer")
    .nonnegative("recording.retention.continuous must be zero or greater"),
  motion: z
    .number()
    .int("recording.retention.motion must be an integer")
    .nonnegative("recording.retention.motion must be zero or greater"),
  alerts: z
    .number()
    .int("recording.retention.alerts must be an integer")
    .nonnegative("recording.retention.alerts must be zero or greater"),
});

const argusConfigSchema = z.object({
  cameras: z.array(cameraSchema).min(1, "at least one camera is required"),
  recording: z.object({
    path: z.string().trim().min(1, "recording.path is required"),
    retention: retentionSchema,
  }),
  homekit: z.object({
    pin: z.string().regex(/^\d{3}-\d{2}-\d{3}$/, "homekit.pin must match XXX-XX-XXX"),
  }),
  go2rtc: z.object({
    binary: z.string().trim().min(1, "go2rtc.binary is required"),
    api_port: z
      .number()
      .int("go2rtc.api_port must be an integer")
      .min(1, "go2rtc.api_port must be between 1 and 65535")
      .max(65535, "go2rtc.api_port must be between 1 and 65535"),
  }),
  server: z.object({
    port: z
      .number()
      .int("server.port must be an integer")
      .min(1, "server.port must be between 1 and 65535")
      .max(65535, "server.port must be between 1 and 65535"),
  }),
});

export type CameraTransport = z.infer<typeof transportSchema>;
export type ArgusConfig = z.infer<typeof argusConfigSchema>;
export type CameraConfig = ArgusConfig["cameras"][number];

export class ConfigError extends Error {
  public readonly issues: string[];

  public constructor(message: string, issues: string[] = []) {
    super(issues.length === 0 ? message : [message, ...issues.map((issue) => `- ${issue}`)].join("\n"));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function parseArgusConfig(raw: unknown): ArgusConfig {
  const parsed = argusConfigSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    });

    throw new ConfigError("Invalid Argus config.", issues);
  }

  return parsed.data;
}

export async function loadArgusConfig(configPath: string): Promise<ArgusConfig> {
  let fileContents: string;

  try {
    fileContents = await readFile(configPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Unable to read config at ${configPath}: ${message}`);
  }

  let rawConfig: unknown;

  try {
    rawConfig = parseYaml(fileContents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Unable to parse YAML at ${configPath}: ${message}`);
  }

  return parseArgusConfig(rawConfig);
}
