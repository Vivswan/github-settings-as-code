/**
 * The seal's symbol and the one capability that opens it, kept apart from the
 * brand so biome's noRestrictedImports can confine this module's importers to
 * the brand itself and the projections (biome.json overrides, test/private.test.ts).
 */

import type { Private } from "./private.js";

export const PRIVATE: unique symbol = Symbol("private");

export function revealPrivate<T>(value: Private<T>): T {
  return value[PRIVATE];
}
