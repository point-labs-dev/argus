import { describe, expect, it } from "vitest";

import { createStderrBudget, envFlag } from "../src/child-log.js";

describe("envFlag", () => {
  it("accepts 1/true only", () => {
    expect(envFlag("1")).toBe(true);
    expect(envFlag("true")).toBe(true);
    expect(envFlag("0")).toBe(false);
    expect(envFlag("")).toBe(false);
    expect(envFlag(undefined)).toBe(false);
  });
});

describe("createStderrBudget", () => {
  const collect = (opts: { maxLines: number; verbose?: boolean }) => {
    const lines: string[] = [];
    const budget = createStderrBudget({
      maxLines: opts.maxLines,
      verbose: opts.verbose ?? false,
      log: (line) => lines.push(line),
    });
    return { lines, budget };
  };

  it("forwards the first maxLines lines and suppresses the rest", () => {
    const { lines, budget } = collect({ maxLines: 3 });
    for (let i = 1; i <= 10; i++) budget.onChunk(`line ${i}\n`);
    expect(lines).toEqual(["line 1", "line 2", "line 3"]);
    expect(budget.suppressedLines()).toBe(7);
    expect(budget.summary()).toContain("suppressed 7 stderr lines");
  });

  it("splits multi-line chunks so every line is counted and prefixed individually", () => {
    // The 42 GB incident log had raw unprefixed [hevc @ ...] lines exactly
    // because a chunk carrying many lines was logged with a single prefix.
    const { lines, budget } = collect({ maxLines: 10 });
    budget.onChunk("first\nsecond\nthird\n");
    expect(lines).toEqual(["first", "second", "third"]);
    expect(budget.suppressedLines()).toBe(0);
  });

  it("reassembles lines split across chunk boundaries", () => {
    const { lines, budget } = collect({ maxLines: 10 });
    budget.onChunk("partial star");
    budget.onChunk("t\nnext line\n");
    expect(lines).toEqual(["partial start", "next line"]);
  });

  it("flush emits a trailing partial line", () => {
    const { lines, budget } = collect({ maxLines: 10 });
    budget.onChunk("no trailing newline");
    expect(lines).toEqual([]);
    budget.flush();
    expect(lines).toEqual(["no trailing newline"]);
  });

  it("verbose forwards everything and reports no summary", () => {
    const { lines, budget } = collect({ maxLines: 1, verbose: true });
    for (let i = 1; i <= 50; i++) budget.onChunk(`line ${i}\n`);
    expect(lines).toHaveLength(50);
    expect(budget.suppressedLines()).toBe(0);
    expect(budget.summary()).toBeUndefined();
  });

  it("ignores blank lines and accepts Buffer chunks", () => {
    const { lines, budget } = collect({ maxLines: 5 });
    budget.onChunk(Buffer.from("real line\n\n\n"));
    expect(lines).toEqual(["real line"]);
    expect(budget.suppressedLines()).toBe(0);
  });
});
