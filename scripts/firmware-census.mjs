import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const AD_KEYS = [
  "profiles:",
  "levels:",
  "H264Profile",
  "H264Level",
  "resolutions",
  "AAC_ELD",
  "OPUS",
  "samplerate",
  "cameraStreamCount",
  "wifiSet",
  "hiresSet",
  "compatSet",
  "fourByThree",
  "[854",
  "[1280",
  "[1920",
  "[640",
  "[480",
  "[320",
];

export function firmwareRevision(src) {
  const match = src.match(/export const ARGUS_FIRMWARE_REVISION = "([^"]+)"/);
  return match ? match[1] : null;
}

export function advertisement(src) {
  const start = src.indexOf("export function buildCameraControllerOptions");
  if (start < 0) {
    return "";
  }
  const next = src.indexOf("\nexport ", start + 30);
  let body = next < 0 ? src.slice(start) : src.slice(start, next);
  body = body.replace(/\/\*[\s\S]*?\*\//g, "");
  body = body.replace(/\/\/.*$/gm, "");
  const lines = [];
  for (const line of body.split("\n")) {
    const compact = line.trim().replace(/\s+/g, " ");
    if (AD_KEYS.some((key) => compact.includes(key))) {
      lines.push(compact);
    }
  }
  return lines.join("\n");
}

export function classifyFirmwareChange(before, after) {
  const beforeFirmware = firmwareRevision(before);
  const afterFirmware = firmwareRevision(after);
  const sameAdvertisement = advertisement(before) === advertisement(after);
  let verdict = "justified";
  if (beforeFirmware === afterFirmware) {
    verdict = "unchanged";
  } else if (sameAdvertisement) {
    verdict = "churn";
  }
  return { verdict, beforeFirmware, afterFirmware };
}

function gitShow(spec) {
  return execFileSync("git", ["show", spec], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseArgs(argv) {
  const args = { before: null, after: null, commit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--before" || flag === "--after" || flag === "--commit") {
      if (value === undefined) {
        throw new Error(`${flag} needs a value`);
      }
      args[flag.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return args;
}

function pair(args) {
  if (args.before !== null || args.after !== null) {
    if (args.before === null || args.after === null) {
      throw new Error("--before and --after are a pair");
    }
    return [readFileSync(args.before, "utf8"), readFileSync(args.after, "utf8")];
  }
  if (args.commit !== null) {
    const parent = execFileSync("git", ["rev-parse", `${args.commit}^`], {
      encoding: "utf8",
    }).trim();
    return [gitShow(`${parent}:src/homekit.ts`), gitShow(`${args.commit}:src/homekit.ts`)];
  }
  const base = process.env.CENSUS_BASE || "origin/main";
  return [gitShow(`${base}:src/homekit.ts`), readFileSync("src/homekit.ts", "utf8")];
}

function report(result) {
  process.stdout.write(
    `verdict=${result.verdict}\nbefore_firmware=${result.beforeFirmware}\nafter_firmware=${result.afterFirmware}\n`,
  );
  return result.verdict === "churn" ? 1 : 0;
}

const invoked = process.argv[1] && process.argv[1].endsWith("firmware-census.mjs");
if (invoked) {
  try {
    process.exitCode = report(classifyFirmwareChange(...pair(parseArgs(process.argv.slice(2)))));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
