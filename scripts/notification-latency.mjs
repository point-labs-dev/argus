#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { formatStageReport } from "../dist/timing.js";

const input = process.argv[2];
const logContents = !input || input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
process.stdout.write(formatStageReport(logContents));
