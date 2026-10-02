#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repoDir = resolve(new URL("..", import.meta.url).pathname);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function passthroughArg(name) {
  const value = arg(name, undefined);
  return value === undefined ? [] : [`--${name}`, value];
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

const host = arg("host", "mini");
const remoteLog = arg("remote-log", "/Users/pointlabs/Projects/argus/logs/serve.err.log");
const mirrorLog = resolve(arg("mirror-log", `/tmp/argus-mini-home-live-${timestampSlug()}.log`));
const timeoutSeconds = arg("timeout-seconds", "180");
const camera = arg("camera", "Garage Door");
const ignoreController = arg("ignore-controller", "10.0.0.46");
const jsonOut = arg("json-out", "");

function emitSetup() {
  const setup = {
    host,
    remoteLog,
    mirrorLog,
    camera,
    timeoutSeconds: Number(timeoutSeconds),
    ignoreController,
    jsonOut: jsonOut ? resolve(jsonOut) : undefined,
  };
  process.stderr.write(`${JSON.stringify({ watchMiniSetup: setup })}\n`);
}

function spawnSshTail() {
  mkdirSync(dirname(mirrorLog), { recursive: true });
  writeFileSync(mirrorLog, "");
  const stream = createWriteStream(mirrorLog, { flags: "a" });
  const child = spawn("ssh", [host, "tail", "-n", "0", "-F", remoteLog], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
  child.on("close", () => {
    stream.end();
  });
  return { child, stream };
}

async function runWatcher() {
  emitSetup();
  const tail = spawnSshTail();
  try {
    await sleep(750);

    const args = [
      resolve(repoDir, "scripts/watch-home-live.mjs"),
      "--err-log", mirrorLog,
      "--camera", camera,
      "--timeout-seconds", timeoutSeconds,
      ...passthroughArg("poll-ms"),
      ...passthroughArg("json-out"),
    ];
    if (ignoreController) {
      args.push("--ignore-controller", ignoreController);
    }

    const watcher = spawn(process.execPath, args, {
      cwd: repoDir,
      stdio: ["ignore", "inherit", "inherit"],
    });

    const exitCode = await new Promise((resolveExit, reject) => {
      watcher.once("error", reject);
      watcher.once("close", (code, signal) => {
        resolveExit(code ?? (signal ? 1 : 0));
      });
    });

    process.exitCode = exitCode;
  } finally {
    tail.child.kill("SIGTERM");
    tail.stream.end();
  }
}

runWatcher().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
