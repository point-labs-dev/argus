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
    const name = camera && camera.name ? camera.name : index;
    const aspect = camera && camera.aspect;
    if (!ASPECTS.has(aspect)) {
      problems.push(`${name} aspect missing or not 16:9 or 4:3`);
    }
    const host = camera && camera.host;
    if (typeof host !== "string" || host.trim() === "") {
      problems.push(`${name} host missing`);
    }
  });
  return problems;
}

function prepareAnswerCalls(source) {
  const calls = [];
  const token = "prepareAnswer(";
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf(token, index);
    if (start < 0) break;
    let depth = 0;
    let end = start + token.length - 1;
    for (let i = end; i < source.length; i += 1) {
      const char = source[i];
      if (char === "(" || char === "{") depth += 1;
      else if (char === ")" || char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(source.slice(start, end + 1));
    index = end + 1;
  }
  return calls;
}

export function audioProblems(source) {
  const problems = [];
  const codecGate = source.match(/codecs:\s*includeAudio\s*\?[\s\S]*?\n\s*:\s*(\[[\s\S]*?\]),/);
  if (!codecGate) {
    problems.push("audio codecs are not gated on includeAudio");
  } else if (!/^\[\s*\]$/.test(codecGate[1].trim())) {
    problems.push("audio-off still advertises codecs");
  }
  const falseAnswers = prepareAnswerCalls(source).filter((call) => /includeAudio:\s*false/.test(call));
  if (falseAnswers.length === 0) {
    problems.push("audio-off answer is missing");
  } else if (falseAnswers.some((call) => /\baudio\s*:/.test(call))) {
    problems.push("audio-off answer still includes audio");
  }
  return problems;
}

function main() {
  const configPath = process.env.ARGUS_DOCTOR_CONFIG || "argus.example.yaml";
  const homekitPath = process.env.ARGUS_HOMEKIT_FILE || "src/homekit.ts";
  const problems = [
    ...cameraConfigProblems(readFileSync(configPath, "utf8")),
    ...audioProblems(readFileSync(homekitPath, "utf8")),
  ];
  if (problems.length === 0) return;
  process.stdout.write(problems.map((problem) => `camera=${problem}`).join("\n") + "\n");
  process.exitCode = 1;
}

const invoked = process.argv[1] && process.argv[1].endsWith("check-cameras.mjs");
if (invoked) main();
