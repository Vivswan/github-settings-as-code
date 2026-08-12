/** Shared SectionContext factory for the per-section handler tests. */

import type { ApplySectionContext, SectionContext } from "../../src/sections/contract/module.js";
import type { MockApi } from "../mock-api.js";

/**
 * The overloads keep literal call sites on their arm: `ctx(api)` is the
 * apply arm (so a test may spread it and override `resolveSecret`), while a
 * computed boolean widens to the whole union.
 */
export function ctx(api: MockApi, check?: false): ApplySectionContext;
export function ctx(api: MockApi, check: true): Extract<SectionContext, { check: true }>;
export function ctx(api: MockApi, check: boolean): SectionContext;
export function ctx(api: MockApi, check = false): SectionContext {
  const repo = { owner: "o", name: "r", slug: "o/r" };
  if (check) {
    return { api, repo, check: true };
  }
  return {
    api,
    repo,
    check: false,
    // The engine's stub posture: apply always carries a resolver, and a
    // test that never declared a secret value must fail loudly if a
    // handler reaches for one. Tests exercising secrets override this.
    resolveSecret: (reference: string): string => {
      throw new Error(
        `BUG: secret reference ${reference} was not resolved up front; the engine resolves every declared secret value before any section runs`,
      );
    },
  };
}
