import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function workflowProblems(source: string): string[] {
  const problems: string[] = [];
  if (!source.includes("npx tsc -p tsconfig.json --noEmit")) {
    problems.push("missing src typecheck");
  }
  if (!source.includes("npx tsc -p tsconfig.check.json --noEmit")) {
    problems.push("missing test typecheck");
  }
  if (!source.includes("npx vitest run")) {
    problems.push("missing vitest");
  }
  if (!source.includes("node scripts/firmware-census.mjs")) {
    problems.push("missing census");
  }
  if (/\bssh\b/.test(source) || /\bdeploy\b/.test(source)) {
    problems.push("remote command");
  }
  return problems;
}

describe("ci workflow", () => {
  it("rejects a workflow that shells out to a remote host", () => {
    const sample = [
      "run: npx tsc -p tsconfig.json --noEmit",
      "run: npx tsc -p tsconfig.check.json --noEmit",
      "run: npx vitest run",
      "run: node scripts/firmware-census.mjs",
      "run: ssh mini deploy",
    ].join("\n");
    expect(workflowProblems(sample)).toContain("remote command");
  });

  it("accepts the checked-in workflow", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflowProblems(source)).toEqual([]);
  });
});
