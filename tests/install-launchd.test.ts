import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
const LABEL = "dev.point-labs.argus";
const LOGROTATE_LABEL = "dev.point-labs.argus.logrotate";

type RenderOptions = {
  includeAgentPlistEnv?: boolean;
  separateSudoHome?: boolean;
  agentBody?: string;
  seedDaemon?: boolean;
};

function writeDscl(bin: string, userHome: string) {
  writeFileSync(
    path.join(bin, "dscl"),
    `#!/bin/bash
if [[ "$1" == "." && "$2" == "-read" ]]; then
  echo "NFSHomeDirectory: ${userHome}"
  exit 0
fi
exit 1
`,
  );
  chmodSync(path.join(bin, "dscl"), 0o755);
}

function renderDaemon(
  script: string,
  extraEnv: Record<string, string>,
  renderOnly = true,
  options: RenderOptions = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "argus-launchd-"));
  const home = path.join(root, "home");
  const installRoot = path.join(root, "install");
  const bin = path.join(root, "bin");
  const launchctlLog = path.join(root, "launchctl.log");
  const fixture = path.join(root, "agent.plist");
  const sudoHome = options.separateSudoHome ? path.join(root, "sudo-home") : home;
  mkdirSync(home, { recursive: true });
  mkdirSync(sudoHome, { recursive: true });
  mkdirSync(path.join(sudoHome, "bin"), { recursive: true });
  mkdirSync(installRoot);
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "launchctl"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(launchctlLog)}\nexit 0\n`,
  );
  chmodSync(path.join(bin, "launchctl"), 0o755);
  writeDscl(bin, sudoHome);
  writeFileSync(path.join(sudoHome, "bin", "argus-logrotate.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(sudoHome, "bin", "argus-logrotate.sh"), 0o755);
  const agentBody = options.agentBody ?? agentFixture(FIXTURE_ENV);
  writeFileSync(fixture, agentBody);
  const agentInHome = path.join(sudoHome, "Library", "LaunchAgents", `${LABEL}.plist`);
  mkdirSync(path.dirname(agentInHome), { recursive: true });
  writeFileSync(agentInHome, agentBody);
  if (options.seedDaemon) {
    const dest = path.join(installRoot, "Library/LaunchDaemons", `${LABEL}.plist`);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, agentFixture(FIXTURE_ENV));
  }
  const createdServe = ensureRepoFile("dist/serve.js", "");
  const createdConfig = ensureRepoFile("argus.yaml", "cameras: []\n");
  const includeAgentPlistEnv = options.includeAgentPlistEnv ?? true;
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
        ...(includeAgentPlistEnv ? { ARGUS_AGENT_PLIST: fixture } : {}),
        ...extraEnv,
      },
    });
    return { result, installRoot, launchctlLog, createdServe, createdConfig, root, home, sudoHome, bin };
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
      expect(plist.Umask).toBe(63);
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

describe("sudo HOME and cutover", () => {
  it("reads ARGUS keys from SUDO_USER home when sudo resets HOME, and writes logrotate", () => {
    const run = renderDaemon(
      "scripts/install-launchdaemon.sh",
      { SUDO_USER: "mini", SUDO_UID: "501" },
      true,
      { includeAgentPlistEnv: false, separateSudoHome: true },
    );
    try {
      const { result, installRoot, sudoHome } = run;
      const dest = path.join(installRoot, "Library/LaunchDaemons/dev.point-labs.argus.plist");
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const plist = readPlist(dest);
      const env = plist.EnvironmentVariables as Record<string, string>;
      expect(plist.UserName).toBe("mini");
      expect(env.ARGUS_HAP_BIND).toBe("10.0.0.8");
      expect(env.ARGUS_LIVE_MAIN_SOURCE).toBe("1");
      expect(plist.Umask).toBe(63);
      expect(run.home).not.toBe(sudoHome);

      const rotate = readPlist(
        path.join(installRoot, "Library/LaunchDaemons", `${LOGROTATE_LABEL}.plist`),
      );
      const rotateEnv = rotate.EnvironmentVariables as Record<string, string>;
      expect(rotate.Label).toBe(LOGROTATE_LABEL);
      expect(rotate.UserName).toBe("mini");
      expect(rotate.StartInterval).toBe(3600);
      expect(rotateEnv.HOME).toBe(sudoHome);
      expect(rotate.ProgramArguments).toEqual([path.join(sudoHome, "bin", "argus-logrotate.sh")]);
      expect(JSON.stringify(rotate)).not.toContain("password");
    } finally {
      cleanup(run);
    }
  });

  it("refuses to write a daemon plist when the agent has no ARGUS keys", () => {
    const run = renderDaemon(
      "scripts/install-launchdaemon.sh",
      { SUDO_USER: "mini", SUDO_UID: "501" },
      true,
      {
        includeAgentPlistEnv: false,
        agentBody: agentFixture({}),
      },
    );
    try {
      const dest = path.join(run.installRoot, "Library/LaunchDaemons/dev.point-labs.argus.plist");
      expect(run.result.status, run.result.stdout).not.toBe(0);
      expect(run.result.stderr).toMatch(/ARGUS_/);
      expect(existsSync(dest)).toBe(false);
    } finally {
      cleanup(run);
    }
  });

  it("does not bootstrap the gui agent when the system daemon plist already exists", () => {
    const run = renderDaemon("scripts/install-launchd.sh", {}, false, { seedDaemon: true });
    try {
      const log = existsSync(run.launchctlLog) ? readFileSync(run.launchctlLog, "utf8") : "";
      expect(run.result.status, `${run.result.stdout}\n${run.result.stderr}`).not.toBe(0);
      expect(log).not.toContain("bootstrap");
      expect(run.result.stderr).toMatch(/gui agent/);
    } finally {
      cleanup(run);
    }
  });

  it("cuts the gui agent over to the system daemon and rolls back", () => {
    const run = renderDaemon("scripts/install-launchdaemon.sh", { SUDO_USER: "mini", SUDO_UID: "501" }, true, {
      separateSudoHome: true,
      includeAgentPlistEnv: false,
    });
    try {
      writeFileSync(run.launchctlLog, "");
      const state = path.join(run.root, "launchctl.state");
      writeFileSync(state, "gui/501/dev.point-labs.argus\ngui/501/local.argus.logrotate\n");
      writeFileSync(
        path.join(run.bin, "launchctl"),
        `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(run.launchctlLog)}
cmd="$1"
shift
case "$cmd" in
  bootout)
    if [[ -z "\${ARGUS_TEST_IGNORE_BOOTOUT:-}" ]]; then
      grep -vxF "$1" ${JSON.stringify(state)} > ${JSON.stringify(state)}.tmp || true
      mv ${JSON.stringify(state)}.tmp ${JSON.stringify(state)}
    fi
    ;;
  bootstrap)
    label="$(python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["Label"])' "$2")"
    printf '%s/%s\\n' "$1" "$label" >> ${JSON.stringify(state)}
    ;;
  print)
    if grep -qxF "$1" ${JSON.stringify(state)}; then
      echo "state = running"
      exit 0
    fi
    echo "Could not find service" >&2
    exit 1
    ;;
esac
exit 0
`,
      );
      chmodSync(path.join(run.bin, "launchctl"), 0o755);
      const daemonDir = path.join(run.installRoot, "Library", "LaunchDaemons");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(
        path.join(daemonDir, `${LABEL}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string></dict></plist>
`,
      );
      writeFileSync(
        path.join(daemonDir, `${LOGROTATE_LABEL}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${LOGROTATE_LABEL}</string></dict></plist>
`,
      );
      const rotateAgent = path.join(run.sudoHome, "Library", "LaunchAgents", "local.argus.logrotate.plist");
      writeFileSync(
        rotateAgent,
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>local.argus.logrotate</string>
  <key>ProgramArguments</key>
  <array><string>${path.join(run.sudoHome, "bin", "argus-logrotate.sh")}</string></array>
</dict></plist>
`,
      );
      const env = {
        PATH: `${run.bin}:${process.env.PATH ?? ""}`,
        HOME: run.home,
        TMPDIR: run.root,
        USER: "root",
        LOGNAME: "root",
        SHELL: "/bin/bash",
        SUDO_USER: "mini",
        SUDO_UID: "501",
        ARGUS_INSTALL_ROOT: run.installRoot,
      };
      const agent = path.join(run.sudoHome, "Library", "LaunchAgents", `${LABEL}.plist`);
      const disabledAgent = path.join(run.sudoHome, "Library", "LaunchAgents-disabled", `${LABEL}.plist`);
      const disabledRotate = path.join(run.sudoHome, "Library", "LaunchAgents-disabled", "local.argus.logrotate.plist");
      const bakNames = [
        "dev.point-labs.argus.plist.bak-1",
        "dev.point-labs.argus.plist.bak-2",
        "dev.point-labs.argus.plist.bak-3",
        "dev.point-labs.argus.plist.bak-4",
      ];
      const agentsDir = path.join(run.sudoHome, "Library", "LaunchAgents");
      const disabledDir = path.join(run.sudoHome, "Library", "LaunchAgents-disabled");
      for (const name of bakNames) {
        writeFileSync(path.join(agentsDir, name), `stale ${name}\n`);
      }
      const chownLog = path.join(run.root, "chown.log");
      writeFileSync(
        path.join(run.bin, "id"),
        `#!/bin/bash
if [[ "$1" == "-u" ]]; then
  echo 0
  exit 0
fi
exec /usr/bin/id "$@"
`,
      );
      chmodSync(path.join(run.bin, "id"), 0o755);
      writeFileSync(
        path.join(run.bin, "chown"),
        `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(chownLog)}
exit 0
`,
      );
      chmodSync(path.join(run.bin, "chown"), 0o755);
      const cutover = spawnSync("bash", ["scripts/cutover-launchdaemon.sh"], { encoding: "utf8", env });
      expect(cutover.status, `${cutover.stdout}\n${cutover.stderr}`).toBe(0);
      expect(existsSync(agent)).toBe(false);
      expect(existsSync(disabledAgent)).toBe(true);
      expect(existsSync(rotateAgent)).toBe(false);
      expect(existsSync(disabledRotate)).toBe(true);
      const log = readFileSync(run.launchctlLog, "utf8");
      const bootoutAt = log.indexOf("bootout gui/501/dev.point-labs.argus");
      const disableAt = log.indexOf("disable gui/501/dev.point-labs.argus");
      const bootstrapAt = log.indexOf(`bootstrap system ${path.join(daemonDir, `${LABEL}.plist`)}`);
      expect(bootoutAt).toBeGreaterThanOrEqual(0);
      expect(disableAt).toBeGreaterThan(bootoutAt);
      expect(bootstrapAt).toBeGreaterThan(disableAt);
      expect(log).toContain("bootout gui/501/local.argus.logrotate");
      expect(log).toContain("disable gui/501/local.argus.logrotate");
      expect(log).toContain(`bootstrap system ${path.join(daemonDir, `${LOGROTATE_LABEL}.plist`)}`);
      const loaded = readFileSync(state, "utf8");
      expect(loaded).toContain("system/dev.point-labs.argus");
      expect(loaded).not.toContain("gui/501/dev.point-labs.argus");
      expect(loaded).not.toContain("gui/501/local.argus.logrotate");
      const chownText = existsSync(chownLog) ? readFileSync(chownLog, "utf8") : "";
      expect(chownText).toContain(`mini ${disabledDir}`);
      for (const name of bakNames) {
        expect(existsSync(path.join(agentsDir, name))).toBe(false);
        expect(readFileSync(path.join(disabledDir, name), "utf8")).toBe(`stale ${name}\n`);
        expect(log).not.toContain(name);
      }

      const rollback = spawnSync("bash", ["scripts/rollback-launchdaemon.sh"], { encoding: "utf8", env });
      expect(rollback.status, `${rollback.stdout}\n${rollback.stderr}`).toBe(0);
      expect(existsSync(agent)).toBe(true);
      expect(existsSync(disabledAgent)).toBe(false);
      expect(existsSync(rotateAgent)).toBe(true);
      const after = readFileSync(state, "utf8");
      expect(after).toContain("gui/501/dev.point-labs.argus");
      expect(after).not.toContain("system/dev.point-labs.argus");
      expect(after).not.toContain(`system/${LOGROTATE_LABEL}`);
      const rollbackLog = readFileSync(run.launchctlLog, "utf8");
      for (const name of bakNames) {
        expect(readFileSync(path.join(agentsDir, name), "utf8")).toBe(`stale ${name}\n`);
        expect(existsSync(path.join(disabledDir, name))).toBe(false);
        expect(rollbackLog).not.toContain(`bootstrap gui/501 ${path.join(agentsDir, name)}`);
      }
    } finally {
      cleanup(run);
    }
  });

  it("exits non-zero when the gui agent is still loaded beside the system daemon", () => {
    const run = renderDaemon("scripts/install-launchdaemon.sh", { SUDO_USER: "mini", SUDO_UID: "501" }, true, {
      separateSudoHome: true,
      includeAgentPlistEnv: false,
    });
    try {
      const state = path.join(run.root, "launchctl.state");
      writeFileSync(state, "gui/501/dev.point-labs.argus\n");
      writeFileSync(run.launchctlLog, "");
      writeFileSync(
        path.join(run.bin, "launchctl"),
        `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(run.launchctlLog)}
exit 0
`,
      );
      chmodSync(path.join(run.bin, "launchctl"), 0o755);
      const daemonDir = path.join(run.installRoot, "Library", "LaunchDaemons");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(
        path.join(daemonDir, `${LABEL}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string></dict></plist>
`,
      );
      writeFileSync(
        path.join(daemonDir, `${LOGROTATE_LABEL}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${LOGROTATE_LABEL}</string></dict></plist>
`,
      );
      const cutover = spawnSync("bash", ["scripts/cutover-launchdaemon.sh"], {
        encoding: "utf8",
        env: {
          PATH: `${run.bin}:${process.env.PATH ?? ""}`,
          HOME: run.home,
          TMPDIR: run.root,
          USER: "root",
          LOGNAME: "root",
          SHELL: "/bin/bash",
          SUDO_USER: "mini",
          SUDO_UID: "501",
          ARGUS_INSTALL_ROOT: run.installRoot,
          ARGUS_TEST_IGNORE_BOOTOUT: "1",
        },
      });
      const agent = path.join(run.sudoHome, "Library", "LaunchAgents", `${LABEL}.plist`);
      expect(cutover.status, `${cutover.stdout}\n${cutover.stderr}`).not.toBe(0);
      expect(cutover.stderr).toMatch(/still loaded/);
      expect(cutover.stderr).toMatch(/Not bootstrapping the system daemon/);
      const log = readFileSync(run.launchctlLog, "utf8");
      expect(log).not.toContain("bootstrap system");
      expect(existsSync(agent)).toBe(true);
    } finally {
      cleanup(run);
    }
  });

  it("aborts before bootstrapping the system daemon when gui bootout fails", () => {
    const run = renderDaemon("scripts/install-launchdaemon.sh", { SUDO_USER: "mini", SUDO_UID: "501" }, true, {
      separateSudoHome: true,
      includeAgentPlistEnv: false,
    });
    try {
      writeFileSync(run.launchctlLog, "");
      writeFileSync(
        path.join(run.bin, "launchctl"),
        `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(run.launchctlLog)}
cmd="$1"
if [[ "$cmd" == "bootout" ]]; then
  echo "Boot-out failed: 3: No such process" >&2
  exit 1
fi
if [[ "$cmd" == "print" ]]; then
  echo "state = running"
  exit 0
fi
exit 0
`,
      );
      chmodSync(path.join(run.bin, "launchctl"), 0o755);
      const daemonDir = path.join(run.installRoot, "Library", "LaunchDaemons");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(
        path.join(daemonDir, `${LABEL}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string></dict></plist>
`,
      );
      writeFileSync(
        path.join(daemonDir, `${LOGROTATE_LABEL}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${LOGROTATE_LABEL}</string></dict></plist>
`,
      );
      const agent = path.join(run.sudoHome, "Library", "LaunchAgents", `${LABEL}.plist`);
      const cutover = spawnSync("bash", ["scripts/cutover-launchdaemon.sh"], {
        encoding: "utf8",
        env: {
          PATH: `${run.bin}:${process.env.PATH ?? ""}`,
          HOME: run.home,
          TMPDIR: run.root,
          USER: "root",
          LOGNAME: "root",
          SHELL: "/bin/bash",
          SUDO_USER: "mini",
          SUDO_UID: "501",
          ARGUS_INSTALL_ROOT: run.installRoot,
        },
      });
      expect(cutover.status, `${cutover.stdout}\n${cutover.stderr}`).not.toBe(0);
      expect(cutover.stderr).toMatch(/bootout gui\/501\/dev\.point-labs\.argus failed/);
      expect(cutover.stderr).toMatch(/Not bootstrapping the system daemon/);
      const log = readFileSync(run.launchctlLog, "utf8");
      expect(log).not.toContain("bootstrap system");
      expect(existsSync(agent)).toBe(true);
    } finally {
      cleanup(run);
    }
  });

  it("continues cutover when the gui job is already booted out and its plist is parked", () => {
    const run = renderDaemon("scripts/install-launchdaemon.sh", { SUDO_USER: "mini", SUDO_UID: "501" }, true, {
      separateSudoHome: true,
      includeAgentPlistEnv: false,
    });
    try {
      const state = path.join(run.root, "launchctl.state");
      writeFileSync(state, "");
      writeFileSync(run.launchctlLog, "");
      writeFileSync(
        path.join(run.bin, "launchctl"),
        `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(run.launchctlLog)}
cmd="$1"
shift
case "$cmd" in
  bootout)
    if grep -qxF "$1" ${JSON.stringify(state)}; then
      grep -vxF "$1" ${JSON.stringify(state)} > ${JSON.stringify(state)}.tmp || true
      mv ${JSON.stringify(state)}.tmp ${JSON.stringify(state)}
      exit 0
    fi
    echo "Boot-out failed: 3: No such process" >&2
    exit 3
    ;;
  bootstrap)
    label="$(python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["Label"])' "$2")"
    printf '%s/%s\\n' "$1" "$label" >> ${JSON.stringify(state)}
    ;;
  print)
    if grep -qxF "$1" ${JSON.stringify(state)}; then
      echo "state = running"
      exit 0
    fi
    echo "Could not find service" >&2
    exit 1
    ;;
esac
exit 0
`,
      );
      chmodSync(path.join(run.bin, "launchctl"), 0o755);
      const daemonDir = path.join(run.installRoot, "Library", "LaunchDaemons");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(
        path.join(daemonDir, `${LABEL}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string></dict></plist>
`,
      );
      writeFileSync(
        path.join(daemonDir, `${LOGROTATE_LABEL}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${LOGROTATE_LABEL}</string></dict></plist>
`,
      );
      const agent = path.join(run.sudoHome, "Library", "LaunchAgents", `${LABEL}.plist`);
      const disabledDir = path.join(run.sudoHome, "Library", "LaunchAgents-disabled");
      const disabledAgent = path.join(disabledDir, `${LABEL}.plist`);
      const parkedBody = readFileSync(agent, "utf8");
      mkdirSync(disabledDir, { recursive: true });
      writeFileSync(disabledAgent, parkedBody);
      rmSync(agent);
      const cutover = spawnSync("bash", ["scripts/cutover-launchdaemon.sh"], {
        encoding: "utf8",
        env: {
          PATH: `${run.bin}:${process.env.PATH ?? ""}`,
          HOME: run.home,
          TMPDIR: run.root,
          USER: "root",
          LOGNAME: "root",
          SHELL: "/bin/bash",
          SUDO_USER: "mini",
          SUDO_UID: "501",
          ARGUS_INSTALL_ROOT: run.installRoot,
        },
      });
      expect(cutover.status, `${cutover.stdout}\n${cutover.stderr}`).toBe(0);
      expect(cutover.stdout).toBe(`cut over ${LABEL}\n`);
      expect(existsSync(agent)).toBe(false);
      expect(readFileSync(disabledAgent, "utf8")).toBe(parkedBody);
      const log = readFileSync(run.launchctlLog, "utf8");
      expect(log).toContain(`bootstrap system ${path.join(daemonDir, `${LABEL}.plist`)}`);
      expect(log).toContain(`bootstrap system ${path.join(daemonDir, `${LOGROTATE_LABEL}.plist`)}`);
      expect(log).not.toContain("bootstrap gui/501");
      const loaded = readFileSync(state, "utf8");
      expect(loaded).toBe(`system/${LABEL}\nsystem/${LOGROTATE_LABEL}\n`);
    } finally {
      cleanup(run);
    }
  });

  it("aborts before bootstrap when bootout fails and the parked gui job is still loaded", () => {
    const run = renderDaemon("scripts/install-launchdaemon.sh", { SUDO_USER: "mini", SUDO_UID: "501" }, true, {
      separateSudoHome: true,
      includeAgentPlistEnv: false,
    });
    try {
      const state = path.join(run.root, "launchctl.state");
      writeFileSync(state, "gui/501/dev.point-labs.argus\n");
      writeFileSync(run.launchctlLog, "");
      writeFileSync(
        path.join(run.bin, "launchctl"),
        `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(run.launchctlLog)}
cmd="$1"
shift
case "$cmd" in
  bootout)
    echo "Boot-out failed: 5: Input/output error" >&2
    exit 5
    ;;
  bootstrap)
    label="$(python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["Label"])' "$2")"
    printf '%s/%s\\n' "$1" "$label" >> ${JSON.stringify(state)}
    ;;
  print)
    if grep -qxF "$1" ${JSON.stringify(state)}; then
      echo "state = running"
      exit 0
    fi
    echo "Could not find service" >&2
    exit 1
    ;;
esac
exit 0
`,
      );
      chmodSync(path.join(run.bin, "launchctl"), 0o755);
      const daemonDir = path.join(run.installRoot, "Library", "LaunchDaemons");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(
        path.join(daemonDir, `${LABEL}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string></dict></plist>
`,
      );
      writeFileSync(
        path.join(daemonDir, `${LOGROTATE_LABEL}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${LOGROTATE_LABEL}</string></dict></plist>
`,
      );
      const agent = path.join(run.sudoHome, "Library", "LaunchAgents", `${LABEL}.plist`);
      const disabledDir = path.join(run.sudoHome, "Library", "LaunchAgents-disabled");
      const disabledAgent = path.join(disabledDir, `${LABEL}.plist`);
      const parkedBody = readFileSync(agent, "utf8");
      mkdirSync(disabledDir, { recursive: true });
      writeFileSync(disabledAgent, parkedBody);
      rmSync(agent);
      const cutover = spawnSync("bash", ["scripts/cutover-launchdaemon.sh"], {
        encoding: "utf8",
        env: {
          PATH: `${run.bin}:${process.env.PATH ?? ""}`,
          HOME: run.home,
          TMPDIR: run.root,
          USER: "root",
          LOGNAME: "root",
          SHELL: "/bin/bash",
          SUDO_USER: "mini",
          SUDO_UID: "501",
          ARGUS_INSTALL_ROOT: run.installRoot,
        },
      });
      expect(cutover.status, `${cutover.stdout}\n${cutover.stderr}`).not.toBe(0);
      expect(cutover.stderr).toMatch(/bootout gui\/501\/dev\.point-labs\.argus failed/);
      expect(cutover.stderr).toMatch(/Not bootstrapping the system daemon/);
      const log = readFileSync(run.launchctlLog, "utf8");
      expect(log).not.toContain("bootstrap system");
      expect(existsSync(agent)).toBe(false);
      expect(readFileSync(disabledAgent, "utf8")).toBe(parkedBody);
      expect(readFileSync(state, "utf8")).toBe("gui/501/dev.point-labs.argus\n");
    } finally {
      cleanup(run);
    }
  });
});
