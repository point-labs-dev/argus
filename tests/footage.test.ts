import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runFootage, type FootageRequest } from "../src/footage.js";

const root = fileURLToPath(new URL("./fixtures/footage/", import.meta.url));
const configPath = path.join(root, "argus.yaml");
const devicesPath = path.join(root, "devices");
const from = "2026-10-05T18:00:00";
const to = "2026-10-06T08:00:00";

const expectedReport = [
  "camera: Front L",
  "device: 10.0.0.13",
  "channel: 2",
  "schedule: continuous",
  "free: 51200MB",
  "files: 2",
  "",
  "camera: Front R",
  "device: 10.0.0.13",
  "channel: 3",
  "schedule: continuous",
  "free: 51200MB",
  "files: no files",
  "",
  "camera: Garage Door",
  "device: 10.0.0.21",
  "channel: 0",
  "schedule: off",
  "free: no storage",
  "files: no files",
  "",
].join("\n");

const searchWindow = {
  onlyStatus: 0,
  streamType: "main",
  StartTime: { year: 2026, mon: 10, day: 5, hour: 18, min: 0, sec: 0 },
  EndTime: { year: 2026, mon: 10, day: 6, hour: 8, min: 0, sec: 0 },
};

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

function searchRequests(requests: readonly FootageRequest[], host: string) {
  return requests.filter((request) => request.cmd === "Search" && request.host === host);
}

describe("footage status", () => {
  it("prints schedule, free space, file presence, and no storage", async () => {
    const cap = capture();
    const result = await runFootage(
      ["--config", configPath, "--fixture", devicesPath, "--from", from, "--to", to],
      cap.io,
    );

    expect(result.exitCode).toBe(0);
    expect(cap.read().stderr).toBe("");
    expect(cap.read().stdout).toBe(expectedReport);
    expect(existsSync(path.join(root, "not-written"))).toBe(false);
    expect(searchRequests(result.requests, "10.0.0.13")).toEqual([
      { cmd: "Search", host: "10.0.0.13", param: { Search: { channel: 2, ...searchWindow } } },
      { cmd: "Search", host: "10.0.0.13", param: { Search: { channel: 3, ...searchWindow } } },
    ]);
    expect(searchRequests(result.requests, "10.0.0.21")).toEqual([
      { cmd: "Search", host: "10.0.0.21", param: { Search: { channel: 0, ...searchWindow } } },
    ]);
  });

  it("fails if the request list contains SetRec, Format, or Reboot", async () => {
    const cap = capture();
    const result = await runFootage(
      ["--config", configPath, "--fixture", devicesPath, "--from", from, "--to", to],
      cap.io,
    );
    const cmds = result.requests.map((request) => request.cmd);
    const allowed = ["Login", "GetHddInfo", "GetRec", "Search"];

    expect(result.exitCode).toBe(0);
    expect(cap.read().stdout).toContain("schedule: continuous");
    expect(cap.read().stdout).toContain("free: 51200MB");
    expect(cap.read().stdout).toContain("free: no storage");
    expect(cap.read().stdout).toContain("files: 2");
    expect(cap.read().stdout).toContain("files: no files");
    expect(cmds).toEqual(expect.arrayContaining(allowed));
    expect(cmds).not.toContain("SetRec");
    expect(cmds).not.toContain("Format");
    expect(cmds).not.toContain("Reboot");
    for (const cmd of cmds) {
      expect(allowed).toContain(cmd);
    }
  });

  it("exits non-zero when a camera cannot be queried", async () => {
    const cap = capture();
    const result = await runFootage(
      ["--config", path.join(root, "argus-down.yaml"), "--fixture", devicesPath, "--from", from, "--to", to],
      cap.io,
    );

    expect(result.exitCode).not.toBe(0);
    expect(cap.read().stdout).not.toContain("no files");
    expect(cap.read().stdout).not.toContain("no storage");
    expect(cap.read().stdout).not.toContain("Backyard");
    expect(cap.read().stderr).toContain("Backyard");
  });
});
