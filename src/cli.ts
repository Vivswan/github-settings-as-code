#!/usr/bin/env node
/**
 * The bin entry (lib/pkg/cli.js is built from this file, shebang kept):
 * run the command line and map its return code to the process exit code.
 * Everything else lives in src/cli/.
 */

import { main, processHost } from "./cli/program.js";

const streams = { stdout: process.stdout, stderr: process.stderr };
process.exitCode = await main(process.argv, { host: processHost(), streams });
