#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { ConfigError, loadArgusConfig } from "./config.js";
import { generateGo2RtcYaml } from "./go2rtc.js";

interface CliOptions {
  configPath: string;
  outputPath?: string;
  force: boolean;
}

class HelpRequested extends Error {
  public constructor() {
    super("help requested");
    this.name = "HelpRequested";
  }
}

function usage(): string {
  return [
    "Usage: argus [--config <path>] [--out <path>] [--force]",
    "",
    "Options:",
    "  -c, --config <path>  Argus YAML config to load (default: ./argus.yaml)",
    "  -o, --out <path>     Write generated go2rtc YAML to a file",
    "  -f, --force          Overwrite an existing output file",
    "  -h, --help           Show this help message",
  ].join("\n");
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    configPath: "argus.yaml",
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      throw new HelpRequested();
    }

    if (arg === "-f" || arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "-c" || arg === "--config") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --config.");
      }

      options.configPath = value;
      index += 1;
      continue;
    }

    if (arg === "-o" || arg === "--out") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --out.");
      }

      options.outputPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function writeOutputFile(
  outputPath: string,
  configPath: string,
  contents: string,
  force: boolean,
): Promise<void> {
  const resolvedOutputPath = path.resolve(outputPath);
  const resolvedConfigPath = path.resolve(configPath);

  if (resolvedOutputPath === resolvedConfigPath) {
    throw new Error("Refusing to overwrite the input config file.");
  }

  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });

  try {
    await writeFile(resolvedOutputPath, ensureTrailingNewline(contents), {
      encoding: "utf8",
      flag: force ? "w" : "wx",
    });
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) {
      throw new Error(`Output file already exists: ${resolvedOutputPath}. Pass --force to overwrite.`);
    }

    throw error;
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function formatError(error: unknown): string {
  if (error instanceof ConfigError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function run(argv: string[]): Promise<void> {
  const options = parseCliArgs(argv);
  const config = await loadArgusConfig(options.configPath);
  const generatedYaml = generateGo2RtcYaml(config);

  if (!options.outputPath) {
    process.stdout.write(ensureTrailingNewline(generatedYaml));
    return;
  }

  await writeOutputFile(options.outputPath, options.configPath, generatedYaml, options.force);
  process.stdout.write(`Wrote ${path.resolve(options.outputPath)}\n`);
}

async function main(): Promise<void> {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(`${usage()}\n`);
      return;
    }

    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
