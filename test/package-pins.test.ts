import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

// Every dependency is pinned exactly, like .bun-version pins the toolchain:
// the managed dependabot-bun-lockfile workflow deletes bun.lock and
// re-resolves from scratch on every Dependabot PR, so a range specifier
// floats to its latest release there, untested against main (zod ^4.4.3
// floating to 4.5.4 broke every open Dependabot PR at once). `bun add`
// writes "^" by default; this test catches the eroded pin.
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

describe("package.json dependency pins", () => {
  test("at least one dependency field exists (the tripwire is not vacuous)", () => {
    expect(DEPENDENCY_FIELDS.filter((f) => f in pkg).length).toBeGreaterThan(0);
  });

  for (const field of DEPENDENCY_FIELDS) {
    test(`every ${field} entry is an exact version`, () => {
      const entries = Object.entries(
        ((pkg as Record<string, unknown>)[field] ?? {}) as Record<string, string>,
      );
      for (const [name, spec] of entries) {
        expect(EXACT_VERSION.test(spec), `${name}: "${spec}" is not an exact version`).toBe(true);
      }
    });
  }

  test("the exactness check rejects every range and non-registry form", () => {
    const forbidden = [
      "^1.2.3",
      "~1.2.3",
      ">=1.2.3",
      "<2.0.0",
      "=1.2.3",
      "1.2.x",
      "1.x",
      "*",
      "1.2.3 || 2.0.0",
      "latest",
      "workspace:*",
      "npm:other@1.2.3",
      "git+https://github.com/o/r.git",
      "https://example.com/pkg.tgz",
      "file:../local",
    ];
    for (const spec of forbidden) {
      expect(EXACT_VERSION.test(spec), `"${spec}" must be rejected`).toBe(false);
    }
  });

  test("the exactness check accepts canonical exact forms", () => {
    for (const spec of ["1.2.3", "0.0.1", "1.2.3-rc.1", "1.2.3+build.5", "1.2.3-rc.1+build.5"]) {
      expect(EXACT_VERSION.test(spec), `"${spec}" must be accepted`).toBe(true);
    }
  });
});
