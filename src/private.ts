/**
 * The seal on private-repository data. A sealed value is NOT a T, so no sink
 * or template accepts it; only the projections allowed to import
 * private-open.ts can open it.
 */

import { PRIVATE } from "./private-open.js";

export interface Private<T> {
  readonly [PRIVATE]: T;
}

/** Seal a value at the boundary where it is learned to be private. */
export function markPrivate<T>(value: T): Private<T> {
  return { [PRIVATE]: value };
}

/** The guard consumers branch on instead of a parallel "redacted" flag. */
export function isPrivate(value: unknown): value is Private<unknown> {
  return typeof value === "object" && value !== null && PRIVATE in value;
}
