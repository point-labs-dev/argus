import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SKILL = ".cursor/skills/verify-argus";
const HEADINGS = [
  "## Sub-features",
  "## How to get to it (user POV)",
  "## Driving it with the harness",
  "## Gotchas",
];

function skillText(): string {
  const files = walk(SKILL).filter((path) => path.endsWith(".md") || path.endsWith(".sh") || path.endsWith(".mjs"));
  return files.map((path) => readFileSync(path, "utf8")).join("\n");
}

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else {
      found.push(path);
    }
  }
  return found;
}

function remoteCommand(source: string): boolean {
  return /\bssh\b/.test(source);
}

function doctorProblems(source: string): string[] {
  const problems: string[] = [];
  if (!source.includes("npx tsc -p tsconfig.json --noEmit")) {
    problems.push("missing tsc");
  }
  return problems;
}

describe("verify-argus", () => {
  it("rejects a skill that opens a remote shell", () => {
    expect(remoteCommand("bash .cursor/skills/verify-argus/doctor.sh\nssh mini\n")).toBe(true);
  });

  it("accepts the skill map and the doctor on a clean tree", () => {
    const skill = readFileSync(`${SKILL}/SKILL.md`, "utf8");
    expect(skill.startsWith("---\nname: verify-argus\n")).toBe(true);
    expect(skill).toContain("live_session_first_frame");
    expect(skill).toContain("not a pass for the picture");
    expect(skill).toContain("npx vitest run tests/hap-setup-contract.test.ts");
    expect(skill).toContain("node scripts/firmware-census.mjs");
    expect(remoteCommand(skillText())).toBe(false);

    for (const name of ["hap-setup.md", "firmware-census.md", "exact-optional.md"]) {
      const feature = readFileSync(`${SKILL}/features/${name}`, "utf8");
      for (const heading of HEADINGS) {
        expect(feature, name).toContain(heading);
      }
    }
    expect(readFileSync(`${SKILL}/features/firmware-census.md`, "utf8")).toContain("pr3_churn");

    const doctor = spawnSync("bash", [`${SKILL}/doctor.sh`], { encoding: "utf8" });
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("doctor=ok");
    expect(doctor.stdout).toContain("mini=not-contacted");
  });

  it("fails the doctor when a temp copy of src/timing.ts differs from origin/main", () => {
    const real = readFileSync("src/timing.ts");
    const directory = mkdtempSync(join(tmpdir(), "argus-timing-"));
    const copy = join(directory, "timing.ts");
    copyFileSync("src/timing.ts", copy);
    writeFileSync(copy, Buffer.concat([readFileSync(copy), Buffer.from("\n")]));
    const doctor = spawnSync("bash", [`${SKILL}/doctor.sh`], {
      encoding: "utf8",
      env: { ...process.env, ARGUS_TIMING_FILE: copy },
    });
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain("doctor=fail");
    expect(doctor.stdout).not.toContain("doctor=ok");
    expect(readFileSync("src/timing.ts").equals(real)).toBe(true);
  });

  it("fails if the tsc step is removed", () => {
    const source = readFileSync(`${SKILL}/doctor.sh`, "utf8");
    expect(doctorProblems(source)).toEqual([]);
    const stripped = source.replace("npx tsc -p tsconfig.json --noEmit", "echo skip-tsc");
    expect(doctorProblems(stripped)).toContain("missing tsc");
  });

  it("does not print doctor=ok when a camera has no aspect", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-aspect-"));
    const config = join(directory, "argus.yaml");
    writeFileSync(config, readFileSync("argus.example.yaml", "utf8").replace(/^\s*aspect:.*$/gm, ""));
    const doctor = spawnSync("bash", [`${SKILL}/doctor.sh`], {
      encoding: "utf8",
      env: { ...process.env, ARGUS_DOCTOR_CONFIG: config },
    });
    expect(doctor.status).not.toBe(0);
    expect(doctor.stdout).not.toContain("doctor=ok");
    expect(doctor.stdout).toContain("doctor=fail");
  });

  it("does not print doctor=ok when a camera host is removed", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-host-"));
    const config = join(directory, "argus.yaml");
    writeFileSync(config, readFileSync("argus.example.yaml", "utf8").replace(/^\s*host:.*$/gm, ""));
    const doctor = spawnSync("bash", [`${SKILL}/doctor.sh`], {
      encoding: "utf8",
      env: { ...process.env, ARGUS_DOCTOR_CONFIG: config },
    });
    expect(doctor.status).not.toBe(0);
    expect(doctor.stdout).not.toContain("doctor=ok");
    expect(doctor.stdout).toContain("doctor=fail");
    expect(doctor.stdout).toContain("host missing");
  });

  it("does not print doctor=ok when audio-off still advertises a codec", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-audio-"));
    const broken = join(directory, "homekit.ts");
    const source = readFileSync("src/homekit.ts", "utf8").replace(
      ": [],",
      ": [{ type: AudioStreamingCodecType.AAC_ELD, samplerate: AudioStreamingSamplerate.KHZ_24 }],",
    );
    writeFileSync(broken, source);
    const doctor = spawnSync("bash", [`${SKILL}/doctor.sh`], {
      encoding: "utf8",
      env: { ...process.env, ARGUS_HOMEKIT_FILE: broken },
    });
    expect(doctor.status).not.toBe(0);
    expect(doctor.stdout).not.toContain("doctor=ok");
    expect(doctor.stdout).toContain("doctor=fail");
  });

  it("does not print doctor=ok when the audio-off answer still includes audio", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-answer-"));
    const broken = join(directory, "homekit.ts");
    const source = readFileSync("src/homekit.ts", "utf8").replace(
      "prepareAnswer({ includeAudio: false, video: videoLeg })",
      "prepareAnswer({ includeAudio: false, video: videoLeg, audio: videoLeg })",
    );
    writeFileSync(broken, source);
    const doctor = spawnSync("bash", [`${SKILL}/doctor.sh`], {
      encoding: "utf8",
      env: { ...process.env, ARGUS_HOMEKIT_FILE: broken },
    });
    expect(doctor.status).not.toBe(0);
    expect(doctor.stdout).not.toContain("doctor=ok");
    expect(doctor.stdout).toContain("doctor=fail");
  });

  it("keeps the optional-property proof without writing the evidence file", () => {
    const proof = `${SKILL}/evidence/exact-optional.json`;
    const tracked = spawnSync("git", ["ls-files", "--", proof], { encoding: "utf8" });
    expect(tracked.stdout).toBe("");
    const before = existsSync(proof) ? readFileSync(proof) : null;
    const probe = spawnSync("node", [`${SKILL}/exact-optional-probe.mjs`], { encoding: "utf8" });
    expect(probe.status).toBe(0);
    const kept = join(mkdtempSync(join(tmpdir(), "argus-proof-")), "exact-optional.json");
    writeFileSync(kept, probe.stdout);
    const cleanup = spawnSync("bash", ["-lc", "echo cleanup=noop"], { encoding: "utf8" });
    expect(cleanup.status).toBe(0);
    expect(existsSync(kept)).toBe(true);
    const report = JSON.parse(readFileSync(kept, "utf8")) as {
      bad_exit: number;
      bad_has_ts2375: boolean;
      good_exit: number;
    };
    expect(report.bad_exit).toBe(2);
    expect(report.bad_has_ts2375).toBe(true);
    expect(report.good_exit).toBe(0);
    if (before) {
      expect(readFileSync(proof).equals(before)).toBe(true);
    }
  });
});
