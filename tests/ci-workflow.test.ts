import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CHECKS = [
  "npx tsc -p tsconfig.json --noEmit",
  "npx tsc -p tsconfig.check.json --noEmit",
  "npx vitest run",
];

function workflowProblems(source: string): string[] {
  const problems: string[] = [];
  if (!source.includes("./verify")) {
    problems.push("missing verify");
  }
  if (!source.includes('fetch-depth: 0')) {
    problems.push("missing fetch-depth");
  }
  if (!source.includes('node-version: "24.22.1"')) {
    problems.push("missing node");
  }
  if (!source.includes("node scripts/firmware-census.mjs")) {
    problems.push("missing census");
  }
  const runs = source.split("\n").filter((line) => line.includes("run:"));
  for (const command of CHECKS) {
    if (runs.some((line) => line.includes(command))) {
      problems.push("duplicated check");
    }
  }
  if (/\bssh\b/.test(source) || /\bdeploy\b/.test(source)) {
    problems.push("remote command");
  }
  return problems;
}

describe("ci workflow", () => {
  it("rejects a workflow that shells out to a remote host", () => {
    const sample = [
      "fetch-depth: 0",
      'node-version: "24.22.1"',
      "run: ./verify",
      "run: node scripts/firmware-census.mjs",
      "run: ssh mini deploy",
    ].join("\n");
    expect(workflowProblems(sample)).toContain("remote command");
  });

  it("accepts the checked-in workflow", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflowProblems(source)).toEqual([]);
    const verify = readFileSync("verify", "utf8");
    for (const command of CHECKS) {
      expect(verify).toContain(command);
    }
    expect(source).not.toContain("run: npx vitest run");
  });
});
