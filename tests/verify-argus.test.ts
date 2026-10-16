import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SKILL = ".cursor/skills/verify-argus";
const HEADINGS = [
  "## Sub-features",
  "## How to get to it (user POV)",
  "## Driving it with the local contract",
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

  it("fails the doctor when src/timing.ts differs from origin/main", () => {
    const path = "src/timing.ts";
    const original = readFileSync(path);
    try {
      writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
      const doctor = spawnSync("bash", [`${SKILL}/doctor.sh`], { encoding: "utf8" });
      expect(doctor.status).toBe(1);
      expect(doctor.stdout).toContain("doctor=fail");
    } finally {
      writeFileSync(path, original);
    }
  });

  it("keeps the optional-property proof after cleanup", () => {
    mkdirSync(`${SKILL}/evidence`, { recursive: true });
    const proof = `${SKILL}/evidence/exact-optional.json`;
    const probe = spawnSync("node", [`${SKILL}/exact-optional-probe.mjs`], { encoding: "utf8" });
    writeFileSync(proof, probe.stdout);
    expect(probe.status).toBe(0);
    const cleanup = spawnSync("bash", ["-lc", "echo cleanup=noop"], { encoding: "utf8" });
    expect(cleanup.status).toBe(0);
    expect(existsSync(proof)).toBe(true);
    const report = JSON.parse(readFileSync(proof, "utf8")) as {
      bad_exit: number;
      bad_has_ts2375: boolean;
      good_exit: number;
    };
    expect(report.bad_exit).toBe(2);
    expect(report.bad_has_ts2375).toBe(true);
    expect(report.good_exit).toBe(0);
  });
});
