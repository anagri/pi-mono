#!/usr/bin/env node
import { runCli } from "./host/cli.js";

process.title = "bodhi-pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

await runCli(process.argv.slice(2));
