import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["sample.ts"],
};

function compile(source: string): { status: number; text: string } {
  const directory = mkdtempSync(join(tmpdir(), "argus-exact-optional-"));
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  writeFileSync(join(directory, "sample.ts"), source);
  const result = spawnSync(
    "npx",
    ["tsc", "-p", join(directory, "tsconfig.json"), "--pretty", "false", "--noEmit"],
    { encoding: "utf8" },
  );
  return { status: result.status ?? 1, text: `${result.stdout}${result.stderr}` };
}

describe("exactOptionalPropertyTypes", () => {
  it("stays enabled on the project compiler", () => {
    const source = readFileSync("tsconfig.json", "utf8");
    expect(source).toContain('"exactOptionalPropertyTypes": true');
  });

  it("rejects a localAddress assigned from string | undefined", () => {
    const result = compile(
      [
        "export interface LiveFfmpegInput {",
        "  localAddress?: string;",
        "}",
        "export function build(bindAddress: string | undefined): LiveFfmpegInput {",
        "  return { localAddress: bindAddress };",
        "}",
        "",
      ].join("\n"),
    );
    expect(result.status).toBe(2);
    expect(result.text).toContain("TS2375");
  });

  it("accepts a localAddress that is omitted when absent", () => {
    const result = compile(
      [
        "export interface LiveFfmpegInput {",
        "  localAddress?: string;",
        "}",
        "export function build(bindAddress: string | undefined): LiveFfmpegInput {",
        "  return bindAddress === undefined ? {} : { localAddress: bindAddress };",
        "}",
        "",
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.text).not.toContain("error TS");
  });
});
