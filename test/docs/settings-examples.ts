/**
 * The one validation body every documented settings example runs through:
 * full document validation plus the repository special-key sweep. Shared by
 * the README and guides example tests, which keep their own block discovery.
 */

import { expect } from "bun:test";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { SPECIAL_KEYS } from "../../src/sections/repository/index.js";

const silentIo: Io = { annotate: () => {}, log: () => {}, mask: () => {} };

/** Assert `doc` validates and its repository special-looking keys are real. */
export function assertValidSettingsExample(doc: unknown, label: string): void {
  const invalid = validateSettingsDoc(doc, label, new Set(), silentIo);
  expect(
    "error" in invalid ? invalid.error : null,
    `${label} failed validation: ${"error" in invalid ? invalid.error : ""}`,
  ).toBeNull();
  const repository = (doc as Record<string, unknown>).repository;
  if (repository && typeof repository === "object") {
    for (const key of Object.keys(repository)) {
      if (key.startsWith("enable_") || key === "topics") {
        expect(
          SPECIAL_KEYS.has(key),
          `${label} uses repository.${key}, which looks like a special key but is not in SPECIAL_KEYS`,
        ).toBe(true);
      }
    }
  }
}
