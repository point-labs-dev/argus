// Prototype. Not the change to merge.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "argus-exact-optional-"));
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["bad.ts", "good.ts"],
    },
    null,
    2,
  ),
);
writeFileSync(
  join(dir, "bad.ts"),
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
writeFileSync(
  join(dir, "good.ts"),
  [
    "export interface LiveFfmpegInput {",
    "  localAddress?: string;",
    "}",
    "export function build(bindAddress: string | undefined): LiveFfmpegInput {",
    "  return bindAddress === undefined ? {} : { localAddress: bindAddress };",
    "}",
    "",
    "export type VideoAnswer = {",
    "  port: number;",
    "  ssrc: number;",
    "  srtp_key: string;",
    "  srtp_salt: string;",
    "};",
    "export type PrepareAnswer =",
    "  | { includeAudio: false; video: VideoAnswer }",
    "  | { includeAudio: true; video: VideoAnswer; audio: VideoAnswer };",
    "",
  ].join("\n"),
);

const both = spawnSync(
  "npx",
  ["tsc", "-p", join(dir, "tsconfig.json"), "--pretty", "false", "--noEmit"],
  { encoding: "utf8" },
);
const badOnlyDir = mkdtempSync(join(tmpdir(), "argus-exact-optional-bad-"));
writeFileSync(join(badOnlyDir, "tsconfig.json"), readConfig(dir, ["bad.ts"]));
writeFileSync(join(badOnlyDir, "bad.ts"), readFile(join(dir, "bad.ts")));
const bad = spawnSync(
  "npx",
  ["tsc", "-p", join(badOnlyDir, "tsconfig.json"), "--pretty", "false", "--noEmit"],
  { encoding: "utf8" },
);
const goodOnlyDir = mkdtempSync(join(tmpdir(), "argus-exact-optional-good-"));
writeFileSync(join(goodOnlyDir, "tsconfig.json"), readConfig(dir, ["good.ts"]));
writeFileSync(join(goodOnlyDir, "good.ts"), readFile(join(dir, "good.ts")));
const good = spawnSync(
  "npx",
  ["tsc", "-p", join(goodOnlyDir, "tsconfig.json"), "--pretty", "false", "--noEmit"],
  { encoding: "utf8" },
);

function readFile(path) {
  return spawnSync("cat", [path], { encoding: "utf8" }).stdout;
}
function readConfig(from, include) {
  const base = JSON.parse(readFile(join(from, "tsconfig.json")));
  base.include = include;
  return JSON.stringify(base, null, 2);
}

const report = {
  prototype: true,
  bad_exit: bad.status,
  bad_stderr: (bad.stdout + bad.stderr).trim(),
  good_exit: good.status,
  good_stderr: (good.stdout + good.stderr).trim(),
  both_exit: both.status,
};
console.log(JSON.stringify(report, null, 2));
