#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const camera = arg("camera", "Garage Door");
const tileX = Number(arg("tile-x", "391"));
const tileY = Number(arg("tile-y", "218"));
const resetX = Number(arg("reset-x", "22"));
const resetY = Number(arg("reset-y", "74"));
const resetClicks = Number(arg("reset-clicks", "2"));
const holdSeconds = Number(arg("hold-seconds", "35"));
const sampleSeconds = Number(arg("sample-seconds", "8"));
const sampleIntervalMs = Number(arg("sample-interval-ms", "1000"));
const analysisCropArg = arg("analysis-crop", "");
const visualThresholdPct = Number(arg("visual-threshold-pct", "3"));
const minCooldownSeconds = Number(arg("min-cooldown-seconds", "600"));
const commandTimeoutMs = Number(arg("command-timeout-ms", "15000"));
const ignoreCooldown = process.argv.includes("--ignore-cooldown");
const outDir = resolve(arg("out-dir", `/tmp/argus-homekit-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const jsonOut = arg("json-out", "");
const repoDir = resolve(new URL("..", import.meta.url).pathname);
const errLog = resolve(arg("err-log", resolve(repoDir, "logs/serve.err.log")));

function commandError(command, args, error) {
  const stderr = error.stderr?.toString?.() ?? "";
  const stdout = error.stdout?.toString?.() ?? "";
  const meta = [
    error.status !== undefined ? `status=${error.status}` : undefined,
    error.signal ? `signal=${error.signal}` : undefined,
    error.code ? `code=${error.code}` : undefined,
    error.killed ? "killed=true" : undefined,
  ].filter(Boolean).join(" ");
  const details = [meta, stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return new Error(`${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`);
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Number.isFinite(commandTimeoutMs) && commandTimeoutMs > 0 ? commandTimeoutMs : 15000,
      ...options,
    });
  } catch (error) {
    throw commandError(command, args, error);
  }
}

function tryRun(command, args, options = {}) {
  try {
    return { ok: true, output: run(command, args, options) };
  } catch (error) {
    return { ok: false, error };
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function emitJson(result) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (jsonOut) {
    writeFileSync(resolve(jsonOut), json);
  }
  process.stdout.write(json);
}

function wakeDisplay() {
  tryRun("caffeinate", ["-u", "-t", "2"]);
}

function loginwindowState() {
  const result = tryRun("peekaboo", ["list", "windows", "--app", "loginwindow", "--json"]);
  if (!result.ok) {
    return {
      blocking: false,
      error: result.error instanceof Error ? result.error.message : String(result.error),
    };
  }
  const parsed = JSON.parse(result.output);
  const app = parsed?.data?.targetApplication;
  const windows = parsed?.data?.windows ?? [];
  const blockingWindow = windows.find((w) => {
    const [, size = [0, 0]] = w.bounds ?? [];
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    return w.isOnScreen
      && !w.isMinimized
      && (w.title === "Login" || (w.windowLevel ?? 0) >= 1000)
      && width >= 1000
      && height >= 700;
  });
  return {
    blocking: Boolean(app?.isActive && blockingWindow),
    appActive: Boolean(app?.isActive),
    windowId: blockingWindow?.window_id,
    title: blockingWindow?.title,
    windowLevel: blockingWindow?.windowLevel,
  };
}

function assertGuiUnlocked() {
  const state = loginwindowState();
  if (state.blocking) {
    throw new Error(
      `macOS GUI is locked or loginwindow is frontmost (window ${state.windowId ?? "unknown"}`
      + `${state.title ? ` "${state.title}"` : ""}). Unlock the Mac before running Home verification.`,
    );
  }
  return state;
}

function parseHomeWindow() {
  const windows = JSON.parse(run("peekaboo", ["list", "windows", "--app", "Home", "--json"]));
  const visibleWindows = (windows?.data?.windows ?? [])
    .filter((w) => w.isOnScreen && !w.isMinimized)
    .map((w) => {
      const [, size = [0, 0]] = w.bounds ?? [];
      return { ...w, width: size[0] ?? 0, height: size[1] ?? 0 };
    })
    .filter((w) => w.width >= 600 && w.height >= 500)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const window = visibleWindows.find((w) => w.title === "Home")
    ?? visibleWindows[0]
    ?? windows?.data?.windows?.find((w) => w.isOnScreen && !w.isMinimized)
    ?? windows?.data?.windows?.[0];
  if (!window) {
    throw new Error("Home is running, but Peekaboo did not find a visible Home window.");
  }
  if (!window.isOnScreen || window.isMinimized) {
    throw new Error("Home window is not visible. Unlock the Mac and leave Home visible before running verification.");
  }
  return window;
}

function foregroundClick(description, x, y, windowId) {
  const targetArgs = windowId
    ? ["--window-id", String(windowId)]
    : ["--app", "Home"];
  const output = run("peekaboo", ["click", ...targetArgs, "--coords", `${x},${y}`, "--foreground"], { stdio: "pipe" });
  if (/App:\s*loginwindow/i.test(output)) {
    throw new Error(`${description} hit loginwindow, not Home. Unlock the Mac before running Home verification.`);
  }
  return output;
}

function screenshot(name, windowId) {
  const path = resolve(outDir, `${name}.png`);
  let lastError;
  const attempts = windowId
    ? [
      { args: ["image", "--window-id", String(windowId), "--path", path], method: "peekaboo-window-id" },
      { args: ["image", "--app", "Home", "--path", path], method: "peekaboo" },
    ]
    : [
      { args: ["image", "--app", "Home", "--path", path], method: "peekaboo" },
    ];
  for (const capture of attempts) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = tryRun("peekaboo", capture.args, { stdio: "pipe" });
      if (result.ok) {
        return { path, method: capture.method };
      }
      lastError = result.error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
    }
  }
  const fallback = tryRun("screencapture", ["-x", path], { stdio: "pipe" });
  if (fallback.ok) {
    return { path, method: "screencapture" };
  }
  throw lastError;
}

function screenshotDimensions(path) {
  const output = tryRun("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { stdio: "pipe" });
  if (!output.ok) return undefined;
  const width = Number(output.output.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(output.output.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseAnalysisCrop(value) {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d+),(\d+),(\d+),(\d+)$/);
  if (!match) {
    throw new Error(`--analysis-crop must be x,y,width,height; got ${value}`);
  }
  const [, x, y, width, height] = match.map(Number);
  return { x, y, width, height };
}

function defaultAnalysisCrop(dimensions) {
  // Home's left sidebar and top toolbar are not live-video evidence. Bias the
  // default crop toward the camera/content area while keeping it resolution-safe.
  const x = Math.round(dimensions.width * 0.22);
  const y = Math.round(dimensions.height * 0.15);
  const width = Math.round(dimensions.width * 0.72);
  const height = Math.round(dimensions.height * 0.7);
  return { x, y, width, height };
}

function clampCrop(crop, dimensions) {
  const x = Math.max(0, Math.min(crop.x, dimensions.width - 1));
  const y = Math.max(0, Math.min(crop.y, dimensions.height - 1));
  const width = Math.max(1, Math.min(crop.width, dimensions.width - x));
  const height = Math.max(1, Math.min(crop.height, dimensions.height - y));
  return { x, y, width, height };
}

function cropFor(path) {
  const dimensions = screenshotDimensions(path);
  if (!dimensions) {
    throw new Error(`Could not read screenshot dimensions for ${path}`);
  }
  return clampCrop(parseAnalysisCrop(analysisCropArg) ?? defaultAnalysisCrop(dimensions), dimensions);
}

function cropImage(sourcePath, outputPath, crop) {
  run("sips", [
    "--cropOffset", String(crop.y), String(crop.x),
    "--cropToHeightWidth", String(crop.height), String(crop.width),
    sourcePath,
    "--out", outputPath,
  ], { stdio: "pipe" });
}

function convertToBmp(sourcePath, outputPath) {
  run("sips", ["-s", "format", "bmp", sourcePath, "--out", outputPath], { stdio: "pipe" });
}

function readBmpLuma(path) {
  const buffer = readFileSync(path);
  if (buffer.toString("ascii", 0, 2) !== "BM") {
    throw new Error(`${path} is not a BMP image`);
  }
  const dataOffset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const signedHeight = buffer.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const topDown = signedHeight < 0;
  const bitsPerPixel = buffer.readUInt16LE(28);
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new Error(`${path} has unsupported BMP depth ${bitsPerPixel}`);
  }
  const bytesPerPixel = bitsPerPixel / 8;
  const rowStride = Math.floor(((bitsPerPixel * width) + 31) / 32) * 4;
  const luma = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = topDown ? y : height - 1 - y;
    const rowOffset = dataOffset + (sourceY * rowStride);
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = rowOffset + (x * bytesPerPixel);
      const b = buffer[pixelOffset] ?? 0;
      const g = buffer[pixelOffset + 1] ?? 0;
      const r = buffer[pixelOffset + 2] ?? 0;
      luma[(y * width) + x] = (0.299 * r) + (0.587 * g) + (0.114 * b);
    }
  }
  return { width, height, luma };
}

function diffPct(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.luma.length !== b.luma.length) {
    return undefined;
  }
  let total = 0;
  for (let i = 0; i < a.luma.length; i += 1) {
    total += Math.abs(a.luma[i] - b.luma[i]);
  }
  return Number(((total / (a.luma.length * 255)) * 100).toFixed(2));
}

function sameDimensions(left, right) {
  return left?.width === right?.width && left?.height === right?.height;
}

function sampleExclusionReason(sample, referenceDimensions) {
  if (!sameDimensions(sample.dimensions, referenceDimensions)) {
    return "dimensions differ from pre-click Home window capture";
  }
  if (sample.method === "screencapture") {
    return "full-screen fallback capture is not comparable to Home window crop";
  }
  return undefined;
}

function analyzeCrop(path, name, crop) {
  const croppedPath = resolve(outDir, `analysis-${name}.png`);
  const bmpPath = resolve(outDir, `analysis-${name}.bmp`);
  cropImage(path, croppedPath, crop);
  convertToBmp(croppedPath, bmpPath);
  return {
    path,
    croppedPath,
    bmpPath,
    cropHash: sha256(croppedPath).slice(0, 16),
    image: readBmpLuma(bmpPath),
  };
}

function analyzeVisualEvidence(beforePath, samples, afterPath) {
  try {
    const referenceDimensions = screenshotDimensions(beforePath);
    const excludedSamples = [];
    const comparableSamples = samples.filter((sample) => {
      const reason = sampleExclusionReason(sample, referenceDimensions);
      if (reason) {
        excludedSamples.push({
          path: sample.path,
          tMs: sample.tMs,
          method: sample.method,
          dimensions: sample.dimensions,
          reason,
        });
        return false;
      }
      return true;
    });
    const crop = cropFor(beforePath);
    const before = analyzeCrop(beforePath, "before", crop);
    const after = analyzeCrop(afterPath, "after", crop);
    const croppedSamples = comparableSamples.map((sample, index) => ({
      sample,
      analyzed: analyzeCrop(sample.path, `sample-${String(index + 1).padStart(2, "0")}`, crop),
    }));
    const analyzedSamples = croppedSamples.map(({ sample, analyzed }, index) => {
      const previous = croppedSamples[index - 1]?.analyzed;
      return {
        path: sample.path,
        tMs: sample.tMs,
        cropHash: analyzed.cropHash,
        croppedPath: analyzed.croppedPath,
        diffFromBeforePct: diffPct(analyzed.image, before.image),
        diffFromPreviousPct: previous ? diffPct(analyzed.image, previous.image) : undefined,
        diffFromAfterPct: diffPct(analyzed.image, after.image),
      };
    });
    const threshold = Number.isFinite(visualThresholdPct) ? visualThresholdPct : 3;
    const firstVisualChange = analyzedSamples.find((sample) => (sample.diffFromBeforePct ?? 0) >= threshold);
    const firstMotionCandidate = analyzedSamples.find((sample) => (sample.diffFromPreviousPct ?? 0) >= threshold);
    return {
      crop,
      thresholdPct: threshold,
      beforeCropHash: before.cropHash,
      afterCropHash: after.cropHash,
      totalSampleCount: samples.length,
      analyzedSampleCount: analyzedSamples.length,
      excludedSamples,
      uniqueSampleCropHashes: new Set(analyzedSamples.map((sample) => sample.cropHash)).size,
      firstVisualChangeMs: firstVisualChange?.tMs ?? null,
      firstMotionCandidateMs: firstMotionCandidate?.tMs ?? null,
      samples: analyzedSamples,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function timestampOf(line) {
  const token = line.match(/^\d{4}-\d{2}-\d{2}T\S+/)?.[0];
  if (!token) return undefined;
  const timestamp = Date.parse(token);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function liveEventKind(line) {
  if (line.includes("HomeKit negotiated")) return "negotiated";
  if (line.includes("ffmpeg exited")) return "ffmpeg exited";
  if (line.includes("RTCP monitor")) return "RTCP monitor";
  if (line.includes("ffmpeg spawn error")) return "ffmpeg spawn error";
  return "live event";
}

function latestHomeLiveEvent(logText) {
  return logText
    .split("\n")
    .filter((line) =>
      line.includes(`[argus ${camera}] HomeKit negotiated`) ||
      line.includes(`[argus ${camera}] RTCP monitor`) ||
      line.includes(`[argus ${camera}] ffmpeg exited`) ||
      line.includes(`[argus ${camera}] ffmpeg spawn error`),
    )
    .map((line) => ({ line, timestamp: timestampOf(line), kind: liveEventKind(line) }))
    .filter((event) => event.timestamp !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp)
    .at(-1);
}

function enforceCooldown() {
  if (ignoreCooldown || !Number.isFinite(minCooldownSeconds) || minCooldownSeconds <= 0) {
    return undefined;
  }
  const latest = latestHomeLiveEvent(readFileSync(errLog, "utf8"));
  if (!latest) return undefined;

  const availableAt = latest.timestamp + (minCooldownSeconds * 1000);
  const remainingMs = availableAt - Date.now();
  if (remainingMs <= 0) {
    return {
      latestEventAt: new Date(latest.timestamp).toISOString(),
      latestEventKind: latest.kind,
      availableAt: new Date(availableAt).toISOString(),
      remainingMs: 0,
    };
  }

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  throw new Error(
    `Home live cooldown active for ${camera}: latest ${latest.kind} at ${new Date(latest.timestamp).toISOString()}; `
    + `wait ${remainingSeconds}s until ${new Date(availableAt).toISOString()} or pass --ignore-cooldown.`,
  );
}

function summarizeLogs(logText, sinceMs, clickedAtMs) {
  const relevantLogLines = logText
    .split("\n")
    .filter((line) =>
      line.includes(`[argus ${camera}] HomeKit negotiated`) ||
      line.includes(`[argus ${camera}] HomeKit reconfigure`) ||
      line.includes(`[argus ${camera}] RTCP monitor`) ||
      line.includes(`[argus ${camera}] ffmpeg `) ||
      line.includes(`[argus ${camera}] ffmpeg exited`) ||
      line.includes(`[argus ${camera}] ffmpeg spawn error`),
    )
    .filter((line) => {
      const timestamp = timestampOf(line);
      return timestamp !== undefined && timestamp >= sinceMs;
    });
  const postClickLogLines = relevantLogLines.filter((line) => {
    const timestamp = timestampOf(line);
    return timestamp !== undefined && timestamp >= clickedAtMs - 1000;
  });
  const negotiatedLine = postClickLogLines.find((line) => line.includes("HomeKit negotiated"));
  const ffmpegLine = postClickLogLines.find((line) => line.includes(" ffmpeg ") && !line.includes("ffmpeg exited"));
  const exitLine = [...postClickLogLines].reverse().find((line) => line.includes("ffmpeg exited"));
  const rtcpLine = [...postClickLogLines].reverse().find((line) => line.includes("RTCP monitor video packets="));
  const startAt = negotiatedLine ? timestampOf(negotiatedLine) : undefined;
  const exitAt = exitLine ? timestampOf(exitLine) : undefined;
  const rtcpVideoPackets = Number(rtcpLine?.match(/video packets=(\d+)/)?.[1]);

  return {
    negotiated: Boolean(negotiatedLine),
    negotiatedAt: startAt ? new Date(startAt).toISOString() : undefined,
    clickToNegotiatedMs: startAt ? startAt - clickedAtMs : undefined,
    controllerSelectedAudio: Boolean(negotiatedLine?.includes("audio:")),
    argusAudioDisabled: Boolean(negotiatedLine?.includes("audio: disabled")),
    ffmpegAudioLeg: Boolean(ffmpegLine?.includes(" -c:a ")),
    aacEld: Boolean(negotiatedLine?.includes("AAC-eld") || ffmpegLine?.includes("aac_eld")),
    exited: Boolean(exitLine),
    exitedAt: exitAt ? new Date(exitAt).toISOString() : undefined,
    exitLine,
    rtcpVideoPackets: Number.isFinite(rtcpVideoPackets) ? rtcpVideoPackets : undefined,
    sessionDurationMs: startAt && exitAt ? exitAt - startAt : undefined,
    relevantLogLines,
    postClickLogLines,
  };
}

async function captureSamples(windowId, clickedAtMs) {
  const samples = [];
  const sampleCount = Math.max(0, Math.floor((sampleSeconds * 1000) / sampleIntervalMs));
  for (let i = 1; i <= sampleCount; i += 1) {
    const targetAt = clickedAtMs + (i * sampleIntervalMs);
    await sleep(Math.max(0, targetAt - Date.now()));
    const capturedAt = Date.now();
    const sample = screenshot(`02-sample-${String(i).padStart(2, "0")}-${capturedAt - clickedAtMs}ms`, windowId);
    samples.push({
      path: sample.path,
      method: sample.method,
      tMs: capturedAt - clickedAtMs,
      dimensions: screenshotDimensions(sample.path),
    });
  }
  return samples;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const cooldown = enforceCooldown();
  const guiPreflight = assertGuiUnlocked();
  const logOffset = statSync(errLog).size;
  const logStartAt = Date.now() - 1000;

  wakeDisplay();
  run("open", ["-a", "/System/Applications/Home.app"]);
  run("osascript", ["-e", 'tell application "Home" to activate']);
  await sleep(1000);

  const initialWindow = parseHomeWindow();
  // If Home is stuck on a dim camera detail/live surface, Cmd+[ reveals the
  // camera controls so the top-left close button can be clicked. On the grid it
  // is harmless, and the following click lands on the Home sidebar.
  tryRun("peekaboo", ["hotkey", "cmd+[", "--app", "Home", "--foreground"], { stdio: "pipe" });
  await sleep(500);
  const reset = {
    x: resetX,
    y: resetY,
    resetX,
    resetY,
    clickCount: Math.max(1, Number.isFinite(resetClicks) ? Math.floor(resetClicks) : 2),
    coordinateSpace: "home-window",
  };
  for (let i = 0; i < reset.clickCount; i += 1) {
    foregroundClick(`Home reset click ${i + 1}`, reset.x, reset.y, initialWindow.window_id);
    await sleep(750);
  }
  await sleep(1750);

  const window = parseHomeWindow();
  const click = { x: tileX, y: tileY, tileX, tileY, coordinateSpace: "home-window" };
  const before = screenshot("01-before", window.window_id);

  const clickStartedAt = Date.now();
  foregroundClick("Home camera tile click", click.x, click.y, window.window_id);
  const clickedAt = Date.now();
  const samples = await captureSamples(window.window_id, clickedAt);
  const during = screenshot("02-during", window.window_id);
  await sleep(Math.max(0, (holdSeconds * 1000) - (Date.now() - clickedAt)));
  const after = screenshot("03-after", window.window_id);
  const visual = analyzeVisualEvidence(before.path, samples, after.path);

  const fullLog = readFileSync(errLog, "utf8");
  const lineSafeOffset = logOffset <= 0 ? 0 : fullLog.lastIndexOf("\n", logOffset - 1) + 1;
  const newLog = fullLog.slice(Math.max(0, lineSafeOffset));
  const logSummary = summarizeLogs(newLog, logStartAt, clickedAt);

  emitJson({
    ok: true,
    camera,
    outDir,
    errLog,
    cooldown,
    guiPreflight,
    reset,
    click: {
      ...click,
      startedAt: new Date(clickStartedAt).toISOString(),
      completedAt: new Date(clickedAt).toISOString(),
      commandMs: clickedAt - clickStartedAt,
    },
    screenshots: { before: before.path, during: during.path, after: after.path },
    screenshotMethods: { before: before.method, during: during.method, after: after.method },
    screenshotDimensions: {
      before: screenshotDimensions(before.path),
      during: screenshotDimensions(during.path),
      after: screenshotDimensions(after.path),
    },
    samples,
    visual,
    ...logSummary,
  });
}

main().catch((error) => {
  emitJson({
    ok: false,
    camera,
    outDir,
    errLog,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
