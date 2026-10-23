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

export function recordingOffer(src) {
  const marker = "export function buildRecordingOptions";
  const start = src.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const stripped = src
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const boundary = stripped.slice(marker.length).search(/\n(?:export |function )/);
  const body = boundary < 0 ? stripped : stripped.slice(0, marker.length + boundary);
  return body
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n");
}

export function classifyFirmwareChange(before, after) {
  const beforeFirmware = firmwareRevision(before);
  const afterFirmware = firmwareRevision(after);
  const sameAdvertisement = advertisement(before) === advertisement(after);
  let verdict = "justified";
  if (beforeFirmware === afterFirmware && sameAdvertisement) {
    verdict = "unchanged";
  } else if (beforeFirmware === afterFirmware) {
    verdict = "stale";
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

function gitShowIfPresent(spec) {
  try {
    execFileSync("git", ["cat-file", "-e", spec], { stdio: "ignore" });
  } catch {
    return "";
  }
  return gitShow(spec);
}

function parseArgs(argv) {
  const args = {
    before: null,
    after: null,
    commit: null,
    beforeRecording: null,
    afterRecording: null,
  };
  const keys = {
    "--before": "before",
    "--after": "after",
    "--commit": "commit",
    "--before-recording": "beforeRecording",
    "--after-recording": "afterRecording",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = keys[flag];
    if (key === undefined) {
      throw new Error(`unknown argument ${flag}`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function readRecordingFiles(beforePath, afterPath) {
  if (beforePath === null && afterPath === null) {
    return [null, null];
  }
  if (beforePath === null || afterPath === null) {
    throw new Error("--before-recording and --after-recording are a pair");
  }
  return [readFileSync(beforePath, "utf8"), readFileSync(afterPath, "utf8")];
}

function pair(args) {
  if (args.before !== null || args.after !== null) {
    if (args.before === null || args.after === null) {
      throw new Error("--before and --after are a pair");
    }
    const [beforeRecording, afterRecording] = readRecordingFiles(
      args.beforeRecording,
      args.afterRecording,
    );
    return {
      before: readFileSync(args.before, "utf8"),
      after: readFileSync(args.after, "utf8"),
      beforeRecording,
      afterRecording,
    };
  }
  if (args.beforeRecording !== null || args.afterRecording !== null) {
    throw new Error("--before-recording requires --before and --after");
  }
  if (args.commit !== null) {
    const parent = execFileSync("git", ["rev-parse", `${args.commit}^`], {
      encoding: "utf8",
    }).trim();
    return {
      before: gitShow(`${parent}:src/homekit.ts`),
      after: gitShow(`${args.commit}:src/homekit.ts`),
      beforeRecording: gitShowIfPresent(`${parent}:src/recording.ts`),
      afterRecording: gitShowIfPresent(`${args.commit}:src/recording.ts`),
    };
  }
  const base = process.env.CENSUS_BASE || "origin/main";
  return {
    before: gitShow(`${base}:src/homekit.ts`),
    after: readFileSync("src/homekit.ts", "utf8"),
    beforeRecording: gitShowIfPresent(`${base}:src/recording.ts`),
    afterRecording: readFileSync("src/recording.ts", "utf8"),
  };
}

function recordingOfferChanged(beforeRecording, afterRecording) {
  if (beforeRecording === null || afterRecording === null) {
    return false;
  }
  return recordingOffer(beforeRecording) !== recordingOffer(afterRecording);
}

function report(result, recordingChanged) {
  process.stdout.write(
    `verdict=${result.verdict}\nbefore_firmware=${result.beforeFirmware}\nafter_firmware=${result.afterFirmware}\n`,
  );
  if (recordingChanged) {
    process.stderr.write(
      "warning: recording offer changed in src/recording.ts. A recording-offer change is not a live-ladder change.\n",
    );
  }
  return result.verdict === "churn" || result.verdict === "stale" ? 1 : 0;
}

const invoked = process.argv[1] && process.argv[1].endsWith("firmware-census.mjs");
if (invoked) {
  try {
    const loaded = pair(parseArgs(process.argv.slice(2)));
    const result = classifyFirmwareChange(loaded.before, loaded.after);
    process.exitCode = report(
      result,
      recordingOfferChanged(loaded.beforeRecording, loaded.afterRecording),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
