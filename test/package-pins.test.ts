import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

// Every dependency is pinned exactly, like .bun-version pins the toolchain:
// the managed dependabot-bun-lockfile workflow deletes bun.lock and
// re-resolves from scratch on every Dependabot PR, so a range specifier
// floats to its latest release there, untested against main (zod ^4.4.3
// floating to 4.5.4 broke every open Dependabot PR at once). `bun add`
// writes "^" by default; this test catches the eroded pin.
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

describe("package.json dependency pins", () => {
  for (const field of ["dependencies", "devDependencies"] as const) {
    test(`every ${field} entry is an exact version`, () => {
      const entries = Object.entries(pkg[field] as Record<string, string>);
      expect(entries.length).toBeGreaterThan(0);
      for (const [name, spec] of entries) {
        expect(EXACT_VERSION.test(spec), `${name}: "${spec}" is not an exact version`).toBe(true);
      }
    });
  }
});
