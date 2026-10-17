import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const KEPT = [
  "README.md",
  "SPEC.md",
  "LEARNINGS.md",
  "PROJECT.md",
  "LATENCY.md",
  "TESTING.md",
  "TELEMETRY-QUICK-REF.md",
  "docs/camera-health.md",
  "docs/invariants.md",
  "progress/README.md",
  "scenarios/README.md",
];

const ROOT_MARKDOWN_ALLOWLIST = ["README.md", "SPEC.md", "LEARNINGS.md", "PROJECT.md"];

function newRootMarkdownProblems(added: string[]): string[] {
  return added.filter((path) => {
    if (path.includes("/") || !path.endsWith(".md")) return false;
    return !ROOT_MARKDOWN_ALLOWLIST.includes(path);
  });
}

function invariantsProblems(source: string): string[] {
  const lineCount = source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
  const problems: string[] = [];
  if (lineCount >= 80) {
    problems.push("too long");
  }
  if (!source.includes("ARGUS_FIRMWARE_REVISION")) {
    problems.push("missing constant");
  }
  if (source.includes("ARGUS_FIRMWARE_REVISION =")) {
    problems.push("assigns a version");
  }
  if (!source.includes("live_session_first_frame") || !source.includes("not the painted picture")) {
    problems.push("missing picture rule");
  }
  return problems;
}

describe("stream setup invariants", () => {
  it("rejects a note that assigns a firmware version", () => {
    const sample = [
      "# Stream setup invariants",
      "",
      "Bump ARGUS_FIRMWARE_REVISION when the ladder changes.",
      'export const ARGUS_FIRMWARE_REVISION = "1.3.0";',
      "",
      "A live_session_first_frame log line is not the painted picture.",
      "",
    ].join("\n");
    expect(invariantsProblems(sample)).toContain("assigns a version");
  });

  it("rejects a new root markdown file outside the allowlist", () => {
    expect(newRootMarkdownProblems(["DIMENSION-PAD-FIX.md"])).toEqual(["DIMENSION-PAD-FIX.md"]);
    expect(newRootMarkdownProblems(["README.md", "docs/invariants.md"])).toEqual([]);
    expect(newRootMarkdownProblems(["LATENCY.md"])).toEqual(["LATENCY.md"]);
  });

  it("accepts docs/invariants.md and keeps the durable notes", () => {
    const source = readFileSync("docs/invariants.md", "utf8");
    expect(invariantsProblems(source)).toEqual([]);
    for (const path of KEPT) {
      expect(existsSync(path), path).toBe(true);
    }
    const added = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", "origin/main"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => path.length > 0);
    expect(newRootMarkdownProblems(added)).toEqual([]);
  });
});
