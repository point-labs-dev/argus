#!/usr/bin/env node

import { runFootage } from "./footage.js";

async function main(): Promise<void> {
  const result = await runFootage(process.argv.slice(2));
  process.exitCode = result.exitCode;
}

void main();
