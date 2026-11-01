#!/usr/bin/env node
import { runCli } from "./program.js";

process.exitCode = await runCli(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
