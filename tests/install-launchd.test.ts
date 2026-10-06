import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CANONICAL_DAEMON_PLIST = "/Library/LaunchDaemons/dev.point-labs.argus.plist";

const FIXTURE_ENV: Record<string, string> = {
  ARGUS_HUB_ADDRESSES: "10.0.0.15",
  ARGUS_LIVE_LADDER: "1",
  ARGUS_LIVE_OBEY_BITRATE: "1",
  ARGUS_LIVE_COPY: "1",
  ARGUS_AUDIO: "1",
  ARGUS_LIVE_MAIN_SOURCE: "1",
  ARGUS_LIVE_CAP: "640",
  ARGUS_HAP_BIND: "10.0.0.8",
  ARGUS_FFMPEG: "/usr/local/bin/ffmpeg-homebridge",
};

function agentFixture(env: Record<string, string>): string {
  const entries = Object.entries(env)
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${value}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.point-labs.argus</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/fixture/should-not-win</string>
    <key>NOT_ARGUS</key>
    <string>drop-me</string>
${entries}
  </dict>
</dict>
</plist>
`;
}

function ensureRepoFile(relative: string, contents: string): boolean {
  if (existsSync(relative)) return false;
  mkdirSync(path.dirname(relative), { recursive: true });
  writeFileSync(relative, contents);
  return true;
}

function readPlist(file: string): Record<string, unknown> {
  const script = [
    "import json, plistlib, sys",
    "with open(sys.argv[1], 'rb') as handle:",
    "    print(json.dumps(plistlib.load(handle)))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", script, file], { encoding: "utf8" });
  return JSON.parse(out) as Record<string, unknown>;
}

const CRED_FILE = "/tmp/argus-streams.json";

function renderDaemon(script: string, extraEnv: Record<string, string>, renderOnly = true) {
  const root = mkdtempSync(path.join(tmpdir(), "argus-launchd-"));
  const home = path.join(root, "home");
  const installRoot = path.join(root, "install");
  const bin = path.join(root, "bin");
  const launchctlLog = path.join(root, "launchctl.log");
  const fixture = path.join(root, "agent.plist");
  mkdirSync(home);
  mkdirSync(installRoot);
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "launchctl"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(launchctlLog)}\nexit 0\n`,
  );
  chmodSync(path.join(bin, "launchctl"), 0o755);
  writeFileSync(fixture, agentFixture(FIXTURE_ENV));
  const createdServe = ensureRepoFile("dist/serve.js", "");
  const createdConfig = ensureRepoFile("argus.yaml", "cameras: []\n");
  try {
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: home,
        TMPDIR: root,
        USER: "ubuntu",
        LOGNAME: "ubuntu",
        SHELL: "/bin/bash",
        ...(renderOnly ? { ARGUS_INSTALL_RENDER_ONLY: "1" } : {}),
        ARGUS_INSTALL_ROOT: installRoot,
        ARGUS_AGENT_PLIST: fixture,
        ...extraEnv,
      },
    });
    return { result, installRoot, launchctlLog, createdServe, createdConfig, root };
  } catch (error) {
    if (createdServe) rmSync("dist/serve.js", { force: true });
    if (createdConfig) rmSync("argus.yaml", { force: true });
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function cleanup(run: {
  createdServe: boolean;
  createdConfig: boolean;
  root: string;
}) {
  if (run.createdServe) rmSync("dist/serve.js", { force: true });
  if (run.createdConfig) rmSync("argus.yaml", { force: true });
  rmSync(run.root, { recursive: true, force: true });
}

describe("install-launchd daemon plist", () => {
  it("writes /Library/LaunchDaemons/dev.point-labs.argus.plist from the agent fixture", () => {
    const run = renderDaemon("scripts/install-launchd.sh", {});
    try {
      const { result, installRoot, launchctlLog } = run;

      const dest = path.join(installRoot, "Library/LaunchDaemons/dev.point-labs.argus.plist");
      expect(result.stdout.split(/\r?\n/), `${result.stderr}`).toContain(CANONICAL_DAEMON_PLIST);
      expect(existsSync(dest), result.stderr).toBe(true);
      expect(result.status, result.stderr).toBe(0);

      const plist = readPlist(dest);
      const user = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
      expect(plist.UserName).toBe(user);
      expect(plist.RunAtLoad).toBe(true);
      expect(plist.KeepAlive).toBe(true);

      const env = plist.EnvironmentVariables as Record<string, string>;
      for (const [key, value] of Object.entries(FIXTURE_ENV)) {
        expect(env[key]).toBe(value);
      }
      expect(env.NOT_ARGUS).toBeUndefined();
      expect(env.ARGUS_FIRMWARE_REVISION).toBeUndefined();
      expect(env.ARGUS_INSTALL_RENDER_ONLY).toBeUndefined();
      expect(env.ARGUS_INSTALL_ROOT).toBeUndefined();
      expect(env.ARGUS_AGENT_PLIST).toBeUndefined();
      expect(env.PATH.split(":")[0]).toBe(path.dirname(process.execPath));
      expect(existsSync(launchctlLog)).toBe(false);
      expect(existsSync(CRED_FILE)).toBe(false);
    } finally {
      cleanup(run);
    }
  });

  it("sets UserName to SUDO_USER so a sudo install is not root", () => {
    const run = renderDaemon("scripts/install-launchdaemon.sh", { SUDO_USER: "mini", SUDO_UID: "501" });
    try {
      const { result, installRoot } = run;
      const dest = path.join(installRoot, "Library/LaunchDaemons/dev.point-labs.argus.plist");
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout.split(/\r?\n/)).toContain(CANONICAL_DAEMON_PLIST);
      const plist = readPlist(dest);
      expect(plist.UserName).toBe("mini");
      expect(existsSync(CRED_FILE)).toBe(false);
    } finally {
      cleanup(run);
    }
  });

  it("does not call launchctl or leave /tmp/argus-streams.json when sudo writes the plist", () => {
    const run = renderDaemon("scripts/install-launchdaemon.sh", { SUDO_USER: "mini", SUDO_UID: "501" }, false);
    try {
      const { result, installRoot, launchctlLog } = run;
      const dest = path.join(installRoot, "Library/LaunchDaemons/dev.point-labs.argus.plist");
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout.split(/\r?\n/)).toContain(CANONICAL_DAEMON_PLIST);
      expect(readPlist(dest).UserName).toBe("mini");
      expect(existsSync(launchctlLog)).toBe(false);
      expect(existsSync(CRED_FILE)).toBe(false);
    } finally {
      cleanup(run);
    }
  });
});
