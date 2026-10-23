#!/usr/bin/env node
// Read-only. Prints recording_start_to_first_fragment n, p50, and p90 from a
// serve log. Does not restart anything and does not print the log.
import { readFileSync } from "node:fs";

import { formatNotificationReport } from "./notification-latency.mjs";

export function recordingFirstFragmentLine(logContents) {
  const report = formatNotificationReport(logContents);
  const line = report.split("\n").find((item) => item.startsWith("recording_start_to_first_fragment "));
  if (!line || !line.includes("p50=")) return "recording_start_to_first_fragment n=0\n";
  const n = line.match(/n=(\d+)/)?.[1] ?? "0";
  const p50 = line.match(/p50=([0-9.]+)/)?.[1] ?? "0";
  const p90 = line.match(/p90=([0-9.]+)/)?.[1] ?? "0";
  return `recording_start_to_first_fragment n=${n} p50=${p50} p90=${p90}\n`;
}

const invoked = process.argv[1] && process.argv[1].endsWith("recording-first-fragment.mjs");
if (invoked) {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write("recording-first-fragment: needs a log path\n");
    process.exitCode = 2;
  } else {
    let logContents;
    try {
      logContents = readFileSync(input, "utf8");
    } catch {
      process.stderr.write("recording-first-fragment: cannot read log\n");
      process.exitCode = 1;
    }
    if (logContents !== undefined) process.stdout.write(recordingFirstFragmentLine(logContents));
  }
}
