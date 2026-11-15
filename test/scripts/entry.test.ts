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

test.each<
  [name: string, script: string, args: string[], stderr: string, env?: Record<string, string>]
>([
  [
    "no subcommand",
    "auto-format-steps",
    [],
    "auto-format-steps: no command given; expected format | push\n",
  ],
  [
    "a mistyped subcommand",
    "auto-format-steps",
    ["lint"],
    'auto-format-steps: unknown command "lint"; expected format | push\n',
  ],
  [
    "a subcommand that is a key every object inherits",
    "auto-format-steps",
    ["constructor"],
    'auto-format-steps: unknown command "constructor"; expected format | push\n',
  ],
  [
    "a handler's thrown refusal",
    "release-pipeline",
    ["resolve-source"],
    'release-pipeline resolve-source: the handed tag "v2.1.0" is not source-vX.Y.Z, the name release-please gives a release here; refusing to derive a version tag from it.\n' +
      'Fix release-please-config.json by PR: "include-component-in-tag": true at the top, "component": "source" on package ".".\n',
    { MARKER: "v2.1.0" },
  ],
])(
  "%s ends the step red with the refusal alone on stderr",
  (_name, script, args, stderr, env = {}) =>
    withTempDir("entry-", (dir) => {
      expect(runStep(script, ROOT, join(dir, "runner-temp"), env, ...args)).toEqual({
        stdout: "",
        stderr,
        status: 1,
        outputs: [],
      });
    }),
);
