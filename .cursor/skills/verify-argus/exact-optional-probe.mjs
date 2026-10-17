import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

function compile(source) {
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

const bad = compile(
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
const good = compile(
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

const report = {
  bad_exit: bad.status,
  bad_has_ts2375: bad.text.includes("TS2375"),
  good_exit: good.status,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.bad_exit !== 2 || !report.bad_has_ts2375 || report.good_exit !== 0) {
  process.exitCode = 1;
}
