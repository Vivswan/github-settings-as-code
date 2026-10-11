/**
 * The shared entry (.github/scripts/lib/entry.ts) as a workflow step sees it: a mistyped or missing subcommand ends
 * the step red before any handler runs, naming the script and its commands, and a handler's thrown refusal ends it
 * red as `<script> <command>: <message>`. No step test runs a wrong subcommand, so without this a dispatcher that
 * ran nothing and exited 0 would pass every step test green.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";
import { runStep } from "./step-fixture.js";

test.each<[name: string, script: string, args: string[], stderr: string]>([
  ["no subcommand", "post-green-steps", [], "post-green-steps: no command given; expected probe\n"],
  [
    "a mistyped subcommand",
    "post-green-steps",
    ["porbe"],
    'post-green-steps: unknown command "porbe"; expected probe\n',
  ],
  [
    "a subcommand that is a key every object inherits",
    "post-green-steps",
    ["constructor"],
    'post-green-steps: unknown command "constructor"; expected probe\n',
  ],
  [
    "a handler's thrown refusal",
    "release-pipeline",
    ["npm-publish", "canary"],
    'release-pipeline npm-publish: npm-publish takes the channel, next or stable, not "canary"\n',
  ],
])("%s ends the step red with the refusal alone on stderr", (_name, script, args, stderr) =>
  withTempDir("entry-", (dir) => {
    expect(runStep(script, ROOT, join(dir, "runner-temp"), {}, ...args)).toEqual({
      stdout: "",
      stderr,
      status: 1,
      outputs: [],
    });
  }),
);
