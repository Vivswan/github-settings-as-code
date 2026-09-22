import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

// A from-scratch `bun install` (nightly's float-canary) honors every range in package.json, so a range specifier floats there untested against
// main (zod ^4.4.3 floating to 4.5.4 broke every open Dependabot PR when a lockfile-regenerating workflow still existed). Exact pins leave only
// transitive ranges to float. `bun add` writes "^" by default.
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

describe("package.json dependency pins", () => {
  test("every entry of every dependency field is an exact version", () => {
    const present = DEPENDENCY_FIELDS.filter((field) => field in pkg);
    // The fields the sweep walked, so a renamed field cannot pass vacuously.
    expect(present).toEqual(["dependencies", "devDependencies"]);
    const loose = present.flatMap((field) =>
      Object.entries((pkg as Record<string, unknown>)[field] as Record<string, string>)
        .filter(([, spec]) => !EXACT_VERSION.test(spec))
        .map(([name, spec]) => `${field}.${name}: "${spec}"`),
    );
    expect(loose).toEqual([]);
  });

  // The control on the pattern: one specifier per anchor and per optional group it carries, so a loosened or regrouped pattern cannot pass the
  // sweep above by accepting everything or by rejecting a pre-release pin.
  test.each([
    ["^1.2.3", false],
    ["1.2.x", false],
    ["1.2.3 || 2.0.0", false],
    ["1.2.3-rc.1", true],
    ["1.2.3+build.5", true],
    ["1.2.3-rc.1+build.5", true],
  ])("the exactness check answers %s with %p", (spec, exact) => {
    expect(EXACT_VERSION.test(spec)).toBe(exact);
  });
});
