import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const PASSWORD = "fixture-camera-secret-do-not-print";

const CONFIG = `cameras:
  - name: Backyard Left
    host: 192.0.2.10
    channel: 0
    username: admin
    password: ${PASSWORD}
    transport: auto
    streams:
      main: main
      sub: sub
  - name: Front L
    host: 192.0.2.11
    channel: 2
    username: admin
    password: ${PASSWORD}
    transport: auto
    streams:
      main: main
      sub: sub
`;

describe("stream health", () => {
  beforeAll(() => {
    if (!existsSync("dist/go2rtc.js")) {
      execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { stdio: "inherit" });
    }
  }, 120_000);

  it("probes each local main and sub and does not print secrets or call /api/streams", () => {
    const root = mkdtempSync(path.join(tmpdir(), "argus-health-"));
    const bin = path.join(root, "bin");
    const configPath = path.join(root, "argus.yaml");
    const probeLog = path.join(root, "ffprobe.log");
    const curlLog = path.join(root, "curl.log");
    mkdirSync(bin);
    writeFileSync(configPath, CONFIG);
    writeFileSync(
      path.join(bin, "ffprobe"),
      `#!/bin/bash
url="\${@: -1}"
printf '%s\\n' "$url" >> ${JSON.stringify(probeLog)}
name="\${url##*/}"
case "$name" in
  backyard-left) echo "h264,1280,720"; exit 0 ;;
  backyard-left-sub) exit 1 ;;
  front-l) echo "h264,2560,1440"; exit 0 ;;
  front-l-sub) sleep 5; exit 0 ;;
esac
echo "unexpected $url" >&2
exit 2
`,
    );
    writeFileSync(
      path.join(bin, "curl"),
      `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(curlLog)}
exit 0
`,
    );
    chmodSync(path.join(bin, "ffprobe"), 0o755);
    chmodSync(path.join(bin, "curl"), 0o755);

    const result = spawnSync(
      "node",
      ["scripts/stream-health.mjs", "--config", configPath, "--timeout-ms", "250"],
      {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME,
        },
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stdout).toBe(
      [
        "stream_count=4",
        "backyard-left\tUP\th264,1280,720",
        "backyard-left-sub\tDOWN\texit=1",
        "front-l\tUP\th264,2560,1440",
        "front-l-sub\tDOWN\ttimeout",
        "up_count=2",
        "",
      ].join("\n"),
    );
    expect(readFileSync(probeLog, "utf8")).toBe(
      [
        "rtsp://127.0.0.1:8554/backyard-left",
        "rtsp://127.0.0.1:8554/backyard-left-sub",
        "rtsp://127.0.0.1:8554/front-l",
        "rtsp://127.0.0.1:8554/front-l-sub",
        "",
      ].join("\n"),
    );
    expect(result.stdout.includes(PASSWORD)).toBe(false);
    expect(result.stderr.includes(PASSWORD)).toBe(false);
    expect(result.stdout.includes("rtsp://")).toBe(false);
    expect(result.stderr.includes("rtsp://")).toBe(false);
    expect(result.stdout.includes("/api/streams")).toBe(false);
    expect(result.stderr.includes("/api/streams")).toBe(false);
    let curlText = "";
    try {
      curlText = readFileSync(curlLog, "utf8");
    } catch {
      curlText = "";
    }
    expect(curlText).toBe("");
  });
});
