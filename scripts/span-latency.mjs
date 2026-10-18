#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const reportUrl = new URL("../dist/span-report.js", import.meta.url);
if (!existsSync(reportUrl)) {
  process.stderr.write("span-latency: build first. Missing dist/span-report.js. Run npm run build.\n");
  process.exit(1);
}

const { formatSpanReport } = await import(reportUrl.href);
const input = process.argv[2];
const logContents = !input || input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
process.stdout.write(formatSpanReport(logContents));
