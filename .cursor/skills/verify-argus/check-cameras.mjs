import { readFileSync } from "node:fs";
import { parse } from "yaml";

const ASPECTS = new Set(["16:9", "4:3"]);

export function cameraConfigProblems(raw) {
  const problems = [];
  let doc;
  try {
    doc = typeof raw === "string" ? parse(raw) : raw;
  } catch (error) {
    return [`config yaml: ${error instanceof Error ? error.message : String(error)}`];
  }
  const cameras = doc && doc.cameras;
  if (!Array.isArray(cameras) || cameras.length === 0) {
    return ["no cameras"];
  }
  cameras.forEach((camera, index) => {
    const aspect = camera && camera.aspect;
    if (!ASPECTS.has(aspect)) {
      const name = camera && camera.name ? camera.name : index;
      problems.push(`${name} aspect missing or not 16:9 or 4:3`);
    }
  });
  return problems;
}

function main() {
  const configPath = process.env.ARGUS_DOCTOR_CONFIG || "argus.example.yaml";
  const problems = cameraConfigProblems(readFileSync(configPath, "utf8"));
  if (problems.length === 0) return;
  process.stdout.write(problems.map((problem) => `camera=${problem}`).join("\n") + "\n");
  process.exitCode = 1;
}

const invoked = process.argv[1] && process.argv[1].endsWith("check-cameras.mjs");
if (invoked) main();
